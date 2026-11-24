/**
 * Per-task and per-agent cost reporting (Issue #390).
 *
 * The acceptance criterion is a *cost breakdown per task/agent* in the API, so
 * this is a first-class route rather than fields bolted onto the task payload:
 * cost has a different audience (finance/ops) and a different retention
 * concern than task state, and keeping it separate means a wallet can see its
 * task without also seeing platform-wide aggregates.
 *
 * Routes (mounted under /api):
 *   GET /tasks/:id/cost   — one task's snapshot + per-node breakdown
 *   GET /costs            — platform totals, per-agent rollup, recent tasks, and a
 *                           per agent/model/day breakdown filterable with the
 *                           `agentId`, `agentType`, `model` and `day` (YYYY-MM-DD)
 *                           query params (#750)
 *
 * Ownership is enforced the same way as GET /tasks/:id: the caller must present
 * the wallet key that owns the task.
 */

import { Router, Request, Response, NextFunction } from "express";
import { createTaskDb, getTaskDb, type CostBreakdownFilter } from "../../db/tasks";
import { peekLedger, type TaskCostSnapshot } from "../../services/budget";
import { createLogger } from "../../utils/logger";
import { ForbiddenError, NotFoundError, ValidationError } from "../../errors";

const log = createLogger({ component: "cost-routes" });

/** Shape returned for a task's cost, in the v2 `{ data, _meta }` envelope. */
interface TaskCostResponse {
  taskId: string;
  budgetTokens: number;
  usedTokens: number;
  remainingTokens: number;
  costUsd: number;
  currency: string;
  exceeded: boolean;
  calls: number;
  /** True while the task is still running and the snapshot is provisional. */
  inProgress: boolean;
  agents: Array<{
    nodeId: string;
    agentId: string;
    agentType: string;
    model: string;
    calls: number;
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
    costUsd: number;
    trimmed: boolean;
    budgetExhausted: boolean;
  }>;
}

/**
 * Merge a settled snapshot with the live node rows.
 *
 * The snapshot carries the authoritative task totals; `task_token_usage` has the
 * per-node detail the ledger no longer holds in memory. When a task is still
 * running the snapshot is absent, so we fall back to whatever node rows exist —
 * a partial cost view beats a 404 while the task is mid-flight.
 */
function buildTaskCostResponse(
  taskId: string,
  snapshot: TaskCostSnapshot | undefined,
  nodes: ReturnType<ReturnType<typeof createTaskDb>["listNodeUsage"]>
): TaskCostResponse {
  const promptTokens = nodes.reduce((sum, n) => sum + n.promptTokens, 0);
  const completionTokens = nodes.reduce((sum, n) => sum + n.completionTokens, 0);
  const totalTokens = nodes.reduce((sum, n) => sum + n.totalTokens, 0);
  const costUsd = Math.round(nodes.reduce((sum, n) => sum + n.costUsd, 0) * 1e6) / 1e6;
  const calls = nodes.reduce((sum, n) => sum + n.calls, 0);

  return {
    taskId,
    budgetTokens: snapshot?.budgetTokens ?? 0,
    usedTokens: snapshot?.usedTokens ?? totalTokens,
    remainingTokens: snapshot?.remainingTokens ?? Math.max(0, (snapshot?.budgetTokens ?? 0) - totalTokens),
    costUsd: snapshot?.costUsd ?? costUsd,
    currency: snapshot?.currency ?? "USD",
    exceeded: snapshot?.exceeded ?? false,
    calls: snapshot?.calls ?? calls,
    inProgress: snapshot === undefined,
    agents: nodes.map((node) => ({
      nodeId: node.nodeId,
      agentId: node.agentId,
      agentType: node.agentType,
      model: node.model,
      calls: node.calls,
      promptTokens: node.promptTokens,
      completionTokens: node.completionTokens,
      totalTokens: node.totalTokens,
      costUsd: node.costUsd,
      trimmed: node.trimmed,
      budgetExhausted: node.budgetExhausted,
    })),
  };
}

function requireTaskOwnership(req: Request, taskId: string): void {
  const correlationId = (req.res?.locals?.correlationId as string | undefined) ?? undefined;
  const db = createTaskDb(getTaskDb());
  const task = db.findById(taskId);
  if (!task) {
    throw new NotFoundError("Task", taskId, undefined, correlationId);
  }

  const requesterKey = req.headers["walletpublickey"] as string;
  if (!requesterKey || requesterKey !== task.walletPublicKey) {
    throw new ForbiddenError(
      "Access denied",
      { taskId, walletPublicKey: requesterKey },
      correlationId,
    );
  }
}

export function createCostRouter(): Router {
  const router = Router();

  /**
   * @openapi
   * /api/tasks/{id}/cost:
   *   get:
   *     summary: Get one task's cost breakdown (Issue #390)
   *     operationId: getTaskCost
   *     description: >
   *       Budget snapshot plus per-node token/cost breakdown for a single task.
   *       Wallet-scoped: the caller must present the wallet key that owns the
   *       task, enforced identically to `GET /api/tasks/{id}`.
   *     tags: [Tasks]
   *     security:
   *       - WalletAuth: []
   *     parameters:
   *       - in: path
   *         name: id
   *         required: true
   *         schema:
   *           type: string
   *         description: Task identifier
   *         example: "task_ab12cd34ef56"
   *     responses:
   *       200:
   *         description: Task cost snapshot in the v2 `{ data, _meta }` envelope
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/TaskCostResponse'
   *             example:
   *               data:
   *                 taskId: "task_ab12cd34ef56"
   *                 budgetTokens: 10000
   *                 usedTokens: 1550
   *                 remainingTokens: 8450
   *                 costUsd: 0.00155
   *                 currency: "USD"
   *                 exceeded: false
   *                 calls: 2
   *                 inProgress: false
   *                 agents:
   *                   - nodeId: "node_research_1"
   *                     agentId: "agent-1"
   *                     agentType: "research"
   *                     model: "llama-3.3-70b"
   *                     calls: 2
   *                     promptTokens: 1200
   *                     completionTokens: 350
   *                     totalTokens: 1550
   *                     costUsd: 0.00155
   *                     trimmed: false
   *                     budgetExhausted: false
   *               _meta:
   *                 version: "2.0"
   *                 timestamp: "2026-08-25T17:05:00.000Z"
   *                 requestId: "req_c918a245"
   *                 apiVersion: "2.0"
   *       401:
   *         description: Missing or invalid wallet key
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/UnauthorizedError'
   *       403:
   *         description: Wallet key does not own the task
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/ForbiddenError'
   *       404:
   *         description: Task not found
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/NotFoundError'
   */
  router.get("/tasks/:id/cost", (req: Request, res: Response, next: NextFunction): void => {
    try {
      const taskId = req.params.id;
      requireTaskOwnership(req, taskId);

      const db = createTaskDb(getTaskDb());
      const settled = db.getTaskCost(taskId);
      // A running task's authoritative numbers are in the in-memory ledger.
      const live = peekLedger(taskId)?.snapshot();

      // Prefer the live ledger whenever it exists. `task_costs` also holds
      // periodic flushes of *in-flight* tasks, so a row in that table does not
      // imply the task settled — reading it first would pin the reported spend
      // to the last flush and ignore every call made since.
      const snapshot =
        live ??
        (settled
          ? {
              taskId,
              walletPublicKey: settled.walletPublicKey,
              budgetTokens: settled.budgetTokens,
              usedTokens: settled.usedTokens,
              remainingTokens: Math.max(0, settled.budgetTokens - settled.usedTokens),
              costUsd: settled.costUsd,
              currency: settled.currency as "USD",
              exceeded: settled.exceeded,
              calls: settled.calls,
              agents: [],
              createdAt: settled.createdAt,
            }
          : undefined);

      const data = buildTaskCostResponse(taskId, snapshot, db.listNodeUsage(taskId));

      res.json({
        data,
        _meta: {
          version: "2.0",
          timestamp: new Date().toISOString(),
          requestId: res.locals.requestId || null,
          apiVersion: res.locals.apiVersion || "2.0",
        },
      });
    } catch (err) {
      next(err);
    }
  });

  /**
   * @openapi
   * /api/costs:
   *   get:
   *     summary: Platform-wide cost totals, per-agent rollup and breakdown (Issues #390/#750)
   *     operationId: getPlatformCosts
   *     description: >
   *       Operator/finance view: aggregate spend, per-agent rollup, recent task
   *       costs and an agent/model/day breakdown filterable with `agentId`,
   *       `agentType`, `model` and `day` (YYYY-MM-DD). Deliberately not
   *       wallet-scoped.
   *     tags: [Tasks]
   *     security: []
   *     parameters:
   *       - in: query
   *         name: agentLimit
   *         schema:
   *           type: integer
   *           minimum: 1
   *           maximum: 200
   *           default: 50
   *         description: Maximum number of per-agent rows to return
   *       - in: query
   *         name: recentLimit
   *         schema:
   *           type: integer
   *           minimum: 1
   *           maximum: 100
   *           default: 20
   *         description: Maximum number of recent task cost rows to return
   *       - in: query
   *         name: agentId
   *         schema:
   *           type: string
   *         description: Filter breakdown rows by agent ID
   *       - in: query
   *         name: agentType
   *         schema:
   *           type: string
   *         description: Filter breakdown rows by agent type
   *       - in: query
   *         name: model
   *         schema:
   *           type: string
   *         description: Filter breakdown rows by model
   *       - in: query
   *         name: day
   *         schema:
   *           type: string
   *           format: date
   *         description: Filter breakdown to a single day (YYYY-MM-DD)
   *         example: "2026-08-25"
   *       - in: query
   *         name: breakdownLimit
   *         schema:
   *           type: integer
   *           minimum: 1
   *           maximum: 500
   *           default: 100
   *         description: Maximum number of breakdown rows to return
   *     responses:
   *       200:
   *         description: Platform cost totals in the v2 `{ data, _meta }` envelope
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/PlatformCostsResponse'
   *             example:
   *               data:
   *                 totals:
   *                   taskCount: 42
   *                   totalTokens: 125000
   *                   totalCostUsd: 1.2345
   *                   exceededCount: 2
   *                 byAgent:
   *                   - agentId: "agent-1"
   *                     agentType: "research"
   *                     model: "llama-3.3-70b"
   *                     taskCount: 10
   *                     calls: 24
   *                     promptTokens: 50000
   *                     completionTokens: 12000
   *                     totalTokens: 62000
   *                     costUsd: 0.62
   *                 breakdown:
   *                   - agentId: "agent-1"
   *                     agentType: "research"
   *                     model: "llama-3.3-70b"
   *                     day: "2026-08-25"
   *                     calls: 8
   *                     promptTokens: 16000
   *                     completionTokens: 4000
   *                     totalTokens: 20000
   *                     costUsd: 0.2
   *                 recent:
   *                   - taskId: "task_ab12cd34ef56"
   *                     walletPublicKey: "GBZXN7PIRZGNMHGA728XZVOG2GUFIDLAZ6AF2I2MD2OCYTAF2K1K4AAA"
   *                     usedTokens: 1550
   *                     budgetTokens: 10000
   *                     costUsd: 0.00155
   *                     exceeded: false
   *                     settledAt: "2026-08-25T17:05:00.000Z"
   *               _meta:
   *                 version: "2.0"
   *                 timestamp: "2026-08-25T17:05:00.000Z"
   *                 requestId: "req_c918a245"
   *                 apiVersion: "2.0"
   *       400:
   *         description: Invalid query parameters
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/ValidationError'
   *             example:
   *               error: "Validation failed"
   *               details:
   *                 - field: "day"
   *                   message: "Query parameter \"day\" must be formatted YYYY-MM-DD"
   */
  router.get("/costs", (req: Request, res: Response, next: NextFunction): void => {
    try {
      const db = createTaskDb(getTaskDb());
      const agentLimit = clampLimit(req.query.agentLimit, 50, 200);
      const recentLimit = clampLimit(req.query.recentLimit, 20, 100);

      const filter = parseBreakdownFilter(req);
      const breakdownLimit = clampLimit(req.query.breakdownLimit, 100, 500);

      const totals = db.getCostTotals();
      const byAgent = db.listAgentCostTotals(agentLimit);
      const recent = db.listRecentCosts(recentLimit);
      const breakdown = db.listCostBreakdown(filter, breakdownLimit);

      log.debug({ totals: totals.costUsd, agents: byAgent.length }, "cost breakdown requested");

      res.json({
        data: {
          totals,
          byAgent,
          breakdown,
          recent: recent.map((row) => ({
            taskId: row.taskId,
            walletPublicKey: row.walletPublicKey,
            usedTokens: row.usedTokens,
            budgetTokens: row.budgetTokens,
            costUsd: row.costUsd,
            exceeded: row.exceeded,
            settledAt: row.settledAt,
          })),
        },
        _meta: {
          version: "2.0",
          timestamp: new Date().toISOString(),
          requestId: res.locals.requestId || null,
          apiVersion: res.locals.apiVersion || "2.0",
        },
      });
    } catch (err) {
      next(err);
    }
  });

  return router;
}

const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/** Read the optional agent/model/day dimension filters from the query string. */
function parseBreakdownFilter(req: Request): CostBreakdownFilter {
  const filter: CostBreakdownFilter = {};
  for (const key of ["agentId", "agentType", "model", "day"] as const) {
    const raw = req.query[key];
    if (raw === undefined) continue;
    if (typeof raw !== "string" || raw.trim() === "") {
      throw new ValidationError(`Query parameter "${key}" must be a non-empty string`, { field: key });
    }
    filter[key] = raw;
  }
  if (filter.day !== undefined && !DAY_PATTERN.test(filter.day)) {
    throw new ValidationError('Query parameter "day" must be formatted YYYY-MM-DD', { field: "day" });
  }
  return filter;
}

function clampLimit(
  raw: unknown,
  fallback: number,
  max: number
): number {
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(Math.floor(parsed), max);
}
