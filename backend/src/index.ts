/**
 * ai-net backend server entry point.
 *
 * Initializes all agents and starts the HTTP/WebSocket server.
 */

import { createApp } from "./api/app";
import { initializeAgents, globalAgentRegistry } from "./agents";
import { startAgentSync, stopAgentSync } from "./registry/sync";
import { loadConfig } from "./config";
import { AgentCleanupService } from "./services/agentCleanup";
import { createAgentDb, getAgentDb, closeAgentDb } from "./db/agents";
import { closeDb } from "./db/index";
import { closeAuthDb } from "./db/auth";
import { closeJobDb } from "./queue";
import { eventBus } from "./coordinator/eventBus";
import { createDefaultReconciliationService } from "./services/reconciliation";
import { createLogger } from "./utils/logger";
import { redactedConfigSnapshot } from "./config";

async function main() {
  const logger = createLogger({ module: "server" });

  try {
    // ── Validate env config at startup ──────────────────────────────────────────
    const config = loadConfig();
    logger.info({ config: redactedConfigSnapshot(config) }, "starting server");

    // Start agent sync
    startAgentSync();

    // Initialize all agents and register them
    logger.info("initializing agents");
    await initializeAgents();

    // Start agent cleanup service
    const cleanupService = new AgentCleanupService();
    cleanupService.start();

    // Start daily payment reconciliation
    const reconciliationService = createDefaultReconciliationService();
    reconciliationService.startDaily(config.RECONCILIATION_INTERVAL_MS);

    // Start SQLite maintenance (WAL checkpoint, vacuum, backup)
    const maintenanceService = new DbMaintenanceService(defaultMaintenanceDatabases(), {
      intervalMs: config.DB_MAINTENANCE_INTERVAL_MS,
      vacuumThreshold: config.DB_MAINTENANCE_VACUUM_THRESHOLD,
      backupDir: config.DB_BACKUP_DIR,
      backupRetentionCount: config.DB_BACKUP_RETENTION_COUNT,
    });
    maintenanceService.start();

    // Start error-registry maintenance (expiry sweep + per-agent cap)
    const errorRegistryMaintenance = new ErrorRegistryMaintenanceService({
      intervalMs: config.ERROR_REGISTRY_MAINTENANCE_INTERVAL_MS,
      capPerAgent: config.ERROR_REGISTRY_CAP_PER_AGENT,
    });
    errorRegistryMaintenance.start();

    // Create and start the server
    const { httpServer, close } = createApp({
      jobWorkerStopTimeoutMs: config.GRACEFUL_SHUTDOWN_TIMEOUT * 1000,
    });

    const port = config.PORT;

    httpServer.listen(port, () => {
      logger.info({ port, env: config.NODE_ENV }, "server listening");
    });

    // ── Graceful shutdown ──────────────────────────────────────────────────────
    const shutdown = (signal: string) => {
      logger.info({ signal }, "received shutdown signal");
      const timeout = setTimeout(() => {
        logger.error({ signal }, "forced shutdown after timeout");
        process.exit(1);
      }, 10_000);

      cleanupService.stop();
      reconciliationService.stop();
      maintenanceService.stop();
      errorRegistryMaintenance.stop();
      globalAgentRegistry.shutdown();
      stopAgentSync();

      httpServer.close(() => {
        clearTimeout(timeout);
        logger.info({ signal }, "server closed");
        process.exit(0);
      });
    };

    process.on("SIGTERM", () => shutdown("SIGTERM"));
    process.on("SIGINT", () => shutdown("SIGINT"));

  } catch (error) {
    logger.error({ err: error }, "failed to start server");
    process.exit(1);
  }
}

export interface GracefulShutdownExtras {
  cleanupService?: { stop(): void };
  reconciliationService?: { stop(): void };
  globalAgentRegistry?: { shutdown(): void };
}

/**
 * SIGTERM/SIGINT handler: stop accepting new work, drain in-flight jobs and
 * the WebSocket stream, flush the event store, close every database
 * connection, then exit 0 — or force-exit 1 if any of that takes longer
 * than `config.GRACEFUL_SHUTDOWN_TIMEOUT` seconds.
 *
 * In-flight tasks are drained (via `closeApp`, which awaits the job
 * worker's stop()) rather than force-failed: anything still running when
 * the drain window elapses stays "active" in the job store and is resumed
 * by the next `JobWorker.start()` (`recoverIncompleteJobs()` resets it to
 * "pending" for retry) — see `docs/e2e-testing.md` and
 * `tests/shutdown.test.ts` for the restart-mid-stream scenario.
 */
export function setupGracefulShutdown(
  httpServer: any,
  closeApp: (callback?: () => void) => void,
  config: { GRACEFUL_SHUTDOWN_TIMEOUT?: number },
  extras: GracefulShutdownExtras = {},
) {
  const logger = createLogger({ module: "shutdown" });
  let isShuttingDown = false;

  const shutdown = async (signal: string) => {
    if (isShuttingDown) return;
    isShuttingDown = true;

    logger.info({ signal }, "starting graceful shutdown sequence");

    const timeoutDuration = (config.GRACEFUL_SHUTDOWN_TIMEOUT ?? 30) * 1000;
    const forcedTimeout = setTimeout(() => {
      logger.error({ signal, timeoutSeconds: timeoutDuration / 1000 }, "force-killing timed out shutdown");
      process.exit(1);
    }, timeoutDuration);

    try {
      logger.info("closing http/ws server");
      await new Promise<void>((resolve) => {
        closeApp(() => {
          logger.info("http/ws server closed");
          resolve();
        });
      });

      logger.info("stopping agent sync service");
      stopAgentSync();
      extras.cleanupService?.stop();
      extras.reconciliationService?.stop();
      extras.globalAgentRegistry?.shutdown();

      logger.info("failing running tasks");
      try {
        const taskDb = createTaskDb(getTaskDb());
        taskDb.failRunningTasks();
      } catch (err) {
        logger.error({ err }, "failed to mark tasks as failed during shutdown");
      }

      logger.info("marking online agents offline");
      try {
        const agentDb = createAgentDb(getAgentDb());
        agentDb.markAllOffline();
      } catch (err) {
        logger.error({ err }, "failed to mark agents offline during shutdown");
      }

      logger.info("closing database connections");
      closeDb();
      closeAgentDb();
      closeTaskDb();
      closeJobDb();
      closeAuthDb();

      logger.info({ signal }, "graceful shutdown complete");
      clearTimeout(forcedTimeout);
      process.exit(0);
    } catch (error) {
      logger.error({ err: error }, "error during graceful shutdown");
      process.exit(1);
    }
  };

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));

  return shutdown;
}

if (require.main === module) {
  main();
}
