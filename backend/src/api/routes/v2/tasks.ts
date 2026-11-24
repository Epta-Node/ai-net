import { Router, Request, Response, NextFunction } from "express";
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
import { NotFoundError, ForbiddenError, ConflictError, ValidationError, UnauthorizedError } from "../../../errors";
import { taskStreamUrl } from "../stream";

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
import { TaskListSchema as LegacyTaskListSchema } from "../../schemas/task.schema";

const TaskCursorListSchema = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  status: z.enum(["queued", "running", "completed", "failed", "cancelled"]).optional(),
  sort: z.enum(["createdAt:desc", "createdAt:asc"]).default("createdAt:desc"),
  q: z.string().optional(),
});

/**
 * Creates a v2 tasks router with enhanced response format.
 * V2 includes additional metadata fields and improved response structure.
 */
export function createV2TasksRouter(
  dispatch: DispatchFn,
  releasePayment: PaymentReleaseFn,
  queue?: JobQueue
): Router {
  const tasksRouter = Router();
  const jobQueue = queue ?? getGlobalJobQueue();

  // POST /api/tasks — v2 format with enhanced response, idempotent
  tasksRouter.post("/", idempotencyMiddleware, rateLimitMiddleware, validate(createTaskSchema), walletQuotaCheck, (req: Request, res: Response, next: NextFunction): void => {
    try {
    const { prompt, priority } = req.body as z.infer<typeof createTaskSchema>;
    const walletPublicKey: string =
      (req.body as z.infer<typeof createTaskSchema>).walletPublicKey ??
      (req.headers["walletpublickey"] as string | undefined) ??
      "anonymous";

    // Throws a 429 RateLimitError and counts the rejection in the quota metrics
    // when the wallet has spent its DAILY_TASK_LIMIT_PER_WALLET.
    assertDailyTaskQuota(walletPublicKey, {
      correlationId: res.locals.correlationId as string | undefined,
    });

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

    // v2 enhanced response format with additional metadata
    res.status(201).json({
      data: {
        taskId: task.id,
        dagPreview: dag,
        status: "queued",
      },
      _meta: {
        version: "2.0",
        timestamp: now,
        requestId: res.locals.requestId || null,
        apiVersion: res.locals.apiVersion || "2.0",
      },
      _links: {
        self: `/api/tasks/${task.id}`,
        stream: taskStreamUrl(task.id),
      },
    });
    } catch (err) {
      next(err);
    }
  });

  // GET /api/tasks — v2 format: cursor pagination when ?cursor or ?limit present, offset otherwise
  tasksRouter.get("/", (req: Request, res: Response, next: NextFunction): void => {
    try {
    const walletPublicKey = (req.headers["walletpublickey"] as string) ?? "";
    const now = new Date().toISOString();

    // Use cursor mode when an explicit cursor or limit (without page) is provided
    const useCursor = "cursor" in req.query || ("limit" in req.query && !("page" in req.query));

    if (useCursor) {
      const parse = TaskCursorListSchema.safeParse(req.query);
      if (!parse.success) {
        throw new ValidationError(
          "Invalid query parameters",
          { issues: parse.error.flatten() },
          res.locals.correlationId as string | undefined,
        );
      }

      const { cursor, limit, status, sort, q } = parse.data;
      const db = createTaskDb(getTaskDb());
      const page = db.listCursor(walletPublicKey, {
        cursor,
        limit,
        status,
        sort,
        q: q && q.length > 0 ? q : undefined,
      });

      res.json({
        data: {
          items: page.items,
          pagination: {
            limit,
            nextCursor: page.nextCursor ?? null,
            hasNextPage: !!page.nextCursor,
          },
        },
        _meta: {
          version: "2.0",
          timestamp: now,
          requestId: res.locals.requestId || null,
          apiVersion: res.locals.apiVersion || "2.0",
        },
        _links: {
          self: `/api/tasks`,
          ...(page.nextCursor
            ? { next: `/api/tasks?cursor=${encodeURIComponent(page.nextCursor)}&limit=${limit}` }
            : {}),
        },
      });
      return;
    }

    // Offset fallback (backward-compatible)
    const parse = LegacyTaskListSchema.safeParse(req.query);
    if (!parse.success) {
      throw new ValidationError(
        "Invalid query parameters",
        { issues: parse.error.flatten() },
        res.locals.correlationId as string | undefined,
      );
    }

    const { page, pageSize, status, sort, q } = parse.data;
    const db = createTaskDb(getTaskDb());
    const { tasks, total } = db.list(walletPublicKey, page, pageSize, {
      status,
      sort,
      q: q && q.length > 0 ? q : undefined,
    });

    res.json({
      data: {
        tasks,
        pagination: {
          page,
          pageSize,
          total,
          totalPages: Math.ceil(total / pageSize),
          hasNextPage: page * pageSize < total,
          hasPreviousPage: page > 1,
        },
      },
      _meta: {
        version: "2.0",
        timestamp: now,
        requestId: res.locals.requestId || null,
        apiVersion: res.locals.apiVersion || "2.0",
      },
    });
    } catch (err) {
      next(err);
    }
  });

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

  // GET /api/tasks/:id — v2 format with enhanced response
  tasksRouter.get("/:id", (req: Request, res: Response, next: NextFunction): void => {
    try {
    const db = createTaskDb(getTaskDb());
    const task = db.findById(req.params.id);
    if (!task) {
      throw new NotFoundError("Task", req.params.id, undefined, res.locals.correlationId as string | undefined);
    }
    const requesterKey = req.headers["walletpublickey"] as string;
    if (!requesterKey || requesterKey !== task.walletPublicKey) {
      throw new ForbiddenError(
        "Access denied",
        { taskId: req.params.id, walletPublicKey: requesterKey },
        res.locals.correlationId as string | undefined,
      );
    }

    const now = new Date().toISOString();

    // v2 enhanced response format with links and metadata
    res.json({
      data: task,
      _meta: {
        version: "2.0",
        timestamp: now,
        requestId: res.locals.requestId || null,
        apiVersion: res.locals.apiVersion || "2.0",
      },
      _links: {
        self: `/api/tasks/${task.id}`,
        stream: taskStreamUrl(task.id),
        cancel: `/api/tasks/${task.id}`,
      },
    });
    } catch (err) {
      next(err);
    }
  });

  // DELETE /api/tasks/:id — v2 format with enhanced response
  tasksRouter.delete("/:id", (req: Request, res: Response, next: NextFunction): void => {
    try {
    const db = createTaskDb(getTaskDb());
    const task = db.findById(req.params.id);
    if (!task) {
      throw new NotFoundError("Task", req.params.id, undefined, res.locals.correlationId as string | undefined);
    }

    const requesterKey = req.headers["walletpublickey"] as string;
    if (!requesterKey || requesterKey !== task.walletPublicKey) {
      throw new ForbiddenError(
        "Not authorized to cancel this task",
        { taskId: req.params.id, walletPublicKey: requesterKey },
        res.locals.correlationId as string | undefined,
      );
    }

    const nowTs = new Date().toISOString();

    if (task.status === "queued") {
      db.updateStatus(req.params.id, "cancelled");

      res.json({
        data: {
          taskId: req.params.id,
          status: "cancelled",
        },
        _meta: {
          version: "2.0",
          timestamp: nowTs,
          requestId: res.locals.requestId || null,
          apiVersion: res.locals.apiVersion || "2.0",
        },
        _links: {
          self: `/api/tasks/${req.params.id}`,
        },
      });
      return;
    }

    if (task.status === "running") {
      // Signal the coordinator to abort in-flight execution; the response is
      // returned immediately (async cancellation).
      abortTask(req.params.id);
      db.updateStatus(req.params.id, "cancelled");

      res.json({
        data: {
          taskId: req.params.id,
          status: "cancelling",
        },
        _meta: {
          version: "2.0",
          timestamp: nowTs,
          requestId: res.locals.requestId || null,
          apiVersion: res.locals.apiVersion || "2.0",
        },
        _links: {
          self: `/api/tasks/${req.params.id}`,
        },
      });
      return;
    }

    throw new ConflictError(
      `Cannot cancel task in '${task.status}' status`,
      { taskId: req.params.id, status: task.status },
      res.locals.correlationId as string | undefined,
    );
    } catch (err) {
      next(err);
    }
  });

  return tasksRouter;
}
