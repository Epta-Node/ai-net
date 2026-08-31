import express, { Request, Response, NextFunction } from "express";
import { createServer, Server as HttpServer } from "http";
import swaggerUi from "swagger-ui-express";

import {
  type DispatchFn,
  type PaymentReleaseFn,
} from "../coordinator/coordinator";
import { httpDispatch } from "../coordinator/dispatch";
import type { AgentRegistry } from "../types/agent";
import { getTask } from "../coordinator/taskStore";
import { eventBus } from "../coordinator/eventBus";
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
import { registerRateLimitMiddleware } from "./middleware/rateLimit";
import { createCorsMiddleware } from "./middleware/cors";
import { compressionMiddleware } from "./middleware/compression";
import { requestId } from "./middleware/requestId";
import { requestLogger } from "./middleware/requestLogger";
import { errorHandler } from "./middleware/errorHandler";
import { versioningMiddleware } from "./middleware/versioning";
import { createV1TasksRouter } from "./routes/v1/tasks";
import { createV2TasksRouter } from "./routes/v2/tasks";
import { getTaskDb } from "../db/tasks";
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
import { metricsMiddleware, metricsService } from "../services/metrics";
import { createLogger } from "../utils/logger";
import { getConfig } from "../config";

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
  enableQueueWorker?: boolean;
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
  app.use(versioningMiddleware);

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

  app.use("/health", healthRouter);
  app.use("/api/health", healthRouter);
  app.use("/api/stats", createStatsRouter(getTaskDb()));

  app.post("/api/agents/register", registerRateLimitMiddleware);
  app.use("/api/agents", agentsRouter);

  app.get("/openapi.json", (_req: Request, res: Response) => {
    res.json(getOpenapiJson());
  });
  app.get("/openapi.yaml", (_req: Request, res: Response) => {
    res.setHeader("Content-Type", "text/yaml; charset=utf-8");
    res.send(getOpenapiYaml());
  });
  app.get("/docs/swagger.json", (_req: Request, res: Response) => {
    res.json(getOpenapiJson());
  });
  app.get("/docs/swagger.yaml", (_req: Request, res: Response) => {
    res.setHeader("Content-Type", "text/yaml; charset=utf-8");
    res.send(getOpenapiYaml());
  });
  app.use("/docs", swaggerUi.serve, swaggerUi.setup(openapiSpec, swaggerUiOptions));

  const v1TasksRouter = createV1TasksRouter(dispatch, releasePayment, jobQueue);
  const v2TasksRouter = createV2TasksRouter(dispatch, releasePayment, jobQueue);
  app.use("/api/tasks", (req, res, next) => {
    const apiVersion = res.locals.apiVersion || config.API_DEFAULT_VERSION;
    return apiVersion.startsWith("1.")
      ? v1TasksRouter(req, res, next)
      : v2TasksRouter(req, res, next);
  });

  app.use("/api/admin/queue", createAdminQueueRouter(jobQueue));
  app.use("/api/admin", createAdminQueueRouter(jobQueue));
  app.use("/api/reconciliation", createReconciliationRouter(opts.reconciliation));

  app.use((_req: Request, res: Response) => {
    res.status(404).json({
      error: { message: "Not found", code: "NOT_FOUND" },
      requestId: res.locals.requestId,
      traceId: res.locals.traceId,
    });
  });

  app.use(errorHandler);

  const httpServer = createServer(app);
  const eventStore = opts.eventStore ?? eventBus.store;
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
    jobWorker.stop();
    heartbeatService.stop();
    metricsService.setWebSocketProbe(null);
    detachStream();
    if (httpServer.listening) {
      httpServer.close(callback);
    } else if (callback) {
      callback();
    }
  }

  const routeCount = (app as unknown as { _router?: { stack?: unknown[] } })._router?.stack?.length;
  logger.debug({ routeCount }, "api app initialized");
  return { httpServer, close };
}

function makeHttpDispatch(registry?: AgentRegistry): DispatchFn {
  return async (_taskId: string, node: DAGNode, context: string): Promise<unknown> => {
    if (!registry) {
      throw new Error(
        "No agent registry configured. Provide agentRegistry in AppOptions or supply a custom dispatch function.",
      );
    }

    const agents = await registry.getAgents(node.type);
    if (!agents || agents.length === 0) {
      throw new Error(`No agent registered for type: ${node.type}`);
    }

    const agent = [...agents].sort((a, b) => a.cost - b.cost)[0];
    return httpDispatch(agent, node.nodeId, node, context);
  };
}
