/**
 * Agent watchdog alert feed (Issue #379).
 *
 * Backs the dashboard's "fleet health" panel: which agents are currently in
 * their heartbeat grace period, what has been evicted, and when. The acceptance
 * criterion is that alerts are *visible*, and a log line alone is not visible to
 * anyone who is not tailing logs.
 *
 * Routes (mounted under /api):
 *   GET /agent-watchdog/alerts    — recent alerts, newest first
 *   GET /agent-watchdog/quarantine — agents currently inside the grace period
 *   POST /agent-watchdog/tick     — force a detection pass (ops/admin use)
 */

import { Router, Request, Response, NextFunction } from "express";
import { createAgentDb, getAgentDb, type AgentDb } from "../../db/agents";
import { createLogger } from "../../utils/logger";
import { adminLimiter } from "../middleware/rateLimit";

const log = createLogger({ component: "agent-watchdog-routes" });

export interface AgentWatchdogRouterOptions {
  /** Run a detection pass on demand. Omitted routes still serve reads. */
  tick?: () => Promise<{ quarantined: number; evicted: number; recovered: number }>;
  db?: AgentDb;
}

export function createAgentWatchdogRouter(options: AgentWatchdogRouterOptions = {}): Router {
  const router = Router();
  const getDb = (): AgentDb => options.db ?? createAgentDb(getAgentDb());

  /**
   * @openapi
   * /api/agent-watchdog/alerts:
   *   get:
   *     summary: List agent watchdog alerts (Issue #379)
   *     operationId: listAgentWatchdogAlerts
   *     description: >
   *       Recent heartbeat-liveness alerts, newest first. `unresolvedOnly=true`
   *       (the dashboard default) hides alerts that have already been resolved.
   *     tags: [Agents]
   *     security: []
   *     parameters:
   *       - in: query
   *         name: unresolvedOnly
   *         schema: { type: boolean, default: false }
   *         description: Only return alerts that have not been resolved
   *       - in: query
   *         name: limit
   *         schema: { type: integer, minimum: 1, maximum: 200, default: 50 }
   *       - in: query
   *         name: agentId
   *         schema: { type: string }
   *         description: Filter alerts to a single agent
   *     responses:
   *       200:
   *         description: Paginated watchdog alerts
   *         content:
   *           application/json:
   *             schema:
   *               type: object
   *               properties:
   *                 data:
   *                   type: array
   *                   items: { type: object }
   *                 _meta: { type: object }
   */
  router.get("/alerts", (req: Request, res: Response, next: NextFunction): void => {
    try {
      const db = getDb();
      const limit = clampLimit(req.query.limit, 50, 200);
      const unresolvedOnly = req.query.unresolvedOnly === "true";
      const agentId = typeof req.query.agentId === "string" ? req.query.agentId : undefined;

      const alerts = db.listAlerts({ limit, agentId, unresolvedOnly });

      res.json({
        data: alerts,
        _meta: {
          version: "2.0",
          timestamp: new Date().toISOString(),
          count: alerts.length,
        },
      });
    } catch (err) {
      next(err);
    }
  });

  /**
   * @openapi
   * /api/agent-watchdog/quarantine:
   *   get:
   *     summary: List currently-quarantined agents (Issue #379)
   *     operationId: listAgentWatchdogQuarantine
   *     description: >
   *       Agents that missed a heartbeat but are still inside the grace period
   *       — the "unavailable but not yet evicted" set.
   *     tags: [Agents]
   *     security: []
   *     responses:
   *       200:
   *         description: Quarantined agents with silence duration
   *         content:
   *           application/json:
   *             schema:
   *               type: object
   *               properties:
   *                 data:
   *                   type: array
   *                   items: { type: object }
   *                 _meta: { type: object }
   */
  router.get("/quarantine", (_req: Request, res: Response, next: NextFunction): void => {
    try {
      const db = getDb();
      const now = Date.now();
      const quarantined = db.listStaleAgents().map((agent) => {
        const staleSinceMs = db.getStaleSince(agent.id);
        const lastSeenMs = Date.parse(agent.lastSeenAt);
        return {
          agentId: agent.id,
          capabilities: agent.capabilities,
          endpoint: agent.endpoint,
          lastSeenAt: agent.lastSeenAt,
          silentForMs: Number.isFinite(lastSeenMs) ? now - lastSeenMs : null,
          quarantinedSince:
            staleSinceMs !== null ? new Date(staleSinceMs).toISOString() : null,
          reputationScore: agent.reputationScore,
        };
      });

      res.json({
        data: quarantined,
        _meta: { version: "2.0", timestamp: new Date().toISOString(), count: quarantined.length },
      });
    } catch (err) {
      next(err);
    }
  });

  /**
   * @openapi
   * /api/agent-watchdog/tick:
   *   post:
   *     summary: Force an agent watchdog detection pass (Issue #379)
   *     operationId: tickAgentWatchdog
   *     description: >
   *       Runs a detection pass immediately instead of waiting for the next
   *       scheduled interval. Performs deletes, so it is rate-limited at the
   *       admin tier. Returns 501 when the watchdog tick is not wired.
   *     tags: [Agents]
   *     security: []
   *     responses:
   *       200:
   *         description: Tick result with quarantined, evicted and recovered counts
   *         content:
   *           application/json:
   *             schema:
   *               type: object
   *               properties:
   *                 data:
   *                   type: object
   *                   properties:
   *                     quarantined: { type: integer }
   *                     evicted: { type: integer }
   *                     recovered: { type: integer }
   *                 _meta: { type: object }
   *       501:
   *         description: Watchdog tick is not wired in this deployment
   */
  router.post("/tick", adminLimiter.middleware, (_req: Request, res: Response, next: NextFunction): void => {
    if (!options.tick) {
      res.status(501).json({
        error: { code: "NOT_IMPLEMENTED", message: "watchdog tick is not wired" },
      });
      return;
    }

    options.tick()
      .then((stats) => {
        log.info(stats, "agent watchdog tick (manual)");
        res.json({ data: stats, _meta: { version: "2.0", timestamp: new Date().toISOString() } });
      })
      .catch(next);
  });

  return router;
}

function clampLimit(raw: unknown, fallback: number, max: number): number {
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(Math.floor(parsed), max);
}
