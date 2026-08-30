import { Router, Request, Response } from "express";
import { getConfig } from "../../config";
import { adminAuthMiddleware } from "../middleware/auth";
import { metricsService } from "../../services/metrics";
import { tracingService } from "../../services/tracing";

const router = Router();

let startTime = Date.now();

/**
 * @openapi
 * /health:
 *   get:
 *     summary: Basic liveness check
 *     operationId: getLiveness
 *     description: Returns immediately with process uptime and version info. Does not check external dependencies — use /health/deep for that.
 *     tags: [Health]
 *     security: []
 *     responses:
 *       200:
 *         description: Service is up
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 status:
 *                   type: string
 *                   enum: [ok]
 *                 uptime:
 *                   type: number
 *                   description: Seconds since process start
 *                 version:
 *                   type: string
 *                 stellarNetwork:
 *                   type: string
 */
function livenessHandler(_req: Request, res: Response): void {
  const config = getConfig();
  res.json({
    status: "ok",
    uptime: Math.floor((Date.now() - startTime) / 1000),
    version: config.NPM_PACKAGE_VERSION,
    stellarNetwork: config.STELLAR_NETWORK,
  });
}

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
 *     summary: Deep health check
 *     operationId: getDeepHealth
 *     description: >
 *       Checks reachability of external dependencies (Venice AI and Stellar
 *       Horizon) with a 5 second timeout each. Always returns 200 —
 *       individual dependency failures are reported in the response body,
 *       not via HTTP status.
 *     tags: [Health]
 *     security: []
 *     responses:
 *       200:
 *         description: Dependency status report
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 venice:
 *                   type: string
 *                   enum: [ok, unreachable]
 *                 horizon:
 *                   type: string
 *                   enum: [ok, unreachable]
 */
router.get("/deep", async (_req: Request, res: Response) => {
  const config = getConfig();
  const horizonUrl = config.STELLAR_HORIZON_URL;
  const timeoutMs = config.HEALTH_PROBE_TIMEOUT_MS;

  const [veniceStatus, horizonStatus] = await Promise.all([
    checkVenice(config.VENICE_API_KEY, timeoutMs),
    checkHorizon(horizonUrl, timeoutMs),
  ]);

  res.json({
    venice: veniceStatus,
    horizon: horizonStatus,
  });
});

/**
 * @openapi
 * /health/ready:
 *   get:
 *     summary: Readiness probe
 *     operationId: getReadiness
 *     description: >
 *       Verifies every dependency the backend needs to actually serve
 *       traffic: the task/payment/job-queue SQLite databases, the Venice AI
 *       and Stellar Horizon providers, and (if attached) the WebSocket
 *       stream server. Provider probes time out after
 *       `HEALTH_PROBE_TIMEOUT_MS` (default 5s, configurable via env).
 *       Returns 200 when ready to serve traffic, 500 otherwise. A missing
 *       WebSocket probe is reported as "unknown" (valid — the stream layer
 *       may not be attached) and does not by itself fail readiness; every
 *       other dependency being unavailable does.
 *     tags: [Health]
 *     security: []
 *     responses:
 *       200:
 *         description: Subsystems are healthy and ready
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ReadinessStatus'
 *             example:
 *               status: "ok"
 *               checks:
 *                 tasks: "ok"
 *                 payments: "ok"
 *                 queue: "ok"
 *                 venice: "ok"
 *                 horizon: "ok"
 *                 websocket: "ok"
 *       500:
 *         description: One or more subsystems failed readiness checks
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ReadinessStatus'
 *             example:
 *               status: "error"
 *               checks:
 *                 tasks: "ok"
 *                 payments: "error"
 *                 queue: "ok"
 *                 venice: "ok"
 *                 horizon: "ok"
 *                 websocket: "unknown"
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
      const taskDb = (tasksModule.getTaskDb as Function)();
      taskDb.prepare("SELECT 1").get();
    } catch (error) {
      (checks as any).tasks = "error";
    } finally {
      (tasksModule.closeTaskDb as Function)();
    }

    try {
      const paymentDb = (paymentsModule.getDb as Function)();
      paymentDb.prepare("SELECT 1").get();
    } catch (error) {
      (checks as any).payments = "error";
    } finally {
      (paymentsModule.closeDb as Function)();
    }

    try {
      const jobDb = (queueModule.getJobDb as Function)();
      jobDb.prepare("SELECT 1").get();
    } catch (error) {
      (checks as any).queue = "error";
    } finally {
      (queueModule.closeJobDb as Function)();
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
 *     summary: Comprehensive health and metrics dashboard
 *     operationId: getHealthDashboard
 *     description: >
 *       Returns a full system snapshot: HTTP traffic analytics (rate, average /
 *       p95 / p99 latency, error rate), dependency reachability (SQLite,
 *       Venice AI, Stellar Horizon, WebSocket), process health (memory, CPU,
 *       uptime, garbage collection), and domain counters for agents, tasks and
 *       payments.
 *
 *
 *       The snapshot is cached for `METRICS_CACHE_TTL_MS` (default 5 seconds);
 *       `cacheAgeMs` reports how stale the served copy is. Pass `?refresh=true`
 *       to bypass the cache.
 *
 *
 *       Requires the admin API key via `X-Admin-API-Key` or
 *       `Authorization: Bearer`. Responds 503 when `ADMIN_API_KEY` is unset.
 *     tags: [Health]
 *     parameters:
 *       - in: query
 *         name: refresh
 *         required: false
 *         schema:
 *           type: string
 *           enum: ["true", "false"]
 *         description: Bypass the metrics cache and collect a fresh snapshot.
 *     responses:
 *       200:
 *         description: Dashboard snapshot
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 status:
 *                   type: string
 *                   enum: [healthy, degraded, unhealthy]
 *                 timestamp:
 *                   type: string
 *                   format: date-time
 *                 cacheAgeMs:
 *                   type: number
 *                 requests:
 *                   type: object
 *                 dependencies:
 *                   type: object
 *                 system:
 *                   type: object
 *                 agents:
 *                   type: object
 *                 tasks:
 *                   type: object
 *                 payments:
 *                   type: object
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
 * /health/traces/{correlationId}:
 *   get:
 *     summary: Retrieve distributed trace by correlation ID
 *     operationId: getTrace
 *     description: >
 *       Returns the in-memory trace for the given correlation ID, including all
 *       recorded spans with their timestamps, durations, and statuses.
 *       Returns 404 when no spans have been recorded for the ID.
 *     tags: [Health]
 *     security: []
 *     parameters:
 *       - in: path
 *         name: correlationId
 *         required: true
 *         schema:
 *           type: string
 *         description: The UUID v4 correlation ID propagated via X-Correlation-ID header
 *     responses:
 *       200:
 *         description: Trace found
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 correlationId:
 *                   type: string
 *                 spans:
 *                   type: array
 *                 startedAt:
 *                   type: string
 *                 endedAt:
 *                   type: string
 *                 totalDurationMs:
 *                   type: number
 *       404:
 *         description: No trace found for the given correlation ID
 */
router.get("/traces/:correlationId", (req: Request, res: Response) => {
  const trace = tracingService.getTrace(req.params.correlationId);
  if (!trace) {
    res.status(404).json({ error: "Trace not found", correlationId: req.params.correlationId });
    return;
  }
  res.json(trace);
});

async function checkVenice(apiKey: string, timeoutMs = 5000): Promise<"ok" | "unreachable"> {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    const res = await fetch("https://api.venice.ai/api/v1/models", {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: ctrl.signal,
    });
    clearTimeout(t);
    return res.ok ? "ok" : "unreachable";
  } catch {
    return "unreachable";
  }
}

async function checkHorizon(url: string, timeoutMs = 5000): Promise<"ok" | "unreachable"> {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    const res = await fetch(url, { signal: ctrl.signal });
    clearTimeout(t);
    return res.ok ? "ok" : "unreachable";
  } catch {
    return "unreachable";
  }
}

export { router as healthRouter };
