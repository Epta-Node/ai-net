import { Router, Request, Response } from "express";
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
});

const TaskListSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(10),
  status: z.enum(["queued", "running", "completed", "failed", "cancelled"]).optional(),
  sort: z.enum(["createdAt:desc", "createdAt:asc"]).default("createdAt:desc"),
  q: z.string().optional(),
});

// ── Router factory ───────────────────────────────────────────────────────────

export function createTasksRouter(dispatch: DispatchFn, releasePayment: PaymentReleaseFn): Router {
  const tasksRouter = Router();

  /**
   * @openapi
   * /api/tasks:
   *   post:
   *     summary: Create a new task
   *     tags: [Tasks]
   *     security:
   *       - WalletAuth: []
   *     requestBody:
   *       required: true
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *             required: [prompt, maxBudgetXLM]
   *             properties:
   *               prompt:
   *                 type: string
   *                 minLength: 1
   *                 maxLength: 10000
   *               maxBudgetXLM:
   *                 type: number
   *                 minimum: 0.1
   *               agentPreferences:
   *                 type: array
   *                 items:
   *                   type: string
   *     responses:
   *       201:
   *         description: Task created and queued
   *         content:
   *           application/json:
   *             schema:
   *               type: object
   *               properties:
   *                 taskId:
   *                   type: string
   *                   example: task_ab12cd34ef56
   *                 dagPreview:
   *                   type: object
   *                 status:
   *                   type: string
   *                   enum: [queued]
   *       400:
   *         description: Validation error
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/Error'
   *       429:
   *         description: Rate limit or daily quota exceeded
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/Error'
   */
  // POST /api/tasks — rate-limited, then Zod-validated
  tasksRouter.post("/", rateLimitMiddleware, validate(createTaskSchema), (req: Request, res: Response): void => {
    const { prompt } = req.body as z.infer<typeof createTaskSchema>;
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
        res.status(429).json({
          error: {
            message: `Daily task limit reached (max ${DAILY_TASK_LIMIT} per 24 hours)`,
            code: "DAILY_LIMIT_EXCEEDED",
          },
        });
        return;
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

    const log = createLogger({ taskId });

    // Run the DAG asynchronously — do not await
    setImmediate(() => {
      executeDAG(getTask(taskId)!, dispatch, releasePayment).catch((err) => {
        log.error({ err }, "DAG execution error");
      });
    });

    res.status(201).json({ taskId: task.id, dagPreview: dag, status: "queued" });
  });

  /**
   * @openapi
   * /api/tasks:
   *   get:
   *     summary: List tasks
   *     tags: [Tasks]
   *     security:
   *       - WalletAuth: []
   *     parameters:
   *       - in: query
   *         name: page
   *         schema: { type: integer, minimum: 1, default: 1 }
   *       - in: query
   *         name: pageSize
   *         schema: { type: integer, minimum: 1, maximum: 100, default: 10 }
   *       - in: query
   *         name: status
   *         schema:
   *           type: string
   *           enum: [queued, running, completed, failed, cancelled]
   *       - in: query
   *         name: sort
   *         schema:
   *           type: string
   *           enum: [createdAt:desc, createdAt:asc]
   *           default: createdAt:desc
   *       - in: query
   *         name: q
   *         schema: { type: string }
   *     responses:
   *       200:
   *         description: Paginated task list
   *         content:
   *           application/json:
   *             schema:
   *               type: object
   *               properties:
   *                 tasks:
   *                   type: array
   *                   items:
   *                     $ref: '#/components/schemas/Task'
   *                 total: { type: integer }
   *                 page: { type: integer }
   *                 pageSize: { type: integer }
   *       400:
   *         description: Invalid query parameters
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/Error'
   */
  // GET /api/tasks
  tasksRouter.get("/", (req: Request, res: Response): void => {
    const walletPublicKey = (req.headers["walletpublickey"] as string) ?? "";
    const parse = TaskListSchema.safeParse(req.query);
    if (!parse.success) {
      res.status(400).json({ error: parse.error.flatten() });
      return;
    }

    const { page, pageSize, status, sort, q } = parse.data;
    const db = createTaskDb(getTaskDb());
    const { tasks, total } = db.list(walletPublicKey, page, pageSize, {
      status,
      sort,
      q: q && q.length > 0 ? q : undefined,
    });

    res.json({ tasks, total, page, pageSize });
  });

  /**
   * @openapi
   * /api/tasks/{id}:
   *   get:
   *     summary: Get a task by ID
   *     tags: [Tasks]
   *     security:
   *       - WalletAuth: []
   *     parameters:
   *       - in: path
   *         name: id
   *         required: true
   *         schema: { type: string }
   *     responses:
   *       200:
   *         description: Task found
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/Task'
   *       403:
   *         description: Access denied — walletpublickey header is missing or does not match the task owner
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/Error'
   *       404:
   *         description: Task not found
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/Error'
   */
  // GET /api/tasks/:id
  tasksRouter.get("/:id", (req: Request, res: Response): void => {
    const db = createTaskDb(getTaskDb());
    const task = db.findById(req.params.id);
    if (!task) {
      res.status(404).json({ error: "Task not found" });
      return;
    }
    const requesterKey = req.headers["walletpublickey"] as string;
    if (!requesterKey || requesterKey !== task.walletPublicKey) {
      res.status(403).json({ error: "Access denied" });
      return;
    }
    res.json(task);
  });

  /**
   * @openapi
   * /api/tasks/{id}:
   *   delete:
   *     summary: Cancel a task
   *     description: Cancels a queued task. Returns 409 if the task is currently running.
   *     tags: [Tasks]
   *     security:
   *       - WalletAuth: []
   *     parameters:
   *       - in: path
   *         name: id
   *         required: true
   *         schema: { type: string }
   *     responses:
   *       200:
   *         description: Task cancelled
   *         content:
   *           application/json:
   *             schema:
   *               type: object
   *               properties:
   *                 taskId: { type: string }
   *                 status: { type: string, enum: [cancelled] }
   *       403:
   *         description: Not authorized to cancel this task
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/Error'
   *       404:
   *         description: Task not found
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/Error'
   *       409:
   *         description: Cannot cancel task in current status
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/Error'
   */
  // DELETE /api/tasks/:id
  tasksRouter.delete("/:id", (req: Request, res: Response): void => {
    const db = createTaskDb(getTaskDb());
    const task = db.findById(req.params.id);
    if (!task) {
      res.status(404).json({ error: "Task not found" });
      return;
    }

    const requesterKey = req.headers["walletpublickey"] as string;
    if (!requesterKey || requesterKey !== task.walletPublicKey) {
      res.status(403).json({ error: "Not authorized to cancel this task" });
      return;
    }

    if (task.status !== "queued") {
      res.status(409).json({ error: `Cannot cancel task in '${task.status}' status` });
      return;
    }

    db.updateStatus(req.params.id, "cancelled");
    res.json({ taskId: req.params.id, status: "cancelled" });
  });

  return tasksRouter;
}
