import { Router, Request, Response, NextFunction } from "express";
import { z } from "zod";
import { nanoid } from "nanoid";
import { getTaskDb, createTaskDb } from "../../db/tasks";
import { decompose } from "../../coordinator";
import type { Task } from "../../types/task";
import { executeDAG, type DispatchFn, type PaymentReleaseFn } from "../../coordinator/coordinator";
import { createTask, getTask } from "../../coordinator/taskStore";
import { createLogger } from "../../utils/logger";
import { validate } from "../middleware/validate";
import { rateLimitMiddleware } from "../middleware/rateLimit";
import { ValidationError, NotFoundError, AppError, RateLimitError } from "../../errors";

import { getGlobalJobQueue, type JobQueue, type JobPriority } from "../../queue";

// ── Validation config ────────────────────────────────────────────────────────
// Read at module load time so the value is stable for the lifetime of the
// process. Tests that need a different value should set process.env before
// importing (or use jest.resetModules() + re-require).
const MAX_PROMPT_LENGTH = Number(process.env.MAX_PROMPT_LENGTH ?? 10_000);
const DAILY_TASK_LIMIT = Number(process.env.DAILY_TASK_LIMIT_PER_WALLET ?? 100);

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
export const createTaskSchema = z.object({
  prompt: z
    .string()
    .min(1, "Prompt is required")
    .max(MAX_PROMPT_LENGTH, `Prompt too long (max ${MAX_PROMPT_LENGTH} characters)`)
    // Strip C0 control characters (except tab \x09, newline \x0A, carriage return \x0D)
    // to prevent prompt injection via embedded invisible control sequences.
    .transform((s) => s.replace(/[\x00-\x08\x0E-\x1F]/g, "").trim()),
  walletPublicKey: z.string().optional(),
  maxBudgetXLM: z.number().min(0.1).optional().default(1),
  agentPreferences: z.array(z.string()).optional(),
  priority: z.enum(["low", "normal", "high", "critical"]).optional().default("normal"),
});

const TaskListSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(10),
  status: z.enum(["queued", "running", "completed", "failed", "cancelled"]).optional(),
  sort: z.enum(["createdAt:desc", "createdAt:asc"]).default("createdAt:desc"),
  q: z.string().optional(),
});

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
  // POST /api/tasks — rate-limited, then Zod-validated
  tasksRouter.post("/", rateLimitMiddleware, validate(createTaskSchema), (req: Request, res: Response, next: NextFunction): void => {
    try {
      const { prompt, priority } = req.body as z.infer<typeof createTaskSchema>;
      // Body first, then the header (both spellings accepted), then "anonymous".
      const walletPublicKey: string =
        (req.body as z.infer<typeof createTaskSchema>).walletPublicKey ??
        (req.headers["walletpublickey"] as string | undefined) ??
        "anonymous";

      // ── Per-wallet daily quota ───────────────────────────────────────────────
      if (DAILY_TASK_LIMIT > 0 && walletPublicKey !== "anonymous") {
        const db = createTaskDb(getTaskDb());
        const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
        const { total } = db.list(walletPublicKey, 1, 1, { createdAfter: since });
        if (total >= DAILY_TASK_LIMIT) {
          const correlationId = res.locals.correlationId as string | undefined;
          throw new RateLimitError(
            `Daily task limit reached (max ${DAILY_TASK_LIMIT} per 24 hours)`,
            { code: "DAILY_LIMIT_EXCEEDED", limit: DAILY_TASK_LIMIT, window: "24h" },
            correlationId,
          );
        }
      }

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
      const parse = TaskListSchema.safeParse(req.query);
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
        throw new AppError("Access denied", 403, "FORBIDDEN", undefined, correlationId);
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
   *     summary: Cancel a queued task
   *     description: Cancels a queued task before execution begins. If the task is already running or completed, returns 409 Conflict.
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
   *         description: Task cancelled successfully
   *         content:
   *           application/json:
   *             schema:
   *               type: object
   *               properties:
   *                 taskId: { type: string, example: "task_ab12cd34ef56" }
   *                 status: { type: string, enum: [cancelled], example: "cancelled" }
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
   *         description: Cannot cancel task in current status (e.g. running or completed)
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/ErrorResponse'
   *             example:
   *               error: "Cannot cancel task in 'running' status"
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
        throw new AppError("Not authorized to cancel this task", 403, "FORBIDDEN", undefined, correlationId);
      }

      if (task.status !== "queued") {
        // 409 Conflict — use AppError directly since there's no ConflictError subclass
        throw new AppError(
          `Cannot cancel task in '${task.status}' status`,
          409,
          "CONFLICT",
          { currentStatus: task.status },
          correlationId,
        );
      }

      db.updateStatus(req.params.id, "cancelled");
      res.json({ taskId: req.params.id, status: "cancelled" });
    } catch (err) {
      next(err);
    }
  });

  return tasksRouter;
}