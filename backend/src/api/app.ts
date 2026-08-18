import express, { Request, Response, NextFunction } from "express";
import { createServer, Server as HttpServer } from "http";
import { randomUUID } from "crypto";
import swaggerUi from "swagger-ui-express";

import {
  type DispatchFn,
  type PaymentReleaseFn,
} from "../coordinator/coordinator";
import { httpDispatch } from "../coordinator/dispatch";
import type { AgentRegistry } from "../types/agent";
import { getTask } from "../coordinator/taskStore";
import { eventBus } from "../coordinator/eventBus";
import { createEventStore, type EventStore } from "../coordinator/eventStore";
import { attachTaskStream, type TaskStreamOptions } from "./routes/stream";
import type { DAGNode } from "../types/task";
import {
  createPaymentReleaseFn,
  type StellarReleasePaymentFn,
} from "../payment";
import { agentsRouter } from "./routes/agents";
import { healthRouter } from "./routes/health";
import { createStatsRouter } from "./routes/stats";
import { createTasksRouter } from "./routes/tasks";
import { rateLimitMiddleware, registerRateLimitMiddleware } from "./middleware/rateLimit";
import { authMiddleware } from "./middleware/auth";
import { createCorsMiddleware } from "./middleware/cors";
import { requestId } from "./middleware/requestId";
import { requestLogger } from "./middleware/requestLogger";
import { errorHandler } from "./middleware/errorHandler";
import { createLogger } from "../utils/logger";
import { createTaskDb, getTaskDb } from "../db/tasks";
import { createHeartbeatService, type HeartbeatServiceOptions } from "../services/heartbeat";
import { openapiSpec } from "./docs/openapi";

export interface AppOptions {
  /** Called to execute a single DAG node; defaults to HTTP dispatch via agent registry */
  dispatch?: DispatchFn;
  /** Called after each node completes; defaults to no-op (returns 'mock-hash') */
  releasePayment?: PaymentReleaseFn;
  /** Event log for stream replay; defaults to an in-memory SQLite store */
  eventStore?: EventStore;
  /** Heartbeat / auth timing for the WebSocket stream */
  stream?: TaskStreamOptions;
  /**
   * Agent registry used to resolve endpoint URLs for HTTP dispatch.
   * Required when `dispatch` is not provided; ignored when `dispatch` is set.
   */
  agentRegistry?: AgentRegistry;
  /** Enable background heartbeat cleanup service (defaults to true in non-test envs) */
  enableHeartbeatCleanup?: boolean;
  /** Custom options for heartbeat cleanup service */
  heartbeatOptions?: HeartbeatServiceOptions;
}

/**
 * Attempt to load smart-contracts releasePayment at runtime via dynamic require.
 * Returns undefined when the module is unavailable (e.g. backend CI without
 * smart-contracts compiled). Using require() instead of a static import keeps
 * TypeScript's rootDir constraint intact.
 */
function tryLoadStellarRelease(): StellarReleasePaymentFn | undefined {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require("../../../smart-contracts/src/payment/payment")
      .releasePayment as StellarReleasePaymentFn;
  } catch {
    return undefined;
  }
}

export function createApp(opts: AppOptions = {}): {
  httpServer: HttpServer;
  close: (callback?: () => void) => void;
} {
  const app = express();
  app.use(express.json());
  // ── Global middleware ────────────────────────────────────────────────────────
  app.use((_req, res, next) => {
    if (process.env.NODE_ENV === "production") {
      res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains; preload");
    }
    next();
  });
  app.use(createCorsMiddleware());
  app.use(requestId);
  app.use(requestLogger);

  const dispatch: DispatchFn = opts.dispatch ?? makeHttpDispatch(opts.agentRegistry);
  const releasePayment: PaymentReleaseFn =
    opts.releasePayment ?? createPaymentReleaseFn(tryLoadStellarRelease());

  // ── Heartbeat Background Cleanup Service ────────────────────────────────────
  const heartbeatService = createHeartbeatService(opts.heartbeatOptions);
  if (opts.enableHeartbeatCleanup || (opts.enableHeartbeatCleanup !== false && process.env.NODE_ENV !== "test")) {
    heartbeatService.start();
  }

  // ── Health routes ───────────────────────────────────────────────────────────
  app.use("/health", healthRouter);

  // ── Stats routes ───────────────────────────────────────────────────────────
  app.use("/api/stats", createStatsRouter(getTaskDb()));

  // ── Agent routes ───────────────────────────────────────────────────────────
  // Apply a stricter rate limit specifically to the register endpoint to
  // prevent registration floods (the full agentsRouter handles GET/DELETE etc.).
  app.post("/api/agents/register", registerRateLimitMiddleware);
  app.use("/api/agents", agentsRouter);

  // ── API docs ─────────────────────────────────────────────────────────────────
  app.use("/docs", swaggerUi.serve, swaggerUi.setup(openapiSpec));
  app.get("/openapi.json", (_req: Request, res: Response) => {
    res.json(openapiSpec);
  });

  // ── Task routes ────────────────────────────────────────────────────────────
  app.use("/api/tasks", createTasksRouter(dispatch, releasePayment));

  // ── HTTP server ────────────────────────────────────────────────────────────
  const httpServer = createServer(app);

  // ── Event persistence ──────────────────────────────────────────────────────
  // Record every Coordinator event (with its EventBus-assigned per-task seq) so
  // a (re)connecting client can replay history before live streaming begins —
  // either the full history, or only events past a `?lastEventId` cursor.
  const eventStore = opts.eventStore ?? createEventStore();
  const stopRecording = eventBus.subscribeAll((event) =>
    eventStore.append(event),
  );

  // ── WebSocket: /tasks/:id/stream ───────────────────────────────────────────
  const detachStream = attachTaskStream({
    httpServer,
    eventStore,
    eventBus,
    getTask,
    ...opts.stream,
  });

  // ── Error handler (must be last) ───────────────────────────────────────────
  app.use(errorHandler);

  function close(callback?: () => void): void {
    heartbeatService.stop();
    detachStream();
    stopRecording();
    eventStore.close();
    httpServer.close(callback);
  }

  return { httpServer, close };
}


/**
 * Build a DispatchFn that looks up the cheapest agent for a node's type in the
 * provided registry and forwards the call to that agent via HTTP.
 *
 * If no registry is provided (e.g. during tests that supply their own dispatch)
 * the returned function throws a clear error so misconfiguration is obvious at
 * runtime rather than producing a silent no-op.
 */
function makeHttpDispatch(registry?: AgentRegistry): DispatchFn {
  return async (taskId: string, node: DAGNode, context: string): Promise<unknown> => {
    if (!registry) {
      throw new Error(
        `No agent registry configured. Provide agentRegistry in AppOptions or supply a custom dispatch function.`,
      );
    }

    const agents = await registry.getAgents(node.type);
    if (!agents || agents.length === 0) {
      throw new Error(`No agent registered for type: ${node.type}`);
    }

    // Pick cheapest available agent.
    const agent = [...agents].sort((a, b) => a.cost - b.cost)[0];
    return httpDispatch(agent, node.nodeId, node, context);
  };
}
