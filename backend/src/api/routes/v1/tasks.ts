import { Router, Request, Response } from "express";
import { z } from "zod";
import { nanoid } from "nanoid";
import { getTaskDb, createTaskDb } from "../../../db/tasks";
import { decompose } from "../../../coordinator";
import type { Task } from "../../../types/task";
import { executeDAG, type DispatchFn, type PaymentReleaseFn } from "../../../coordinator/coordinator";
import { createTask, getTask } from "../../../coordinator/taskStore";
import { createLogger } from "../../../utils/logger";
import { validate } from "../../middleware/validate";
import { rateLimitMiddleware } from "../../middleware/rateLimit";

import { getGlobalJobQueue, type JobQueue, type JobPriority } from "../../../queue";

// ── Validation config ────────────────────────────────────────────────────────
const MAX_PROMPT_LENGTH = Number(process.env.MAX_PROMPT_LENGTH ?? 10_000);
const DAILY_TASK_LIMIT = Number(process.env.DAILY_TASK_LIMIT_PER_WALLET ?? 100);

// ── Schemas ──────────────────────────────────────────────────────────────────

export const createTaskSchema = z.object({
  prompt: z
    .string()
    .min(1, "Prompt is required")
    .max(MAX_PROMPT_LENGTH, `Prompt too long (max ${MAX_PROMPT_LENGTH} characters)`)
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
 * Creates a v1 tasks router with the original API response format.
 * This maintains backward compatibility for clients using API version 1.x.
 */
export function createV1TasksRouter(
  dispatch: DispatchFn,
  releasePayment: PaymentReleaseFn,
  queue?: JobQueue
): Router {
  const tasksRouter = Router();
  const jobQueue = queue ?? getGlobalJobQueue();

  // POST /api/tasks — v1 format
  tasksRouter.post("/", rateLimitMiddleware, validate(createTaskSchema), (req: Request, res: Response): void => {
    const { prompt, priority } = req.body as z.infer<typeof createTaskSchema>;
    const walletPublicKey: string =
      (req.body as z.infer<typeof createTaskSchema>).walletPublicKey ??
      (req.headers["walletpublickey"] as string | undefined) ??
      "anonymous";

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

    jobQueue.enqueue({
      taskId: task.id,
      type: "execute_task",
      priority: (priority as JobPriority) ?? "normal",
      payload: { taskId: task.id },
    });

    // v1 response format - simple response without additional metadata
    res.status(201).json({ taskId: task.id, dagPreview: dag, status: "queued" });
  });

  // GET /api/tasks — v1 format
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

    // v1 response format
    res.json({ tasks, total, page, pageSize });
  });

  // GET /api/tasks/:id — v1 format
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
    // v1 response format - raw task object
    res.json(task);
  });

  // DELETE /api/tasks/:id — v1 format
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
    // v1 response format
    res.json({ taskId: req.params.id, status: "cancelled" });
  });

  return tasksRouter;
}
