/**
 * Express application factory.
 *
 * Wires up middleware, routes, the WebSocket task stream, background
 * services (job queue/worker, heartbeat cleanup, metrics), and the global
 * error handler. Called by tests (`opts.disableCompression`, custom
 * dispatch/queue, etc.) and by the server entry-point (`src/index.ts`).
 */

import express, { Request, Response, NextFunction, Router } from "express";
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
import { createTaskDb, getTaskDb } from "../db/tasks";
import { createPaymentReleaseFn, type StellarReleasePaymentFn } from "../payment";
import { getGlobalJobQueue, JobWorker, type JobQueue } from "../queue";
import { createHeartbeatService, type HeartbeatServiceOptions } from "../services/heartbeat";
import { metricsMiddleware, metricsService } from "../services/metrics";
import { getEventStore } from "../events/eventStore";
import type { EventStore } from "../events/eventStore";
import {
  attachTaskStream,
  getStreamConnectionCount,
  type TaskStreamOptions,
} from "./routes/stream";
import { TaskStreamHub } from "./routes/taskStreamHub";
import { createTaskEventsSseHandler } from "./routes/taskEventsSse";
import type { DAGNode } from "../types/task";
import { agentsRouter } from "./routes/agents";
import { healthRouter, migrationsRouter } from "./routes/health";
import { metricsRouter } from "./routes/metrics";
import { createStatsRouter } from "./routes/stats";
import { createReconciliationRouter, type ReconciliationRouterOptions } from "./routes/reconciliation";
import { rateLimitMiddleware, registerRateLimitMiddleware, publicLimiter, authedLimiter, adminLimiter } from "./middleware/rateLimit";
import { adminAuthMiddleware } from "./middleware/auth";
import { createCorsMiddleware } from "./middleware/cors";
import { compressionMiddleware } from "./middleware/compression";
import { errorHandler } from "./middleware/errorHandler";
import { readOnlyMiddleware } from "./middleware/readOnly";
import { requestId } from "./middleware/requestId";
import { requestLogger } from "./middleware/requestLogger";
import { versioningMiddleware } from "./middleware/versioning";
import { getOpenapiJson, getOpenapiYaml, openapiSpec, swaggerUiOptions } from "./docs";
import { createCostRouter } from "./routes/costs";
import { createAgentWatchdogRouter } from "./routes/agentWatchdog";
import { createAgentWatchdog } from "../services/agentWatchdog";
import { invalidateAgentsCache } from "../cache/invalidation";
import { flushActiveCosts, setPricingOverrides } from "../services/budget";
import { createAdminRouter, createAdminQueueRouter } from "./routes/admin";
import { createFlagsRouter } from "./routes/flags";
import { createRateLimitRouter } from "./routes/ratelimit";
import { createVersionsRouter } from "./routes/versions";
import { createV1TasksRouter } from "./routes/v1/tasks";
import { createV2TasksRouter } from "./routes/v2/tasks";
import { createAuthRouter } from "./routes/auth";
import { type AuthService } from "../services/auth";
import { createLogger } from "../utils/logger";
import { ValidationError, UnauthorizedError, NotFoundError, AppError } from "../errors";
import { getConfig } from "../config";
import type { AgentRegistry } from "../types/agent";

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
   * How long close() waits before the worker logs that jobs remain active.
   * Default: 10000 (10s). The server and database connections stay open until
   * those jobs finish so their final task/event writes are not interrupted.
   */
  jobWorkerStopTimeoutMs?: number;
}

function tryLoadStellarRelease(): StellarReleasePaymentFn | undefined {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires
    return require("../../../smart-contracts/src/payment/payment")
      .releasePayment as StellarReleasePaymentFn;
  } catch {
    return undefined;
  }
}

/**
 * Reconcile a watchdog eviction against the agent registry (Issue #379).
 *
 * Read-only on purpose. `deregister_agent` is a `require_auth`'d on-chain
 * mutation, and silently issuing it from a heartbeat timer would both bypass the
 * contract's authorization model and remove a registration without an operator
 * having chosen to. So this only *detects* divergence — an agent the watchdog
 * just dropped locally that is still present in the registry — and reports it
 * through the eviction alert as `deregisterRequired`, leaving the actual
 * deregistration to an authorized operator or job.
 */
function tryLoadRegistryLookup():
  | { getAgent: (id: string) => unknown }
  | undefined {
  if (!getConfig().REGISTRY_CONTRACT_ID) return undefined;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires
    return require("../../../smart-contracts/src/registry/registry") as {
      getAgent: (id: string) => unknown;
    };
  } catch {
    return undefined;
  }
}

/**
 * Route descriptor for endpoints that live behind an `API-Version` dispatcher.
 *
 * The task endpoints dispatch on the negotiated `API-Version` header, so they
 * live behind a dispatcher function and cannot be recovered by walking the
 * Express router stack. They are published here so route-introspection tooling
 * (the OpenAPI parity test) can see the same routers the server dispatches to,
 * instead of re-deriving the mount path and re-instantiating the factories.
 */
export interface VersionDispatchedRoutes {
  /** Path the dispatching middleware is mounted at. */
  mountPath: string;
  /** Every router the dispatcher can route to, for the given mount path. */
  routers: Router[];
}

export function createApp(opts: AppOptions = {}): {
  httpServer: HttpServer;
  close: (callback?: () => void) => void;
  versionDispatchedRoutes: VersionDispatchedRoutes;
} {
  const config = getConfig();
  const logger = createLogger({ module: "api-app" });
  const app = express();
  const httpServer = createServer(app);
  const eventStore = opts.eventStore ?? getEventStore();

  app.set("trust proxy", config.TRUST_PROXY);
  const trustProxy = app.get("trust proxy fn");

  app.use(express.json());
  app.use((_req, res, next) => {
    if (config.NODE_ENV === "production") {
      res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains; preload");
    }
    next();
  });
  // Pass `app` so `Access-Control-Allow-Methods` is derived from the routes
  // that actually get registered below, rather than a hand-maintained list
  // (issue #659). The derivation is per-request, so the mount order here is
  // fine.
  app.use(createCorsMiddleware(app));
  app.use(requestId);
  app.use(requestLogger);
  app.use(metricsMiddleware);
  // Rate limiting is an edge concern: the limiter itself is covered directly by
  // its unit suite, so the app-level mount is skipped under NODE_ENV=test (the
  // same convention compression uses below) — otherwise integration suites
  // throttle their own second request and assert against a 429.
  if (config.NODE_ENV !== "test") {
    app.use(rateLimitMiddleware);
  }
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
  jobQueue.setDefaultMaxAttempts(config.JOB_MAX_ATTEMPTS);
  const jobWorker =
    opts.jobWorker ??
    new JobWorker({
      jobStore: jobQueue.getStore(),
      handler: createTaskJobHandler(dispatch, releasePayment),
      // Leases (#648): a claimed job stays owned for JOB_LEASE_TTL_MS unless
      // this worker renews it every JOB_LEASE_HEARTBEAT_MS. Startup recovery
      // only reclaims jobs whose lease has lapsed, so a second instance coming
      // up alongside this one cannot re-queue work that is still running.
      leaseTtlMs: config.JOB_LEASE_TTL_MS,
      leaseHeartbeatMs: config.JOB_LEASE_HEARTBEAT_MS,
      // Retry policy (#752): full-jitter backoff, then the dead-letter queue.
      baseBackoffMs: config.JOB_BACKOFF_BASE_MS,
      maxBackoffMs: config.JOB_BACKOFF_MAX_MS,
      maxAttempts: config.JOB_MAX_ATTEMPTS,
    });
  jobQueue.setWorker(jobWorker);

  if (opts.enableQueueWorker !== false) {
    jobWorker.start();
  }

  // The watchdog owns liveness detection from here on, so the heartbeat
  // service's own stale→offline sweep is disabled: it would flip an agent
  // offline on a shorter timer, without a grace clock or an alert, leaving the
  // agent invisible to the watchdog and unalerted until the 24h delete.
  const heartbeatService = createHeartbeatService({
    ...opts.heartbeatOptions,
    enableMarkStale: false,
  });
  if (
    opts.enableHeartbeatCleanup ||
    (opts.enableHeartbeatCleanup !== false && config.NODE_ENV !== "test")
  ) {
    heartbeatService.start();
  }

  // ── Token budget + cost accounting (Issue #390) ───────────────────────────
  // Install env pricing overrides once, so every ledger and every reprice uses
  // the same rates.
  setPricingOverrides(config.VENICE_PRICING);

  // Flush in-flight costs on a timer. Without this, a crash mid-task loses the
  // spend for every task that never reached a terminal state — which are
  // exactly the runs an operator wants to see.
  const costFlushMs = config.COST_FLUSH_INTERVAL_MS;
  const costFlushTimer =
    config.NODE_ENV === "test"
      ? null
      : setInterval(() => {
          try {
            flushActiveCosts();
          } catch (err) {
            logger.error({ err }, "cost flush failed");
          }
        }, costFlushMs);
  // Do not hold the event loop open on this timer alone.
  costFlushTimer?.unref?.();

  // ── Agent heartbeat watchdog (Issue #379) ─────────────────────────────────
  const registryLookup = tryLoadRegistryLookup();
  const watchdog = createAgentWatchdog({
    intervalMs: config.AGENT_WATCHDOG_INTERVAL_MS,
    gracePeriodMinutes: config.AGENT_WATCHDOG_GRACE_MINUTES,
    // Evicted agents must not be served from cached listings (#804).
    invalidateCache: () => invalidateAgentsCache(),
    onEvict: registryLookup
      ? async (agent) => {
          const stillRegistered = registryLookup.getAgent(agent.id) !== undefined;
          logger.warn(
            {
              agentId: agent.id,
              stillRegistered,
              deregisterRequired: stillRegistered,
            },
            "agent evicted locally but still present in the registry; authorized deregistration required",
          );
        }
      : undefined,
  });
  if (config.NODE_ENV !== "test") {
    watchdog.start();
  }

  // ── Health routes ───────────────────────────────────────────────────────────
  app.use("/health", publicLimiter.middleware, healthRouter);

  // Schema migration status (Issue #274). Admin-guarded and rate limited like
  // the other operational endpoints rather than the public health probes.
  app.use("/migrations", adminLimiter.middleware, migrationsRouter);

  // ── Metrics routes (Issue #499) ───────────────────────────────────────────
  app.use("/metrics", metricsRouter);
  app.use("/api/metrics", metricsRouter);

  // ── Stats routes ───────────────────────────────────────────────────────────
  app.use("/api/stats", publicLimiter.middleware, createStatsRouter(getTaskDb()));

  // Cost routes (Issue #390): /api/costs (operator rollup) and
  // /api/tasks/:id/cost (wallet-scoped, ownership-checked in the handler).
  // Mounted before the task router so the cost path is matched first; the two
  // do not actually collide, because the task router's `/:id` matches a single
  // path segment and `/:id/cost` is two.
  app.use("/api", publicLimiter.middleware, createCostRouter());

  // ── Auth routes ────────────────────────────────────────────────────────────
  app.use("/api/auth", createAuthRouter(opts.authService));

  // ── Agent routes ───────────────────────────────────────────────────────────
  // Public reads use the public limiter; registration uses the stricter
  // per-legacy register limiter (kept for backward compatibility).
  app.use("/api/agents", publicLimiter.middleware);
  app.post("/api/agents/register", registerRateLimitMiddleware);
  app.use("/api/agents", agentsRouter);

  // ── Agent watchdog alerts (Issue #379) ─────────────────────────────────────
  app.use(
    "/api/agent-watchdog",
    publicLimiter.middleware,
    createAgentWatchdogRouter({ tick: () => watchdog.tick() }),
  );

  /**
   * @openapi
   * /openapi.json:
   *   get:
   *     summary: Machine-readable OpenAPI specification (JSON)
   *     operationId: getOpenapiJson
   *     description: >
   *       Serves the same OpenAPI 3.1.0 document that backs /api-docs, in
   *       JSON form, for codegen and client tooling. Public: the spec is not
   *       operational data, so it opts out of the spec-wide WalletAuth default.
   *     tags: [System]
   *     security: []
   *     responses:
   *       200:
   *         description: OpenAPI 3.1.0 specification
   *         content:
   *           application/json:
   *             schema:
   *               type: object
   */
  app.get("/openapi.json", (_req: Request, res: Response) => {
    res.json(getOpenapiJson());
  });

  /**
   * @openapi
   * /openapi.yaml:
   *   get:
   *     summary: Machine-readable OpenAPI specification (YAML)
   *     operationId: getOpenapiYaml
   *     description: >
   *       The OpenAPI 3.1.0 document in YAML form. Semantically equivalent to
   *       `GET /openapi.json`. Public: opts out of the spec-wide WalletAuth default.
   *     tags: [System]
   *     security: []
   *     responses:
   *       200:
   *         description: OpenAPI 3.1.0 specification (YAML)
   *         content:
   *           text/yaml:
   *             schema:
   *               type: string
   */
  app.get("/openapi.yaml", (_req: Request, res: Response) => {
    res.type("text/yaml").send(getOpenapiYaml());
  });

  app.use("/api-docs", swaggerUi.serve, swaggerUi.setup(getOpenapiJson(), swaggerUiOptions));

  // ── Task routes ────────────────────────────────────────────────────────────
  // Authenticated task creation uses the tighter authed limiter.
  const v1TasksRouter = createV1TasksRouter(dispatch, releasePayment, jobQueue);
  const v2TasksRouter = createV2TasksRouter(dispatch, releasePayment, jobQueue);

  // SSE task event stream (#751). Shares one TaskStreamHub with the WebSocket
  // stream so both transports use a single bus subscription and bounded read
  // per task. Mounted ahead of the versioned dispatcher below.
  const taskStreamHub = new TaskStreamHub({ store: eventStore, bus: eventBus });
  app.get(
    "/api/tasks/:id/events/stream",
    authedLimiter.middleware,
    createTaskEventsSseHandler({ hub: taskStreamHub })
  );

  // The v1/v2 implementation is picked from the negotiated API version, so the
  // mount is a dispatcher function rather than a sub-router. That would make the
  // task routes invisible to router-walking tooling, so both implementations
  // are published on the returned handle for the OpenAPI parity test to
  // introspect. Semantics are unchanged: 1.x → v1, everything else → v2.
  app.use("/api/tasks", authedLimiter.middleware, (req, res, next) => {
    const apiVersion = res.locals.apiVersion || "1.0";
    if (apiVersion.startsWith("1.")) {
      return v1TasksRouter(req, res, next);
    }
    return v2TasksRouter(req, res, next);
  });

  // ── Admin Queue routes ─────────────────────────────────────────────────────
  app.use("/api/admin/queue", adminLimiter.middleware, createAdminQueueRouter(jobQueue));
  app.use(
    "/api/admin",
    adminLimiter.middleware,
    createAdminRouter({ queue: jobQueue, reconciliation: opts.reconciliation, watchdog }),
  );

  // ── Feature-flag admin routes (#425) ───────────────────────────────────────
  app.use("/api/admin/flags", createFlagsRouter());

  // ── Rate limit status endpoint ─────────────────────────────────────────────
  app.use("/api/ratelimit", adminAuthMiddleware, createRateLimitRouter());

  // ── Versioning lifecycle endpoint (#426) ───────────────────────────────────
  app.use("/api/versions", createVersionsRouter());

  // ── Payment reconciliation routes ──────────────────────────────────────────
  app.use("/api/reconciliation", createReconciliationRouter(opts.reconciliation));

  app.use((req: Request, res: Response) => {
    const correlationId =
      (res.locals.traceId as string | undefined) ??
      (res.locals.correlationId as string | undefined) ??
      "unknown";
    res.status(404).json({
      error: {
        code: "NOT_FOUND",
        message: "Not found",
        path: req.path,
        correlationId,
        timestamp: new Date().toISOString(),
      },
      statusCode: 404,
      path: req.path,
      requestId: res.locals.requestId ?? "unknown",
    });
  });

  app.use(errorHandler);

  const detachStream = attachTaskStream({
    httpServer,
    eventStore,
    eventBus,
    getTask,
    trustProxy,
    streamHub: taskStreamHub,
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
    // Stop new claims, then keep database handles available until active jobs settle.
    const drainWorker = async () => {
      await jobWorker.stop(opts.jobWorkerStopTimeoutMs ?? 10_000);
      while (jobWorker.getActiveCount() > 0) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    };
    drainWorker().finally(() => {
      heartbeatService.stop();
      // Stop the watchdog before the server goes away, and clear the cost flush
      // timer last so any final in-flight spend still gets written.
      watchdog.stop();
      metricsService.setWebSocketProbe(null);
      detachStream();
      if (httpServer.listening) {
        httpServer.close(callback);
      } else if (callback) {
        callback();
      }
      if (costFlushTimer) {
        clearInterval(costFlushTimer);
        try {
          flushActiveCosts();
        } catch (err) {
          logger.error({ err }, "final cost flush failed");
        }
      }
    });
  }

  const routeCount = (app as unknown as { _router?: { stack?: unknown[] } })._router?.stack?.length;
  logger.debug({ routeCount }, "api app initialized");
  return {
    httpServer,
    close,
    versionDispatchedRoutes: {
      mountPath: "/api/tasks",
      routers: [v1TasksRouter, v2TasksRouter],
    },
  };
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