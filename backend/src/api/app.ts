import express, { type Request, type Response } from "express";
import { createServer, type Server as HttpServer } from "http";
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
import type { AgentRegistry } from "../types/agent";
import type { DAGNode } from "../types/task";
import { adminAuthMiddleware } from "./middleware/auth";
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

export interface AppOptions {
  /** Called to execute a single DAG node; defaults to HTTP dispatch via agent registry. */
  dispatch?: DispatchFn;
  /** Called after each node completes; defaults to no-op payment release. */
  releasePayment?: PaymentReleaseFn;
  /** Override the EventStore used for stream replay. */
  eventStore?: EventStore;
  /** Heartbeat / auth timing for the WebSocket stream. */
  stream?: TaskStreamOptions;
  /** Agent registry used to resolve endpoint URLs for HTTP dispatch. */
  agentRegistry?: AgentRegistry;
  /** Enable background heartbeat cleanup service. */
  enableHeartbeatCleanup?: boolean;
  /** Custom options for heartbeat cleanup service. */
  heartbeatOptions?: HeartbeatServiceOptions;
  /** Options for the payment reconciliation router. */
  reconciliation?: ReconciliationRouterOptions;
  /** Disable response compression. Default: false. */
  disableCompression?: boolean;
  /** Custom job queue instance. */
  queue?: JobQueue;
  /** Custom job worker instance. */
  jobWorker?: JobWorker;
  /** Enable background queue worker. Default: true. */
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
  const app = express();

  app.use(express.json());
  app.use((_req, res, next) => {
    if (process.env.NODE_ENV === "production") {
      res.setHeader(
        "Strict-Transport-Security",
        "max-age=31536000; includeSubDomains; preload",
      );
    }
    next();
  });
  app.use(createCorsMiddleware());
  app.use(requestId);
  app.use(requestLogger);
  app.use(metricsMiddleware);
  app.use(versioningMiddleware);
  app.use(
    readOnlyMiddleware({
      exemptPaths: ["/api/admin", "/api/reconciliation"],
    }),
  );

  if (!opts.disableCompression && process.env.NODE_ENV !== "test") {
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
  if (opts.enableHeartbeatCleanup || (opts.enableHeartbeatCleanup !== false && process.env.NODE_ENV !== "test")) {
    heartbeatService.start();
  }

  app.use("/health", healthRouter);
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
    const apiVersion = res.locals.apiVersion || "1.0";
    if (apiVersion.startsWith("1.")) {
      return v1TasksRouter(req, res, next);
    }
    return v2TasksRouter(req, res, next);
  });

  app.use(
    "/api/admin",
    adminAuthMiddleware,
    createAdminRouter({ queue: jobQueue, reconciliation: opts.reconciliation }),
  );
  app.use("/api/reconciliation", adminAuthMiddleware, createReconciliationRouter(opts.reconciliation));

  const httpServer = createServer(app);
  const eventStore = opts.eventStore ?? eventBus.store;
  const detachStream = attachTaskStream({
    httpServer,
    eventStore,
    eventBus,
    getTask,
    ...opts.stream,
  });

  metricsService.startGcObserver();
  metricsService.setWebSocketProbe(() => ({
    listening: httpServer.listening,
    connections: getStreamConnectionCount(),
  }));

  app.use(errorHandler);

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

  return { httpServer, close };
}

function makeHttpDispatch(registry?: AgentRegistry): DispatchFn {
  return async (taskId: string, node: DAGNode, context: string): Promise<unknown> => {
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
