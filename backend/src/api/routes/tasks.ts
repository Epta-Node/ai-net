import { Router, Request, Response } from "express";
import { nanoid } from "nanoid";
import { getTaskDb, createTaskDb } from "../../db/tasks";
import { decompose } from "../../coordinator";
import type { Task } from "../../types/task";
import { validate } from "../middleware/validate";
import {
  CreateTaskSchema,
  TaskQuerySchema,
  TaskIdParamSchema,
} from "../schemas/task.schema";

export const tasksRouter = Router();

// POST /api/tasks
tasksRouter.post(
  "/",
  validate({ body: CreateTaskSchema }),
  (req: Request, res: Response): void => {
    const { prompt, walletPublicKey } = req.body as {
      prompt: string;
      walletPublicKey?: string;
    };

    const wallet = walletPublicKey ?? (req.headers["walletpublickey"] as string) ?? "";

    const dag = decompose(prompt);
    const now = new Date().toISOString();
    const task: Task = {
      id: `task_${nanoid(12)}`,
      prompt,
      walletPublicKey: wallet,
      status: "queued",
      dagJson: JSON.stringify(dag),
      createdAt: now,
      updatedAt: now,
    };

    const db = createTaskDb(getTaskDb());
    db.insert(task);

    res.status(201).json({ taskId: task.id, dagPreview: dag, status: "queued" });
  },
);

// GET /api/tasks
tasksRouter.get(
  "/",
  validate({ query: TaskQuerySchema }),
  (req: Request, res: Response): void => {
    const walletPublicKey = (req.headers["walletpublickey"] as string) ?? "";
    const { page, pageSize, status, sort, q } = req.query as unknown as {
      page: number;
      pageSize: number;
      status?: Task["status"];
      sort: "createdAt:desc" | "createdAt:asc";
      q?: string;
    };

    const db = createTaskDb(getTaskDb());
    const { tasks, total } = db.list(walletPublicKey, page, pageSize, {
      status,
      sort,
      q: q && q.length > 0 ? q : undefined,
    });

    res.json({
      tasks: tasks.map((t) => ({ ...t, dag: JSON.parse(t.dagJson) })),
      total,
      page,
      pageSize,
    });
  },
);

// GET /api/tasks/:id
tasksRouter.get(
  "/:id",
  validate({ params: TaskIdParamSchema }),
  (req: Request, res: Response): void => {
    const db = createTaskDb(getTaskDb());
    const task = db.findById(req.params.id);
    if (!task) {
      res.status(404).json({ error: "Task not found" });
      return;
    }
    res.json({ ...task, dag: JSON.parse(task.dagJson) });
  },
);

// DELETE /api/tasks/:id
tasksRouter.delete(
  "/:id",
  validate({ params: TaskIdParamSchema }),
  (req: Request, res: Response): void => {
    const db = createTaskDb(getTaskDb());
    const task = db.findById(req.params.id);
    if (!task) {
      res.status(404).json({ error: "Task not found" });
      return;
    }
    if (task.status === "running") {
      res.status(409).json({ error: "Cannot cancel a running task" });
      return;
    }
    db.updateStatus(req.params.id, "cancelled");
    res.json({ taskId: req.params.id, status: "cancelled" });
  },
);
