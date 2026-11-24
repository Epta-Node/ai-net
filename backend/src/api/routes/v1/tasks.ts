import { Router, Request, Response } from "express";
import { z } from "zod";
import { nanoid } from "nanoid";
import { getTaskDb, createTaskDb } from "../../../db/tasks";
import { decompose } from "../../../coordinator";
import type { Task } from "../../../types/task";
import { executeDAG, type DispatchFn, type PaymentReleaseFn } from "../../../coordinator/coordinator";
import { createTask, getTask, abortTask } from "../../../coordinator/taskStore";
import { createLogger } from "../../../utils/logger";
import { validate } from "../../middleware/validate";
import { rateLimitMiddleware } from "../../middleware/rateLimit";
import { idempotencyMiddleware } from "../../middleware/idempotency";
import { currentTraceId } from "../../../services/traceContext";
import { assertDailyTaskQuota } from "../../../services/quota/dailyQuota";
import { walletQuotaCheck } from "../../middleware/quotaCheck";
import { getWalletQuotaStatus } from "../../../services/quota/walletQuota";
import { NotFoundError, ForbiddenError, ConflictError, UnauthorizedError } from "../../../errors";

import { getGlobalJobQueue, type JobQueue, type JobPriority } from "../../../queue";
import { config } from "../../../config";

// ── Validation config ────────────────────────────────────────────────────────
const DAILY_TASK_LIMIT = config.DAILY_TASK_LIMIT_PER_WALLET;

// ── Schemas ──────────────────────────────────────────────────────────────────

// Both schemas now live in src/schemas/task.ts so the three task routers, and
// the frontend, share one definition. Re-exported to keep existing importers
// of `createTaskSchema` working.
export { createTaskSchema } from "../../../schemas/task";
import { createTaskSchema, listTasksQuerySchema } from "../../../schemas/task";

const log = createLogger({ module: "tasks-v1" });

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
  tasksRouter.post("/", idempotencyMiddleware, rateLimitMiddleware, validate(createTaskSchema), walletQuotaCheck, (req: Request, res: Response): void => {
    const { prompt, priority } = req.body as z.infer<typeof createTaskSchema>;
    const walletPublicKey: string =
      (req.body as z.infer<typeof createTaskSchema>).walletPublicKey ??
      (req.headers["walletpublickey"] as string | undefined) ??
      "anonymous";

    // Throws a 429 RateLimitError and counts the rejection in the quota metrics
    // when the wallet has spent its DAILY_TASK_LIMIT_PER_WALLET.
    assertDailyTaskQuota(walletPublicKey);

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
  tasksRouter.get("/", validate({ query: listTasksQuerySchema }), (req: Request, res: Response): void => {
    const walletPublicKey = (req.headers["walletpublickey"] as string) ?? "";
    const { page, pageSize, status, sort, q } = req.query as unknown as z.infer<typeof listTasksQuerySchema>;
    const db = createTaskDb(getTaskDb());
    const { tasks, total } = db.list(walletPublicKey, page, pageSize, {
      status,
      sort,
      q: q && q.length > 0 ? q : undefined,
    });

    // v1 response format
    res.json({ tasks, total, page, pageSize });
  });

  tasksRouter.get("/quota", (req: Request, res: Response): void => {
    const wallet = (req.headers["walletpublickey"] as string | undefined)?.trim();
    if (!wallet) {
      throw new UnauthorizedError(
        "walletpublickey header is required",
        undefined,
        res.locals.correlationId as string | undefined,
      );
    }
    res.json(getWalletQuotaStatus(wallet));
  });

  // GET /api/tasks/:id — v1 format
  tasksRouter.get("/:id", (req: Request, res: Response): void => {
    const db = createTaskDb(getTaskDb());
    const task = db.findById(req.params.id);
    if (!task) {
      throw new NotFoundError("Task", req.params.id);
    }
    const requesterKey = req.headers["walletpublickey"] as string;
    if (!requesterKey || requesterKey !== task.walletPublicKey) {
      throw new ForbiddenError("Access denied");
    }
    // v1 response format - raw task object
    res.json(task);
  });

  // DELETE /api/tasks/:id — v1 format
  tasksRouter.delete("/:id", (req: Request, res: Response): void => {
    const db = createTaskDb(getTaskDb());
    const task = db.findById(req.params.id);
    if (!task) {
      throw new NotFoundError("Task", req.params.id);
    }

    const requesterKey = req.headers["walletpublickey"] as string;
    if (!requesterKey || requesterKey !== task.walletPublicKey) {
      throw new ForbiddenError("Not authorized to cancel this task");
    }

    if (task.status === "queued") {
      db.updateStatus(req.params.id, "cancelled");
      res.json({ taskId: req.params.id, status: "cancelled" });
      return;
    }

    if (task.status === "running") {
      abortTask(req.params.id);
      db.updateStatus(req.params.id, "cancelled");
      // v1 response format
      res.json({ taskId: req.params.id, status: "cancelling" });
      return;
    }

    throw new ConflictError(`Cannot cancel task in '${task.status}' status`);
  });

  return tasksRouter;
}
