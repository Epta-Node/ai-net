import { Router, Request, Response, type RequestHandler } from "express";
import { getConfig } from "../../config";
import { adminAuthMiddleware } from "../middleware/auth";
import { metricsService } from "../../services/metrics";
import { tracingService } from "../../services/tracing";
import { getAllCircuitBreakerStatuses } from "../../services/circuitBreaker.js";
import { readMigrationStatus } from "../../db/migrations/status";
import { runDeepHealthCheck, queueDepthOf } from "../../services/deepHealth";

const router = Router();
const startTime = Date.now();

/** Pass-through cache wrapper (placeholder for production cache layer). */
function cachedRoute(_group: string): RequestHandler {
  return (_req, _res, next) => next();
}

const livenessHandler: RequestHandler = (_req: Request, res: Response) => {
  const config = getConfig();
  res.json({
    status: "ok",
    uptime: Math.floor((Date.now() - startTime) / 1000),
    version: config.NPM_PACKAGE_VERSION,
    stellarNetwork: config.STELLAR_NETWORK,
  });
};

/**
 * @openapi
 * /health:
 *   get:
 *     summary: Liveness and process metadata
 *     operationId: getHealth
 *     description: Process-only liveness probe reporting uptime, build version and the configured Stellar network. Performs no dependency checks.
 *     tags: [Health]
 *     security: []
 *     responses:
 *       200:
 *         description: Service is up
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/HealthStatus'
 */
router.get("/", livenessHandler);

/**
 * @openapi
 * /health/live:
 *   get:
 *     summary: Basic liveness check
 *     operationId: getLive
 *     description: Alias for `GET /health` — process-only liveness, no dependency checks.
 *     tags: [Health]
 *     security: []
 *     responses:
 *       200:
 *         description: Service is up
 */
router.get("/live", livenessHandler);

/**
 * @openapi
 * /health/deep:
 *   get:
 *     summary: Dependency health check
 *     operationId: getDeepHealth
 *     description: >
 *       Probes every upstream the service needs to do useful work and reports
 *       per-dependency `status`, `critical`, `latencyMs` and `detail`:
 *       Venice AI (circuit-breaker state, last success, reachability), Stellar
 *       Horizon (reachability, breaker state), the task database (a
 *       non-persisting write check, skipped in read-only mode) and the job
 *       queue (depth against `HEALTH_QUEUE_DEPTH_WARN`). Answers 503 when a
 *       critical dependency fails, and 200 with `status: degraded` when only
 *       non-critical checks are unhealthy. Use this for readiness/traffic
 *       gating; use `/health/live` for container liveness.
 *     tags: [Health]
 *     security: []
 *     responses:
 *       200:
 *         description: All critical dependencies healthy (status `ok` or `degraded`)
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/DeepHealthStatus'
 *       503:
 *         description: At least one critical dependency is failing
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/DeepHealthStatus'
 */
router.get("/deep", cachedRoute("health"), async (_req: Request, res: Response) => {
  const config = getConfig();
  const report = await runDeepHealthCheck({
    veniceApiKey: config.VENICE_API_KEY,
    horizonUrl: config.STELLAR_HORIZON_URL,
    timeoutMs: config.HEALTH_PROBE_TIMEOUT_MS,
    queueDepthWarn: config.HEALTH_QUEUE_DEPTH_WARN,
  });

  const legacy = (name: "venice" | "horizon") =>
    report.dependencies[name].status === "fail" ? "unreachable" : "ok";

  res.status(report.status === "fail" ? 503 : 200).json({
    ...report,
    // Flat summary fields from the original probe, kept for existing consumers.
    services: { venice: legacy("venice"), horizon: legacy("horizon") },
    venice: legacy("venice"),
    horizon: legacy("horizon"),
  });
});

/**
 * @openapi
 * /health/queue:
 *   get:
 *     summary: Job queue depth
 *     operationId: getQueueHealth
 *     description: Queue depth (pending + failed), active jobs and dead-letter count.
 *     tags: [Health]
 *     security: []
 *     responses:
 *       200:
 *         description: Queue statistics
 *       500:
 *         description: Queue statistics could not be read
 */
router.get("/queue", async (_req: Request, res: Response) => {
  try {
    const { getJobDb, createJobStore } = await import("../../queue/jobStore.js");
    const stats = createJobStore(getJobDb()).getStats();
    res.json({
      queueDepth: queueDepthOf(stats),
      activeJobs: stats.active,
      deadLetterCount: stats.deadLetter,
    });
  } catch (error) {
    res.status(500).json({ error: "Failed to read queue stats", message: String(error) });
  }
});

/**
 * @openapi
 * /health/ready:
 *   get:
 *     summary: Readiness check
 *     operationId: getReadiness
 *     description: >
 *       Verifies the task, payment and job-queue databases, the Venice AI and
 *       Horizon dependencies, and the WebSocket listener. Returns 500 when any
 *       check reports `error`. A WebSocket probe of `unknown` does not fail
 *       readiness, because the stream layer is optional.
 *     tags: [Health]
 *     security: []
 *     responses:
 *       200:
 *         description: All checks passed
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ReadinessStatus'
 *       500:
 *         description: One or more checks failed
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ReadinessStatus'
 */
router.get("/ready", async (_req: Request, res: Response) => {
  const checks: Record<string, "ok" | "error" | "unknown"> = {
    tasks: "ok",
    payments: "ok",
    queue: "ok",
    venice: "ok",
    horizon: "ok",
    websocket: "ok",
  };

  try {
    const tasksModule = await import("../../db/tasks.js");
    const paymentsModule = await import("../../db/index.js");
    const queueModule = await import("../../queue/jobStore.js");

    try {
      const taskDb = (tasksModule.getTaskDb)();
      taskDb.prepare("SELECT 1").get();
    } catch {
      checks.tasks = "error";
    }

    try {
      const paymentDb = (paymentsModule.getDb)();
      paymentDb.prepare("SELECT 1").get();
    } catch {
      checks.payments = "error";
    }

    try {
      const jobDb = (queueModule.getJobDb)();
      jobDb.prepare("SELECT 1").get();
    } catch {
      checks.queue = "error";
    }
  } catch (error) {
    res.status(500).json({ status: "error", checks, error: String(error) });
    return;
  }

  const config = getConfig();
  const timeoutMs = config.HEALTH_PROBE_TIMEOUT_MS;
  const [veniceStatus, horizonStatus] = await Promise.all([
    checkVenice(config.VENICE_API_KEY, timeoutMs),
    checkHorizon(config.STELLAR_HORIZON_URL, timeoutMs),
  ]);
  checks.venice = veniceStatus === "ok" ? "ok" : "error";
  checks.horizon = horizonStatus === "ok" ? "ok" : "error";

  const websocketStatus = metricsService.getWebSocketStatus();
  checks.websocket =
    websocketStatus.status === "unknown"
      ? "unknown"
      : websocketStatus.status === "ok"
        ? "ok"
        : "error";

  // A missing WebSocket probe ("unknown") is a valid configuration — the
  // stream layer may simply not be attached — so it alone does not fail
  // readiness. A probe that *is* attached and reports "error" (not
  // listening) does, same as every other dependency.
  const failing = Object.values(checks).filter((status) => status === "error");
  const ready = failing.length === 0;
  res.status(ready ? 200 : 500).json({ status: ready ? "ok" : "error", checks });
});

/**
 * @openapi
 * /health/dashboard:
 *   get:
 *     summary: Operational metrics dashboard
 *     operationId: getHealthDashboard
 *     description: Aggregated operational snapshot (queue depth, latency, WebSocket connections). Pass `?refresh=true` to bypass the cache.
 *     tags: [Health, Admin]
 *     security:
 *       - adminApiKey: []
 *     parameters:
 *       - in: query
 *         name: refresh
 *         schema: { type: string, enum: ["true", "false"] }
 *         description: Set to `true` to bypass the cached snapshot
 *     responses:
 *       200:
 *         description: Dashboard snapshot
 *       401:
 *         description: Missing or invalid admin API key
 *       503:
 *         description: ADMIN_API_KEY is not configured
 */
router.get("/dashboard", adminAuthMiddleware, async (req: Request, res: Response) => {
  try {
    const dashboard = await metricsService.getDashboard(req.query.refresh === "true");
    res.json(dashboard);
  } catch (error) {
    res.status(500).json({
      status: "unhealthy",
      error: "Failed to collect metrics",
      message: error instanceof Error ? error.message : String(error),
    });
  }
});

/**
 * @openapi
 * /health/traces/{traceId}:
 *   get:
 *     summary: Retrieve a distributed trace
 *     operationId: getHealthTrace
 *     description: Returns the correlated spans recorded for the given traceId.
 *     tags: [Health, Admin]
 *     security:
 *       - adminApiKey: []
 *     parameters:
 *       - in: path
 *         name: traceId
 *         required: true
 *         schema: { type: string }
 *         description: Trace identifier (correlationId)
 *     responses:
 *       200:
 *         description: Trace found
 *       404:
 *         description: Trace not found
 *       401:
 *         description: Missing or invalid admin API key
 *       503:
 *         description: ADMIN_API_KEY is not configured
 */
router.get("/traces/:traceId", adminAuthMiddleware, (req: Request, res: Response) => {
  const trace = tracingService.getTrace(req.params.traceId);
  if (!trace) {
    res.status(404).json({
      error: "Trace not found",
      traceId: req.params.traceId,
      correlationId: req.params.traceId,
    });
    return;
  }
  res.json(trace);
});

async function checkVenice(apiKey: string, timeoutMs = 5000): Promise<"ok" | "unreachable"> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    const response = await fetch("https://api.venice.ai/api/v1/models", {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: controller.signal,
    });
    clearTimeout(timeout);
    return response.ok || response.status === 401 ? "ok" : "unreachable";
  } catch {
    return "unreachable";
  }
}

async function checkHorizon(url: string, timeoutMs = 5000): Promise<"ok" | "unreachable"> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    const response = await fetch(url, { signal: controller.signal });
    clearTimeout(timeout);
    return response.ok ? "ok" : "unreachable";
  } catch {
    return "unreachable";
  }
}

/**
 * @openapi
 * /health/circuit-breakers:
 *   get:
 *     summary: Circuit breaker status for all external services
 *     operationId: getCircuitBreakers
 *     description: Returns the current state of every registered circuit breaker (Venice AI, Stellar Horizon).
 *     tags: [Health]
 *     security: []
 *     responses:
 *       200:
 *         description: Circuit breaker statuses
 */
router.get("/circuit-breakers", (_req: Request, res: Response) => {
  const breakers = getAllCircuitBreakerStatuses();
  const anyOpen = breakers.some((b) => b.state === 'OPEN');
  res.status(anyOpen ? 503 : 200).json({
    status: anyOpen ? 'degraded' : 'ok',
    circuitBreakers: breakers,
  });
});

/**
 * `GET /migrations` — schema migration status (Issue #274).
 *
 * Reports the `schema_migrations` bookkeeping table joined against the migration
 * files on disk: which versions are applied, which are pending, the current
 * version, and any applied migration that has drifted. SQL bodies are never
 * returned.
 *
 * Guarded by the admin key because it enumerates the deployment's schema files.
 * Like every admin route it fails closed with 503 when `ADMIN_API_KEY` is unset.
 */
const migrationsRouter = Router();

/**
 * @openapi
 * /migrations:
 *   get:
 *     summary: Database migration status
 *     operationId: getMigrationStatus
 *     description: >
 *       Reports version tracking for the versioned SQLite migrations: every
 *       migration file with its applied/pending state, the current and latest
 *       version, and any applied migration that has drifted (edited after being
 *       applied, or missing from disk). SQL bodies are not returned. Backed by
 *       the `schema_migrations` bookkeeping table.
 *     tags: [Health, Admin]
 *     security:
 *       - adminApiKey: []
 *     responses:
 *       200:
 *         description: Migration status
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/MigrationStatus'
 *       401:
 *         description: Missing or invalid admin API key
 *       500:
 *         description: Migration status could not be read
 *       503:
 *         description: ADMIN_API_KEY is not configured
 */
migrationsRouter.get(
  "/",
  adminAuthMiddleware,
  (_req: Request, res: Response) => {
    try {
      res.json(readMigrationStatus());
    } catch (error) {
      res.status(500).json({
        error: "Failed to read migration status",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  },
);

export { router as healthRouter, migrationsRouter };
export default router;
