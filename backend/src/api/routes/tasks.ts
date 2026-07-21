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

export function createTasksRouter(dispatch: DispatchFn, releasePayment: PaymentReleaseFn): Router {
  const tasksRouter = Router();

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
 *       404:
 *         description: Task not found
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */
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
 *       404:
 *         description: Task not found
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       409:
 *         description: Cannot cancel a running task
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */
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
