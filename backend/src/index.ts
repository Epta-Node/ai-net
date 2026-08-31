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
import { createTaskDb, getTaskDb, closeTaskDb } from "./db/tasks";
import { createAgentDb, getAgentDb, closeAgentDb } from "./db/agents";
import { closeDb } from "./db/index";
import { closeAuthDb } from "./db/auth";
import { closeJobDb } from "./queue";
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
    const { httpServer, close } = createApp();

    const port = config.PORT;

    httpServer.listen(port, () => {
      console.log(`[ai-net-backend] Server running on http://localhost:${port}`);
      console.log("[ai-net-backend] Available endpoints:");
      console.log("  - GET  /health                    - Health check");
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
    const shutdown = (signal: string) => {
      console.log(`[ai-net-backend] Received ${signal}, shutting down gracefully...`);
      const timeout = setTimeout(() => {
        console.error("[ai-net-backend] Forced shutdown after 10s timeout");
        process.exit(1);
      }, 10_000);

      cleanupService.stop();
      reconciliationService.stop();
      globalAgentRegistry.shutdown();
      stopAgentSync();

      httpServer.close(() => {
        clearTimeout(timeout);
        console.log("[ai-net-backend] Server closed.");
        process.exit(0);
      });
    };

    process.on("SIGTERM", () => shutdown("SIGTERM"));
    process.on("SIGINT", () => shutdown("SIGINT"));

  } catch (error) {
    console.error("[ai-net-backend] Failed to start server:", error);
    process.exit(1);
  }
}

export function setupGracefulShutdown(
  httpServer: any,
  closeApp: (callback?: () => void) => void,
  config: { GRACEFUL_SHUTDOWN_TIMEOUT?: number }
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
      console.log("[ai-net-backend] Phase 1: Closing HTTP/WS server and stopping new connections...");
      await new Promise<void>((resolve) => {
        closeApp(() => {
          console.log("[ai-net-backend] HTTP/WS server successfully closed.");
          resolve();
        });
      });

      console.log("[ai-net-backend] Phase 2: Stopping agent sync service...");
      stopAgentSync();

      console.log("[ai-net-backend] Phase 3: Failing all running tasks...");
      try {
        const taskDb = createTaskDb(getTaskDb());
        taskDb.failRunningTasks();
      } catch (err) {
        console.error("[ai-net-backend] Failed to mark tasks as failed during shutdown:", err);
      }

      console.log("[ai-net-backend] Phase 4: Marking all online agents as offline...");
      try {
        const agentDb = createAgentDb(getAgentDb());
        agentDb.markAllOffline();
      } catch (err) {
        console.error("[ai-net-backend] Failed to mark agents offline during shutdown:", err);
      }

      console.log("[ai-net-backend] Phase 5: Closing database connections...");
      closeDb();
      closeAgentDb();
      closeTaskDb();
      closeJobDb();
      closeAuthDb();

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
