/**
 * ai-net backend server entry point.
 *
 * Initializes all agents and starts the HTTP/WebSocket server.
 */

import { createApp } from "./api/app";
import { initializeAgents, globalAgentRegistry } from "./agents";
import { startAgentSync, stopAgentSync } from "./registry/sync";
import { loadConfig, getConfig } from "./config";
import { AgentCleanupService } from "./services/agentCleanup";
import { createAgentDb, getAgentDb, closeAgentDb } from "./db/agents";
import { closeDb } from "./db/index";
import { closeTaskDb } from "./db/tasks";
import { closeJobDb } from "./queue";
import { eventBus } from "./coordinator/eventBus";
import { createDefaultReconciliationService } from "./services/reconciliation";

async function main() {
  // ── Validate env config at startup ──────────────────────────────────────────
  loadConfig();
  const config = getConfig();

  console.log("[ai-net-backend] Starting server...");

  try {
    // Start agent sync
    startAgentSync();

    // Initialize all agents and register them
    console.log("[ai-net-backend] Initializing agents...");
    await initializeAgents();

    // Start agent cleanup service
    const cleanupService = new AgentCleanupService();
    cleanupService.start();

    // Start daily payment reconciliation
    const reconciliationService = createDefaultReconciliationService();
    reconciliationService.startDaily(config.RECONCILIATION_INTERVAL_MS);

    // Create and start the server
    const { httpServer, close } = createApp({
      jobWorkerStopTimeoutMs: config.GRACEFUL_SHUTDOWN_TIMEOUT * 1000,
    });

    const port = config.PORT;

    httpServer.listen(port, () => {
      console.log(`[ai-net-backend] Server running on http://localhost:${port}`);
      console.log("[ai-net-backend] Available endpoints:");
      console.log("  - GET  /health                    - Health check");
      console.log("  - GET  /health/live                - Liveness check");
      console.log("  - GET  /health/ready               - Readiness check (DB, queue, WS, providers)");
      console.log("  - GET  /health/deep               - Deep health check");
      console.log("  - POST /api/tasks                 - Submit new tasks");
      console.log("  - GET  /api/tasks/:id              - Get task status");
      console.log("  - WS   /tasks/:id/stream           - Stream task events");
      console.log("  - POST /api/agents/register        - Register new agents");
      console.log("  - GET  /api/agents                 - List all agents");
      console.log("  - GET  /api/agents/capability/:type - Find agents by capability");
      console.log("  - POST /api/agents/:id/heartbeat    - Agent heartbeat");
      console.log("  - POST /api/reconciliation/run      - Run payment reconciliation");
      console.log("  - GET  /api/reconciliation/report   - Latest reconciliation report");
    });

    // ── Graceful shutdown ──────────────────────────────────────────────────────
    setupGracefulShutdown(httpServer, close, config, {
      cleanupService,
      reconciliationService,
      globalAgentRegistry,
    });
  } catch (error) {
    console.error("[ai-net-backend] Failed to start server:", error);
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
  let isShuttingDown = false;

  const shutdown = async (signal: string) => {
    if (isShuttingDown) return;
    isShuttingDown = true;

    console.log(`[ai-net-backend] Received ${signal}, starting graceful shutdown sequence...`);

    const timeoutDuration = (config.GRACEFUL_SHUTDOWN_TIMEOUT ?? 30) * 1000;
    const forcedTimeout = setTimeout(() => {
      console.error(`[ai-net-backend] Force-killing process: shutdown timed out after ${timeoutDuration / 1000}s`);
      process.exit(1);
    }, timeoutDuration);

    try {
      console.log("[ai-net-backend] Phase 1: Draining in-flight jobs and closing HTTP/WS server...");
      await new Promise<void>((resolve) => {
        closeApp(() => {
          console.log("[ai-net-backend] HTTP/WS server successfully closed.");
          resolve();
        });
      });

      console.log("[ai-net-backend] Phase 2: Stopping background services...");
      stopAgentSync();
      extras.cleanupService?.stop();
      extras.reconciliationService?.stop();
      extras.globalAgentRegistry?.shutdown();

      console.log("[ai-net-backend] Phase 3: Marking all online agents as offline...");
      try {
        const agentDb = createAgentDb(getAgentDb());
        agentDb.markAllOffline();
      } catch (err) {
        console.error("[ai-net-backend] Failed to mark agents offline during shutdown:", err);
      }

      console.log("[ai-net-backend] Phase 4: Flushing event store and closing database connections...");
      try {
        eventBus.store.close();
      } catch (err) {
        console.error("[ai-net-backend] Failed to close event store during shutdown:", err);
      }
      closeDb();
      closeAgentDb();
      closeTaskDb();
      closeJobDb();

      console.log("[ai-net-backend] Graceful shutdown complete. Exiting.");
      clearTimeout(forcedTimeout);
      process.exit(0);
    } catch (error) {
      console.error("[ai-net-backend] Error during graceful shutdown:", error);
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
