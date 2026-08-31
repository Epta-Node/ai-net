/**
 * Express application factory.
 *
 * Wires up middleware, routes, the WebSocket task stream, background
 * services (job queue/worker, heartbeat cleanup, metrics), and the global
 * error handler. Called by tests (`opts.disableCompression`, custom
 * dispatch/queue, etc.) and by the server entry-point (`src/index.ts`).
 */

import express, { Request, Response, NextFunction } from "express";
import { createServer, Server as HttpServer } from "http";
import swaggerUi from "swagger-ui-express";

import {
  createTaskJobHandler,
  type DispatchFn,
  type PaymentReleaseFn,
} from "../coordinator/coordinator";
import { httpDispatch } from "../coordinator/dispatch";
import { eventBus } from "../coordinator/eventBus";
import { getTask } from "../coordinator/taskStore";
import { getTaskDb } from "../db/tasks";
import { createPaymentReleaseFn, type StellarReleasePaymentFn } from "../payment";
import { getGlobalJobQueue, JobWorker, type JobQueue } from "../queue";
import { createHeartbeatService, type HeartbeatServiceOptions } from "../services/heartbeat";
import { metricsMiddleware, metricsService } from "../services/metrics";
import type { EventStore } from "../events/eventStore";
import {
  attachTaskStream,
  getStreamConnectionCount,
  type TaskStreamOptions,
} from "./routes/stream";
import { metricsMiddleware, metricsService } from "../services/metrics";
import type { DAGNode } from "../types/task";
import {
  createPaymentReleaseFn,
  type StellarReleasePaymentFn,
} from "../payment";
import { agentsRouter } from "./routes/agents";
import { healthRouter } from "./routes/health";
import { createStatsRouter } from "./routes/stats";
import { createReconciliationRouter, type ReconciliationRouterOptions } from "./routes/reconciliation";
import { rateLimitMiddleware, registerRateLimitMiddleware, publicLimiter, authedLimiter, adminLimiter } from "./middleware/rateLimit";
import { authMiddleware } from "./middleware/auth";
import { createCorsMiddleware } from "./middleware/cors";
import { compressionMiddleware } from "./middleware/compression";
import { createCorsMiddleware } from "./middleware/cors";
import { errorHandler } from "./middleware/errorHandler";
import { readOnlyMiddleware } from "./middleware/readOnly";
import { registerRateLimitMiddleware } from "./middleware/rateLimit";
import { requestId } from "./middleware/requestId";
import { requestLogger } from "./middleware/requestLogger";
import { versioningMiddleware } from "./middleware/versioning";
import { getOpenapiJson, getOpenapiYaml, openapiSpec, swaggerUiOptions } from "./docs";
import { agentsRouter } from "./routes/agents";
import { createAdminRouter } from "./routes/admin";
import { healthRouter } from "./routes/health";
import { createReconciliationRouter, type ReconciliationRouterOptions } from "./routes/reconciliation";
import { createStatsRouter } from "./routes/stats";
import { attachTaskStream, getStreamConnectionCount, type TaskStreamOptions } from "./routes/stream";
import { createV1TasksRouter } from "./routes/v1/tasks";
import { createV2TasksRouter } from "./routes/v2/tasks";
import { createAuthRouter } from "./routes/auth";
import { type AuthService } from "../services/auth";
import { createLogger } from "../utils/logger";
import { createTaskDb, getTaskDb } from "../db/tasks";
import { ValidationError, UnauthorizedError, NotFoundError, AppError } from "../errors";
import { createHeartbeatService, type HeartbeatServiceOptions } from "../services/heartbeat";
import { createTaskJobHandler } from "../coordinator/coordinator";
import {
  openapiSpec,
  swaggerUiOptions,
  getOpenapiJson,
  getOpenapiYaml,
} from "./docs";
import {
  getGlobalJobQueue,
  JobWorker,
  type JobQueue,
} from "../queue";
import { createAdminQueueRouter } from "./routes/admin";
import { metricsService, metricsMiddleware } from "../services/metrics";

export interface AppOptions {
  dispatch?: DispatchFn;
  releasePayment?: PaymentReleaseFn;
  eventStore?: EventStore;
  stream?: TaskStreamOptions;
  agentRegistry?: AgentRegistry;
  enableHeartbeatCleanup?: boolean;
  heartbeatOptions?: HeartbeatServiceOptions;
  reconciliation?: ReconciliationRouterOptions;
  disableCompression?: boolean;
  queue?: JobQueue;
  jobWorker?: JobWorker;
  /** Custom auth service instance */
  authService?: AuthService;
  /** Enable background queue worker (default: true) */
  enableQueueWorker?: boolean;
  /**
   * How long close() waits for in-flight jobs to finish before closing the
   * HTTP/WS server anyway. Default: 10000 (10s). A job still running when
   * this elapses is left in the queue's "active" state — the next worker
   * start (see JobWorker.start()/recoverIncompleteJobs()) resets it to
   * "pending" and retries it, rather than losing the work.
   */
  jobWorkerStopTimeoutMs?: number;
}

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
  const config = getConfig();
  const logger = createLogger({ module: "api-app" });
  const app = express();

  app.use(express.json());
  app.use((_req, res, next) => {
    if (config.NODE_ENV === "production") {
      res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains; preload");
    }
    next();
  });
  app.use(createCorsMiddleware());
  app.use(requestId);
  app.use(requestLogger);
  app.use(metricsMiddleware);
  app.use(globalRateLimitMiddleware);
  app.use(versioningMiddleware);
  app.use(
    readOnlyMiddleware({
      exemptPaths: ["/api/admin", "/api/reconciliation"],
    }),
  );

  if (!opts.disableCompression && config.NODE_ENV !== "test") {
    app.use(...compressionMiddleware());
  }

  const dispatch: DispatchFn = opts.dispatch ?? makeHttpDispatch(opts.agentRegistry);
  const releasePayment: PaymentReleaseFn =
    opts.releasePayment ?? createPaymentReleaseFn(tryLoadStellarRelease());

  const jobQueue = opts.queue ?? getGlobalJobQueue();
  const jobWorker =
    opts.jobWorker ??
    new JobWorker({
      jobStore: jobQueue.getStore(),
      handler: createTaskJobHandler(dispatch, releasePayment),
    });
  jobQueue.setWorker(jobWorker);

  if (opts.enableQueueWorker !== false) {
    jobWorker.start();
  }

  const heartbeatService = createHeartbeatService(opts.heartbeatOptions);
  if (
    opts.enableHeartbeatCleanup ||
    (opts.enableHeartbeatCleanup !== false && config.NODE_ENV !== "test")
  ) {
    heartbeatService.start();
  }

  // ── Health routes ───────────────────────────────────────────────────────────
  app.use("/health", publicLimiter.middleware, healthRouter);

  // ── Stats routes ───────────────────────────────────────────────────────────
  app.use("/api/stats", publicLimiter.middleware, createStatsRouter(getTaskDb()));

  // ── Auth routes ────────────────────────────────────────────────────────────
  app.use("/api/auth", createAuthRouter(opts.authService));

  // ── Agent routes ───────────────────────────────────────────────────────────
  // Public reads use the public limiter; registration uses the stricter
  // per-legacy register limiter (kept for backward compatibility).
  app.use("/api/agents", publicLimiter.middleware);
  app.post("/api/agents/register", registerRateLimitMiddleware);
  app.use("/api/agents", agentsRouter);

  app.get("/openapi.json", (_req: Request, res: Response) => {
    res.json(openapiSpec);
  });

  // ── Task routes ────────────────────────────────────────────────────────────
  // Authenticated task creation uses the tighter authed limiter.
  const v1TasksRouter = createV1TasksRouter(dispatch, releasePayment, jobQueue);
  const v2TasksRouter = createV2TasksRouter(dispatch, releasePayment, jobQueue);

  app.use("/api/tasks", authedLimiter.middleware, (req, res, next) => {
    const apiVersion = res.locals.apiVersion || "1.0";
    if (apiVersion.startsWith("1.")) {
      return v1TasksRouter(req, res, next);
    } else {
      return v2TasksRouter(req, res, next);
    }
    return v2TasksRouter(req, res, next);
  });

  // ── Admin Queue routes ─────────────────────────────────────────────────────
  app.use("/api/admin/queue", adminLimiter.middleware, createAdminQueueRouter(jobQueue));
  app.use("/api/admin", adminLimiter.middleware, createAdminQueueRouter(jobQueue));

  // ── Feature-flag admin routes (#425) ───────────────────────────────────────
  app.use("/api/admin/flags", createFlagsRouter());

  // ── Versioning lifecycle endpoint (#426) ───────────────────────────────────
  app.use("/api/versions", createVersionsRouter());

  // ── Payment reconciliation routes ──────────────────────────────────────────
  app.use("/api/reconciliation", createReconciliationRouter(opts.reconciliation));

  app.use((_req: Request, res: Response) => {
    res.status(404).json({
      error: { message: "Not found", code: "NOT_FOUND" },
      requestId: res.locals.requestId,
      traceId: res.locals.traceId,
    });
  });

  app.use(errorHandler);

  const detachStream = attachTaskStream({
    httpServer,
    eventStore,
    eventBus,
    getTask,
    heartbeatIntervalMs: config.WS_HEARTBEAT_INTERVAL_MS,
    pongTimeoutMs: config.WS_PONG_TIMEOUT_MS,
    inactivityTimeoutMs: config.WS_INACTIVITY_TIMEOUT_MS,
    ...opts.stream,
  });

  metricsService.startGcObserver();
  metricsService.setWebSocketProbe(() => ({
    listening: httpServer.listening,
    connections: getStreamConnectionCount(),
  }));

  function close(callback?: () => void): void {
    // Drain first: wait for in-flight jobs to finish (bounded by
    // jobWorkerStopTimeoutMs) before we stop accepting connections. A job
    // still active when the drain window elapses is NOT force-failed — it
    // stays "active" in the store and is picked back up by the next
    // JobWorker.start() via recoverIncompleteJobs().
    jobWorker.stop(opts.jobWorkerStopTimeoutMs ?? 10_000).finally(() => {
      heartbeatService.stop();
      metricsService.setWebSocketProbe(null);
      detachStream();
      if (httpServer.listening) {
        httpServer.close(callback);
      } else if (callback) {
        callback();
      }
    });
  }

  const routeCount = (app as unknown as { _router?: { stack?: unknown[] } })._router?.stack?.length;
  logger.debug({ routeCount }, "api app initialized");
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
  return async (_taskId: string, node: DAGNode, context: string): Promise<unknown> => {
    if (!registry) {
      throw new Error(
        "No agent registry configured. Provide agentRegistry in AppOptions or supply a custom dispatch function.",
      );
    }

    const agents = await registry.getAgents(node.type);
    if (!agents || agents.length === 0) {
      throw new AppError(`No agent registered for type: ${node.type}`, 500, "AGENT_NOT_FOUND");
    }

    const agent = [...agents].sort((a, b) => a.cost - b.cost)[0];
    return httpDispatch(agent, node.nodeId, node, context);
  };
}