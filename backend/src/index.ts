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
import { closeErrorDb } from "./db/errorRegistry";
import { closeTaskDb, getTaskDb, createTaskDb } from "./db/tasks";
import { closeJobDb } from "./queue";
import { closeEventStore, getEventStore } from "./events/eventStore";
import { createDefaultReconciliationService, closeReconciliationDb } from "./services/reconciliation";
import { DbMaintenanceService, defaultMaintenanceDatabases } from "./services/dbMaintenance";
import { ErrorRegistryMaintenanceService } from "./services/errorRegistryMaintenance";
import { EventRetentionService } from "./services/eventRetention";
import { runDefaultEventColdArchive } from "./events/eventColdArchive";
import { createLogger } from "./utils/logger";
import { redactedConfigSnapshot } from "./config";
import { runStartupMigrations } from "./db/migrations/startup";
import { getDefaultIdempotencyStore, resetDefaultIdempotencyStore } from "./services/idempotency";

async function main() {
  const logger = createLogger({ module: "server" });

  try {
    // ── Validate env config at startup ──────────────────────────────────────────
    const config = loadConfig();
    logger.info({ config: redactedConfigSnapshot(config) }, "starting server");

    // ── Bring the schema up to date (Issue #274) ────────────────────────────────
    // Runs before anything opens a database or accepts a request, so the process
    // never serves traffic against a schema it is out of step with. A failing or
    // drifted migration throws and aborts startup below. Set AUTO_MIGRATE=false to
    // run the schema as an explicit `npm run db:migrate` deploy step instead.
    if (config.AUTO_MIGRATE) {
      const migrations = runStartupMigrations();
      logger.info(
        {
          database: migrations.database,
          currentVersion: migrations.currentVersion,
          changed: migrations.changed,
        },
        "database schema ready",
      );
    } else {
      logger.info("AUTO_MIGRATE is disabled — skipping startup database migrations");
    }

    // Start agent sync
    startAgentSync();

    // Initialize all agents and register them
    logger.info("initializing agents");
    await initializeAgents();

    // Start agent cleanup service
    const cleanupService = new AgentCleanupService();
    cleanupService.start();

    // Start payment reconciliation. Issue #496 raises the default cadence from
    // once a day to every RECONCILIATION_INTERVAL_MS (60 s) so on-chain/off-chain
    // payment drift is detected and remediated within a minute rather than being
    // found at the end of the day.
    const reconciliationService = createDefaultReconciliationService();
    reconciliationService.start(config.RECONCILIATION_INTERVAL_MS);

    // Start idempotency key cleanup so the idempotency_keys table stays
    // bounded in production (Issue #657).  The store is initialised here with
    // the validated config so it uses the correct file-backed database and
    // honours IDEMPOTENCY_TTL_MS / IDEMPOTENCY_CLEANUP_MS from the env.
    const idempotencyStore = getDefaultIdempotencyStore(config);
    idempotencyStore.startCleanup();

    // Start SQLite maintenance (WAL checkpoint, vacuum, backup)
    const maintenanceService = new DbMaintenanceService(defaultMaintenanceDatabases(), {
      intervalMs: config.DB_MAINTENANCE_INTERVAL_MS,
      vacuumThreshold: config.DB_MAINTENANCE_VACUUM_THRESHOLD,
      backupDir: config.DB_BACKUP_DIR,
      backupRetentionCount: config.DB_BACKUP_RETENTION_COUNT,
      auditLogRetentionDays: config.AUDIT_LOG_RETENTION_DAYS,
      // Daily 02:00 UTC move of aged event archive rows to cold files (#809).
      runColdArchive: runDefaultEventColdArchive,
    });
    maintenanceService.start();

    // Start error-registry maintenance (expiry sweep + per-agent cap)
    const errorRegistryMaintenance = new ErrorRegistryMaintenanceService({
      intervalMs: config.ERROR_REGISTRY_MAINTENANCE_INTERVAL_MS,
      capPerAgent: config.ERROR_REGISTRY_CAP_PER_AGENT,
    });
    errorRegistryMaintenance.start();

    // Open the file-backed event store and start event retention/compaction
    // so the live task_events table stays bounded (issue #383).
    const eventStore = getEventStore();
    const eventRetention = new EventRetentionService({
      eventStore,
      intervalMs: config.EVENT_COMPACTION_INTERVAL_MS,
      retentionDays: config.EVENT_RETENTION_DAYS,
      batchTasks: config.EVENT_COMPACTION_BATCH_TASKS,
      enabled: config.EVENT_COMPACTION_ENABLED,
    });
    eventRetention.start();

    // Create and start the server
    const { httpServer, close } = createApp({
      eventStore,
      jobWorkerStopTimeoutMs: config.GRACEFUL_SHUTDOWN_TIMEOUT * 1000,
    });

    const port = config.PORT;

    httpServer.listen(port, () => {
      logger.info({ port, env: config.NODE_ENV }, "server listening");
    });

    // ── Graceful shutdown ──────────────────────────────────────────────────────
    setupGracefulShutdown(httpServer, close, config, {
      cleanupService,
      reconciliationService,
      maintenanceService,
      errorRegistryMaintenance,
        eventRetention,
      globalAgentRegistry,
      idempotencyStore,
    });

  } catch (error) {
    logger.error({ err: error }, "failed to start server");
    process.exit(1);
  }
}

export interface GracefulShutdownExtras {
  cleanupService?: { stop(): void | Promise<void> };
  reconciliationService?: { stop(): void | Promise<void> };
  maintenanceService?: { stop(): void | Promise<void> };
  errorRegistryMaintenance?: { stop(): void | Promise<void> };
  eventRetention?: { stop(): void | Promise<void> };
  globalAgentRegistry?: { shutdown(): void };
  idempotencyStore?: { stopCleanup(): void; close(): void };
}
/**
 * SIGTERM/SIGINT handler: stop accepting new work, drain in-flight jobs and
 * the WebSocket stream, flush the event store, close every database
 * connection, then exit. Exceeding `config.GRACEFUL_SHUTDOWN_TIMEOUT` marks
 * the shutdown as timed out, but does not bypass active writes or DB closure.
 *
 * In-flight tasks are drained (via `closeApp`, which awaits the job
 * worker's stop()) rather than force-failed, keeping the pool available for
 * final task/event writes before shutdown closes it.
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
    let timedOut = false;
    let shutdownFailed = false;
    const forcedTimeout = setTimeout(() => {
      timedOut = true;
      logger.error({ signal, timeoutSeconds: timeoutDuration / 1000 }, "shutdown exceeded its timeout; waiting for active work to settle");
    }, timeoutDuration);

    try {
      logger.info("closing http/ws server");
      await new Promise<void>((resolve) => {
        closeApp(() => {
          logger.info("http/ws server closed");
          resolve();
        });
      });
    } catch (error) {
      shutdownFailed = true;
      logger.error({ err: error }, "error while draining http/ws server");
    }

    logger.info("stopping background services");
    const stopResults = await Promise.allSettled([
      Promise.resolve().then(() => stopAgentSync()),
      Promise.resolve().then(() => extras.cleanupService?.stop()),
      Promise.resolve().then(() => extras.reconciliationService?.stop()),
      Promise.resolve().then(() => extras.maintenanceService?.stop()),
      Promise.resolve().then(() => extras.errorRegistryMaintenance?.stop()),
      Promise.resolve().then(() => extras.eventRetention?.stop()),
      Promise.resolve().then(() => extras.globalAgentRegistry?.shutdown()),
      Promise.resolve().then(() => extras.idempotencyStore?.stopCleanup()),
    ]);
    for (const result of stopResults) {
      if (result.status === "rejected") {
        shutdownFailed = true;
        logger.error({ err: result.reason }, "background service failed to stop");
      }
    }

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
    const closeResults = await Promise.allSettled([
      closeDb(),
      closeAgentDb(),
      closeTaskDb(),
      closeJobDb(),
      closeAuthDb(),
      closeErrorDb(),
      closeEventStore(),
    ]);
    for (const result of closeResults) {
      if (result.status === "rejected") {
        shutdownFailed = true;
        logger.error({ err: result.reason }, "database failed to close cleanly");
      }
    }
    resetDefaultIdempotencyStore();

    logger.info({ signal }, "graceful shutdown complete");
    clearTimeout(forcedTimeout);
    process.exit(shutdownFailed || timedOut ? 1 : 0);
  };

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));

  return shutdown;
}

if (require.main === module) {
  main();
}
