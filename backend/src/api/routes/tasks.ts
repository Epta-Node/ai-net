import { Router, Request, Response, NextFunction } from "express";
import { z } from "zod";
import { nanoid } from "nanoid";
import { getTaskDb, createTaskDb } from "../../db/tasks";
import { decompose } from "../../coordinator";
import type { Task } from "../../types/task";
import { executeDAG, type DispatchFn, type PaymentReleaseFn } from "../../coordinator/coordinator";
import { createTask, getTask, abortTask } from "../../coordinator/taskStore";
import { createLogger } from "../../utils/logger";
import { validate } from "../middleware/validate";
import { rateLimitMiddleware } from "../middleware/rateLimit";
import { idempotencyMiddleware } from "../middleware/idempotency";
import { ValidationError, NotFoundError, AppError, ForbiddenError, ConflictError, UnauthorizedError } from "../../errors";
import { assertDailyTaskQuota } from "../../services/quota/dailyQuota";
import { walletQuotaCheck } from "../middleware/quotaCheck";
import { getWalletQuotaStatus } from "../../services/quota/walletQuota";

import { getGlobalJobQueue, type JobQueue, type JobPriority } from "../../queue";
import { config } from "../../config";

// ── Validation config ────────────────────────────────────────────────────────
// Read at module load time so the value is stable for the lifetime of the
// process. Tests that need a different value should set process.env before
// importing (or use jest.resetModules() + re-require).
const DAILY_TASK_LIMIT = config.DAILY_TASK_LIMIT_PER_WALLET;

// ── Schemas ──────────────────────────────────────────────────────────────────

/**
 * Schema for POST /api/tasks request body.
 *
 * Security measures:
 *  - `prompt` enforces a configurable max length to prevent token-cost abuse
 *    (issue #181: 100 000-character prompts → massive Venice AI bills).
 *  - `.transform()` strips C0 control characters (excl. HT, LF, CR) to
 *    mitigate prompt injection via invisible control sequences.
 */
// `maxBudgetXLM` and `walletPublicKey` are optional, matching the handler this
// router replaced (previously inline in app.ts). The old contract only rejected
// maxBudgetXLM when it was present and below the minimum, and accepted
// walletPublicKey from the body; requiring them here silently broke every
// caller that omitted them, including the e2e suite.
// Both schemas now live in src/schemas/task.ts so the three task routers, and
// the frontend, share one definition. Re-exported to keep existing importers
// of `createTaskSchema` working.
export { createTaskSchema } from "../../schemas/task";
import { createTaskSchema, listTasksQuerySchema } from "../../schemas/task";

/**
 * @deprecated Use version-specific routers instead: createV1TasksRouter or createV2TasksRouter
 * This router is kept for backward compatibility and will be removed in a future version.
 */
export function createTasksRouter(
  dispatch: DispatchFn,
  releasePayment: PaymentReleaseFn,
  queue?: JobQueue
): Router {
  const tasksRouter = Router();
  const jobQueue = queue ?? getGlobalJobQueue();

  /**
   * @openapi
   * /api/tasks:
   *   post:
   *     summary: Create and enqueue a new task
   *     description: Decomposes a natural language prompt into an execution DAG, persists the task, and enqueues a background job for worker execution.
   *     tags: [Tasks]
   *     security:
   *       - WalletAuth: []
   *     requestBody:
   *       required: true
   *       content:
   *         application/json:
   *           schema:
   *             $ref: '#/components/schemas/CreateTaskRequest'
   *           examples:
   *             defi_research:
   *               summary: DeFi Research Task
   *               value:
   *                 prompt: "Analyze Stellar DEX liquidity trends and generate a summary report"
   *                 walletPublicKey: "GBZXN7PIRZGNMHGA728XZVOG2GUFIDLAZ6AF2I2MD2OCYTAF2K1K4AAA"
   *                 maxBudgetXLM: 5.0
   *                 agentPreferences: ["research-agent-v1", "report-agent-v1"]
   *                 priority: "normal"
   *     responses:
   *       201:
   *         description: Task successfully created and enqueued
   *         headers:
   *           X-RateLimit-Limit:
   *             $ref: '#/components/headers/X-RateLimit-Limit'
   *           X-RateLimit-Remaining:
   *             $ref: '#/components/headers/X-RateLimit-Remaining'
   *           X-RateLimit-Reset:
   *             $ref: '#/components/headers/X-RateLimit-Reset'
   *           X-Request-Id:
   *             $ref: '#/components/headers/X-Request-Id'
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/CreateTaskResponse'
   *             example:
   *               taskId: "task_ab12cd34ef56"
   *               status: "queued"
   *               dagPreview:
   *                 - nodeId: "node_research_1"
   *                   agentType: "research"
   *                   prompt: "Analyze Stellar DEX liquidity"
   *                   dependsOn: []
   *                   status: "pending"
   *       400:
   *         description: Invalid request payload or prompt validation failure
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/ValidationError'
   *             example:
   *               error: "Validation failed"
   *               details:
   *                 - field: "prompt"
   *                   message: "Prompt is required"
   *       429:
   *         description: Rate limit or daily task limit exceeded
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/RateLimitError'
   *             example:
   *               error: "Daily task limit reached (max 100 per 24 hours)"
   *       500:
   *         description: Internal server error during task decomposition
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/InternalServerError'
   */
  // POST /api/tasks — idempotent, rate-limited, then Zod-validated
  tasksRouter.post("/", idempotencyMiddleware, rateLimitMiddleware, validate(createTaskSchema), walletQuotaCheck, (req: Request, res: Response, next: NextFunction): void => {
    try {
      const { prompt, priority } = req.body as z.infer<typeof createTaskSchema>;
      // Body first, then the header (both spellings accepted), then "anonymous".
      const walletPublicKey: string =
        (req.body as z.infer<typeof createTaskSchema>).walletPublicKey ??
        (req.headers["walletpublickey"] as string | undefined) ??
        "anonymous";

      // ── Per-wallet daily quota ───────────────────────────────────────────────
      // Throws a 429 RateLimitError and counts the rejection in the quota
      // metrics when the wallet has spent its DAILY_TASK_LIMIT_PER_WALLET.
      assertDailyTaskQuota(walletPublicKey, {
        correlationId: res.locals.correlationId as string | undefined,
      });

      const taskId = `task_${nanoid(12)}`;
      const dag = decompose(taskId, prompt);
      const now = new Date().toISOString();
      const task: Task = {
        id: taskId,
        prompt,
        walletPublicKey,
        status: "queued",
        dag,
        createdAt: now,
        updatedAt: now,
      };

      createTask(task);

      // Enqueue task into persistent background job queue
      jobQueue.enqueue({
        taskId: task.id,
        type: "execute_task",
        priority: (priority as JobPriority) ?? "normal",
        payload: { taskId: task.id },
      });

      res.status(201).json({ taskId: task.id, dagPreview: dag, status: "queued" });
    } catch (err) {
      next(err);
    }
  });

  /**
   * @openapi
   * /api/tasks:
   *   get:
   *     summary: List tasks for the authenticated wallet
   *     description: Returns paginated tasks owned by the wallet specified in the `walletpublickey` header with filtering and sorting support.
   *     tags: [Tasks]
   *     security:
   *       - WalletAuth: []
   *     parameters:
   *       - in: query
   *         name: page
   *         schema: { type: integer, minimum: 1, default: 1 }
   *         description: Page number for pagination
   *         example: 1
   *       - in: query
   *         name: pageSize
   *         schema: { type: integer, minimum: 1, maximum: 100, default: 10 }
   *         description: Number of tasks per page
   *         example: 10
   *       - in: query
   *         name: status
   *         schema:
   *           $ref: '#/components/schemas/TaskStatus'
   *         description: Filter tasks by lifecycle status
   *         example: "completed"
   *       - in: query
   *         name: sort
   *         schema:
   *           type: string
   *           enum: [createdAt:desc, createdAt:asc]
   *           default: createdAt:desc
   *         description: Sort order
   *         example: "createdAt:desc"
   *       - in: query
   *         name: q
   *         schema: { type: string }
   *         description: Substring search in prompt text
   *         example: "liquidity"
   *     responses:
   *       200:
   *         description: Paginated list of tasks
   *         headers:
   *           X-RateLimit-Limit:
   *             $ref: '#/components/headers/X-RateLimit-Limit'
   *           X-RateLimit-Remaining:
   *             $ref: '#/components/headers/X-RateLimit-Remaining'
   *           X-RateLimit-Reset:
   *             $ref: '#/components/headers/X-RateLimit-Reset'
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/TaskListResponse'
   *             example:
   *               tasks:
   *                 - id: "task_ab12cd34ef56"
   *                   prompt: "Analyze Stellar DEX liquidity trends"
   *                   walletPublicKey: "GBZXN7PIRZGNMHGA728XZVOG2GUFIDLAZ6AF2I2MD2OCYTAF2K1K4AAA"
   *                   status: "completed"
   *                   dagJson: "[{\"nodeId\":\"node_research_1\",\"status\":\"completed\"}]"
   *                   createdAt: "2026-08-25T17:00:00.000Z"
   *                   updatedAt: "2026-08-25T17:05:00.000Z"
   *               total: 1
   *               page: 1
   *               pageSize: 10
   *       400:
   *         description: Invalid query parameters
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/ValidationError'
   *       500:
   *         description: Internal server error querying task database
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/InternalServerError'
   */
  // GET /api/tasks
  tasksRouter.get("/", (req: Request, res: Response, next: NextFunction): void => {
    try {
      const walletPublicKey = (req.headers["walletpublickey"] as string) ?? "";
      const parse = listTasksQuerySchema.safeParse(req.query);
      if (!parse.success) {
        const correlationId = res.locals.correlationId as string | undefined;
        throw new ValidationError(
          "Invalid query parameters",
          { issues: parse.error.flatten() },
          correlationId,
        );
      }

      const { page, pageSize, status, sort, q } = parse.data;
      const db = createTaskDb(getTaskDb());
      const { tasks, total } = db.list(walletPublicKey, page, pageSize, {
        status,
        sort,
        q: q && q.length > 0 ? q : undefined,
      });

      res.json({ tasks, total, page, pageSize });
    } catch (err) {
      next(err);
    }
  });

  /**
   * @openapi
   * /api/tasks/quota:
   *   get:
   *     summary: Get the calling wallet's daily task quota
   *     description: >
   *       Returns the number of task submissions the wallet made in the trailing
   *       24 hours against `MAX_DAILY_TASKS_PER_WALLET`, plus the UTC-midnight
   *       reset time. Requires the `walletpublickey` header.
   *     tags: [Tasks]
   *     security:
   *       - WalletAuth: []
   *     responses:
   *       200:
   *         description: Current quota usage for the wallet
   *         content:
   *           application/json:
   *             schema:
   *               type: object
   *               required: [used, limit, resetAt]
   *               properties:
   *                 used:
   *                   type: integer
   *                   example: 3
   *                 limit:
   *                   type: integer
   *                   example: 50
   *                 resetAt:
   *                   type: string
   *                   format: date-time
   *       401:
   *         description: Missing wallet identity
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/UnauthorizedError'
   *       429:
   *         description: Quota exhausted (see `Retry-After`)
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/RateLimitError'
   */
  tasksRouter.get("/quota", (req: Request, res: Response, next: NextFunction): void => {
    try {
      const wallet = (req.headers["walletpublickey"] as string | undefined)?.trim();
      if (!wallet) {
        throw new UnauthorizedError(
          "walletpublickey header is required",
          undefined,
          res.locals.correlationId as string | undefined,
        );
      }
      res.json(getWalletQuotaStatus(wallet));
    } catch (err) {
      next(err);
    }
  });

  /**
   * @openapi
   * /api/tasks/{id}:
   *   get:
   *     summary: Get task details by ID
   *     description: Fetches full task details, DAG structure, node statuses, execution outputs, and transaction hashes. Caller must be the task owner.
   *     tags: [Tasks]
   *     security:
   *       - WalletAuth: []
   *     parameters:
   *       - in: path
   *         name: id
   *         required: true
   *         schema: { type: string }
   *         description: Unique task identifier (e.g. task_ab12cd34ef56)
   *         example: "task_ab12cd34ef56"
   *     responses:
   *       200:
   *         description: Task found and returned
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/Task'
   *             example:
   *               id: "task_ab12cd34ef56"
   *               taskId: "task_ab12cd34ef56"
   *               prompt: "Analyze Stellar DEX liquidity trends"
   *               walletPublicKey: "GBZXN7PIRZGNMHGA728XZVOG2GUFIDLAZ6AF2I2MD2OCYTAF2K1K4AAA"
   *               status: "completed"
   *               dag:
   *                 - nodeId: "node_research_1"
   *                   agentType: "research"
   *                   prompt: "Analyze Stellar DEX liquidity"
   *                   dependsOn: []
   *                   status: "completed"
   *                   result:
   *                     summary: "Liquidity increased by 14%"
   *                   error: null
   *               createdAt: "2026-08-25T17:00:00.000Z"
   *               updatedAt: "2026-08-25T17:05:00.000Z"
   *       403:
   *         description: Access denied — walletpublickey header is missing or does not match task owner
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/ForbiddenError'
   *             example:
   *               error: "Access denied"
   *       404:
   *         description: Task not found
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/NotFoundError'
   *             example:
   *               error: "Task not found"
   */
  // GET /api/tasks/:id
  tasksRouter.get("/:id", (req: Request, res: Response, next: NextFunction): void => {
    try {
      const correlationId = res.locals.correlationId as string | undefined;
      const db = createTaskDb(getTaskDb());
      const task = db.findById(req.params.id);
      if (!task) {
        throw new NotFoundError("Task", req.params.id, undefined, correlationId);
      }
      const requesterKey = req.headers["walletpublickey"] as string;
      if (!requesterKey || requesterKey !== task.walletPublicKey) {
        throw new ForbiddenError("Access denied", undefined, correlationId);
      }
      res.json(task);
    } catch (err) {
      next(err);
    }
  });

  /**
   * @openapi
   * /api/tasks/{id}:
   *   delete:
   *     summary: Cancel a task
   *     description: >
   *       Cancels a queued task immediately, or initiates async cancellation for
   *       a running task. Returns 200 with `status: "cancelled"` for queued tasks
   *       and `status: "cancelling"` for running tasks. A `task_cancelled`
   *       WebSocket event is emitted within 1 second of aborting a running task.
   *       Returns 409 for tasks that are already completed or failed.
   *     tags: [Tasks]
   *     security:
   *       - WalletAuth: []
   *     parameters:
   *       - in: path
   *         name: id
   *         required: true
   *         schema: { type: string }
   *         example: "task_ab12cd34ef56"
   *     responses:
   *       200:
   *         description: Task cancelled (or cancellation initiated)
   *         content:
   *           application/json:
   *             schema:
   *               type: object
   *               properties:
   *                 taskId: { type: string, example: "task_ab12cd34ef56" }
   *                 status: { type: string, enum: [cancelled, cancelling], example: "cancelled" }
   *       403:
   *         description: Not authorized to cancel this task
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
   *       409:
   *         description: Cannot cancel task in current status (e.g. completed or failed)
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/ErrorResponse'
   *             example:
   *               error: "Cannot cancel task in 'completed' status"
   */
  // DELETE /api/tasks/:id
  tasksRouter.delete("/:id", (req: Request, res: Response, next: NextFunction): void => {
    try {
      const correlationId = res.locals.correlationId as string | undefined;
      const db = createTaskDb(getTaskDb());
      const task = db.findById(req.params.id);
      if (!task) {
        throw new NotFoundError("Task", req.params.id, undefined, correlationId);
      }

      const requesterKey = req.headers["walletpublickey"] as string;
      if (!requesterKey || requesterKey !== task.walletPublicKey) {
        throw new ForbiddenError("Not authorized to cancel this task", undefined, correlationId);
      }

      if (task.status === "queued") {
        // Simple case: not yet running — cancel synchronously.
        db.updateStatus(req.params.id, "cancelled");
        res.json({ taskId: req.params.id, status: "cancelled" });
        return;
      }

      if (task.status === "running") {
        // In-flight case: signal the coordinator to abort, then return
        // immediately.  The coordinator will finish cancellation asynchronously
        // and emit a `task_cancelled` WS event.
        abortTask(req.params.id);
        db.updateStatus(req.params.id, "cancelled");
        res.json({ taskId: req.params.id, status: "cancelling" });
        return;
      }

      throw new ConflictError(
        `Cannot cancel task in '${task.status}' status`,
        { currentStatus: task.status },
        correlationId,
      );
    } catch (err) {
      next(err);
    }
  });

  return tasksRouter;
}