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

  // POST /api/tasks — v2 format with enhanced response
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
          _meta: {
            version: "2.0",
            timestamp: new Date().toISOString(),
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
        stream: `/api/tasks/${task.id}/stream`,
      },
    });
  });

  // GET /api/tasks — v2 format with enhanced response
  tasksRouter.get("/", (req: Request, res: Response): void => {
    const walletPublicKey = (req.headers["walletpublickey"] as string) ?? "";
    const parse = TaskListSchema.safeParse(req.query);
    if (!parse.success) {
      res.status(400).json({
        error: parse.error.flatten(),
        _meta: {
          version: "2.0",
          timestamp: new Date().toISOString(),
        },
      });
      return;
    }

    const { page, pageSize, status, sort, q } = parse.data;
    const db = createTaskDb(getTaskDb());
    const { tasks, total } = db.list(walletPublicKey, page, pageSize, {
      status,
      sort,
      q: q && q.length > 0 ? q : undefined,
    });

    const now = new Date().toISOString();

    // v2 enhanced response format
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
  });

  // GET /api/tasks/:id — v2 format with enhanced response
  tasksRouter.get("/:id", (req: Request, res: Response): void => {
    const db = createTaskDb(getTaskDb());
    const task = db.findById(req.params.id);
    if (!task) {
      res.status(404).json({
        error: "Task not found",
        _meta: {
          version: "2.0",
          timestamp: new Date().toISOString(),
        },
      });
      return;
    }
    const requesterKey = req.headers["walletpublickey"] as string;
    if (!requesterKey || requesterKey !== task.walletPublicKey) {
      res.status(403).json({
        error: "Access denied",
        _meta: {
          version: "2.0",
          timestamp: new Date().toISOString(),
        },
      });
      return;
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
        stream: `/api/tasks/${task.id}/stream`,
        cancel: `/api/tasks/${task.id}`,
      },
    });
  });

  // DELETE /api/tasks/:id — v2 format with enhanced response
  tasksRouter.delete("/:id", (req: Request, res: Response): void => {
    const db = createTaskDb(getTaskDb());
    const task = db.findById(req.params.id);
    if (!task) {
      res.status(404).json({
        error: "Task not found",
        _meta: {
          version: "2.0",
          timestamp: new Date().toISOString(),
        },
      });
      return;
    }

    const requesterKey = req.headers["walletpublickey"] as string;
    if (!requesterKey || requesterKey !== task.walletPublicKey) {
      res.status(403).json({
        error: "Not authorized to cancel this task",
        _meta: {
          version: "2.0",
          timestamp: new Date().toISOString(),
        },
      });
      return;
    }

    if (task.status !== "queued") {
      res.status(409).json({
        error: `Cannot cancel task in '${task.status}' status`,
        _meta: {
          version: "2.0",
          timestamp: new Date().toISOString(),
        },
      });
      return;
    }

    db.updateStatus(req.params.id, "cancelled");

    const now = new Date().toISOString();

    // v2 enhanced response format
    res.json({
      data: {
        taskId: req.params.id,
        status: "cancelled",
      },
      _meta: {
        version: "2.0",
        timestamp: now,
        requestId: res.locals.requestId || null,
        apiVersion: res.locals.apiVersion || "2.0",
      },
      _links: {
        self: `/api/tasks/${req.params.id}`,
      },
    });
  });

  return tasksRouter;
}
