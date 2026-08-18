import { Router, Request, Response } from "express";
import { getConfig } from "../../config";

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
router.get("/", (_req: Request, res: Response) => {
  const config = getConfig();
  res.json({
    status: "ok",
    uptime: Math.floor((Date.now() - startTime) / 1000),
    version: config.NPM_PACKAGE_VERSION,
    stellarNetwork: config.STELLAR_NETWORK,
  });
});

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

  const [veniceStatus, horizonStatus] = await Promise.all([
    checkVenice(config.VENICE_API_KEY),
    checkHorizon(horizonUrl),
  ]);

  res.json({
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
  } catch (error) {
    res.status(500).json({ status: "error", checks, error: String(error) });
    return;
  }

  const allOk = Object.values(checks).every((status) => status === "ok");
  res.status(allOk ? 200 : 500).json({ status: allOk ? "ok" : "error", checks });
});

async function checkVenice(apiKey: string): Promise<"ok" | "unreachable"> {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 5000);
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

async function checkHorizon(url: string): Promise<"ok" | "unreachable"> {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 5000);
    const res = await fetch(url, { signal: ctrl.signal });
    clearTimeout(t);
    return res.ok ? "ok" : "unreachable";
  } catch {
    return "unreachable";
  }
}

export { router as healthRouter };
