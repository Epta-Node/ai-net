import { Router, Request, Response } from "express";
import { getConfig } from "../../config";
import { adminAuthMiddleware } from "../middleware/auth";
import { metricsService } from "../../services/metrics";
import { tracingService } from "../../services/tracing";

const router = Router();
const startTime = Date.now();

function cachedRoute(group: "health"): RequestHandler {
  let middleware: RequestHandler | null = null;
  return (req, res, next) => {
    if (!middleware) {
      middleware = cacheMiddleware({ ttl: ttlForRoute(group) });
    }
    return middleware(req, res, next);
  };
}

router.get("/", cachedRoute("health"), (_req: Request, res: Response) => {
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

router.get("/deep", cachedRoute("health"), async (_req: Request, res: Response) => {
  const config = getConfig();
  const [veniceStatus, horizonStatus] = await Promise.all([
    checkVenice(config.VENICE_API_KEY),
    checkHorizon(config.STELLAR_HORIZON_URL),
  ]);

  const allOk = veniceStatus === "ok" && horizonStatus === "ok";
  res.status(allOk ? 200 : 503).json({
    status: allOk ? "ok" : "degraded",
    services: {
      venice: veniceStatus,
      horizon: horizonStatus,
    },
    venice: veniceStatus,
    horizon: horizonStatus,
  });
});

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
    } catch {
      checks.tasks = "error";
    } finally {
      (tasksModule.closeTaskDb as Function)();
    }

    try {
      const paymentDb = (paymentsModule.getDb as Function)();
      paymentDb.prepare("SELECT 1").get();
    } catch {
      checks.payments = "error";
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

router.get("/traces/:traceId", (req: Request, res: Response) => {
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
    const timeout = setTimeout(() => controller.abort(), 5_000);
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
    const timeout = setTimeout(() => controller.abort(), 5_000);
    const response = await fetch(url, { signal: controller.signal });
    clearTimeout(timeout);
    return response.ok ? "ok" : "unreachable";
  } catch {
    return "unreachable";
  }
}

export { router as healthRouter };
export default router;
