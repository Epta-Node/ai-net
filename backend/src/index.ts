/**
 * ai-net backend server entry point.
 *
 * Initializes all agents and starts the HTTP/WebSocket server.
 */

import { createApp } from "./api/app";
import { initializeAgents } from "./agents";
import { startAgentSync } from "./registry/sync";
import { loadConfig, getConfig } from "./config";
import { createLogger } from "./utils/logger";

const log = createLogger({ module: 'server' });

async function main() {
  // ── Validate env config at startup ──────────────────────────────────────────
  loadConfig();
  const config = getConfig();

  log.info("Starting server...");

  try {
    // Start agent sync
    startAgentSync();

    // Initialize all agents and register them
    log.info("Initializing agents...");
    await initializeAgents();

    // Create and start the server
    const { httpServer } = createApp();

    const port = config.PORT;

    httpServer.listen(port, () => {
      log.info(
        {
          port,
          url: `http://localhost:${port}`,
          endpoints: [
            "GET  /health                     - Health check",
            "GET  /health/deep                - Deep health check",
            "POST /api/tasks                  - Submit new tasks",
            "GET  /api/tasks/:id              - Get task status",
            "WS   /tasks/:id/stream            - Stream task events",
            "POST /api/agents/register        - Register new agents",
            "GET  /api/agents                 - List all agents",
            "GET  /api/agents/capability/:type - Find agents by capability"
          ]
        },
        "Server running"
      );
    });

    // ── Graceful shutdown ──────────────────────────────────────────────────────
    const shutdown = (signal: string) => {
      log.info({ signal }, "Received shutdown signal, shutting down gracefully...");
      
      const timeout = setTimeout(() => {
        log.error("Forced shutdown after 10s timeout");
        process.exit(1);
      }, 10_000);

      httpServer.close(() => {
        clearTimeout(timeout);
        log.info("Server closed successfully.");
        process.exit(0);
      });
    };

    process.on("SIGTERM", () => shutdown("SIGTERM"));
    process.on("SIGINT", () => shutdown("SIGINT"));

  } catch (error) {
    log.error({ error }, "Failed to start server");
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}
