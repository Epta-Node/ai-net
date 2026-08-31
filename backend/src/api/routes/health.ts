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
});

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
  const checks: Record<string, "ok" | "error"> = {
    tasks: "ok",
    payments: "ok",
  };

  try {
    const tasksModule = await import("../../db/tasks.js");
    const paymentsModule = await import("../../db/index.js");

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
  } catch (error) {
    res.status(500).json({ status: "error", checks, error: String(error) });
    return;
  }

  const allOk = Object.values(checks).every((status) => status === "ok");
  res.status(allOk ? 200 : 500).json({ status: allOk ? "ok" : "error", checks });
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

async function checkVenice(apiKey: string): Promise<"ok" | "unreachable"> {
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

async function checkHorizon(url: string): Promise<"ok" | "unreachable"> {
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
