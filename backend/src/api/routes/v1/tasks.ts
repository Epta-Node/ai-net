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
import { currentTraceId } from "../../../services/traceContext";
import { getConfig } from "../../../config";

import { getGlobalJobQueue, type JobQueue, type JobPriority } from "../../../queue";

// ── Validation config ────────────────────────────────────────────────────────
const DAILY_TASK_LIMIT = Number(process.env.DAILY_TASK_LIMIT_PER_WALLET ?? 100);

// ── Schemas ──────────────────────────────────────────────────────────────────

// Both schemas now live in src/schemas/task.ts so the three task routers, and
// the frontend, share one definition. Re-exported to keep existing importers
// of `createTaskSchema` working.
export { createTaskSchema } from "../../../schemas/task";
import { createTaskSchema, listTasksQuerySchema } from "../../../schemas/task";

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

  // POST /api/tasks — v1 format, idempotent
  tasksRouter.post("/", idempotencyMiddleware, rateLimitMiddleware, validate(createTaskSchema), (req: Request, res: Response): void => {
    const { prompt, priority } = req.body as z.infer<typeof createTaskSchema>;
    const walletPublicKey: string =
      (req.body as z.infer<typeof createTaskSchema>).walletPublicKey ??
      (req.headers["walletpublickey"] as string | undefined) ??
      "anonymous";

    const dailyTaskLimit = getConfig().DAILY_TASK_LIMIT_PER_WALLET;
    if (dailyTaskLimit > 0 && walletPublicKey !== "anonymous") {
      const db = createTaskDb(getTaskDb());
      const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
      const { total } = db.list(walletPublicKey, 1, 1, { createdAfter: since });
      if (total >= dailyTaskLimit) {
        res.status(429).json({
          error: {
            message: `Daily task limit reached (max ${dailyTaskLimit} per 24 hours)`,
            code: "DAILY_LIMIT_EXCEEDED",
          },
        });
        return;
      }
    }

    const taskId = `task_${nanoid(12)}`;
    const dag = decompose(taskId, prompt);
    const now = new Date().toISOString();
    const traceId = currentTraceId();
    const task: Task = {
      id: taskId,
      prompt,
      walletPublicKey,
      status: "queued",
      dag,
      createdAt: now,
      updatedAt: now,
      requestId: res.locals.requestId,
      traceId,
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
    const parse = listTasksQuerySchema.safeParse(req.query);
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
