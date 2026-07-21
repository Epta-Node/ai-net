import express, { Request, Response, NextFunction } from "express";
import { createServer, Server as HttpServer } from "http";
import { randomUUID } from "crypto";
import swaggerUi from "swagger-ui-express";

import {
  type DispatchFn,
  type PaymentReleaseFn,
} from "../coordinator/coordinator";
import { getTask } from "../coordinator/taskStore";
import { eventBus } from "../coordinator/eventBus";
import { createEventStore, type EventStore } from "../coordinator/eventStore";
import { attachTaskStream, type TaskStreamOptions } from "./routes/stream";
import type { DAGNode } from "../types/task";
import {
  createPaymentReleaseFn,
  type StellarReleasePaymentFn,
} from "../payment";
import { agentsRouter } from "./routes/agents";
import { healthRouter } from "./routes/health";
import { createStatsRouter } from "./routes/stats";
import { createTasksRouter } from "./routes/tasks";
import { rateLimitMiddleware } from "./middleware/rateLimit";
import { authMiddleware } from "./middleware/auth";
import { createCorsMiddleware } from "./middleware/cors";
import { requestId } from "./middleware/requestId";
import { requestLogger } from "./middleware/requestLogger";
import { errorHandler } from "./middleware/errorHandler";
import { validate } from "./middleware/validate";
import {
  CreateTaskSchema,
  TaskQuerySchema,
  TaskIdParamSchema,
} from "./schemas/task.schema";
import { createLogger } from "../utils/logger";
import { createTaskDb, getTaskDb } from "../db/tasks";
import { openapiSpec } from "./docs/openapi";

export interface AppOptions {
  /** Called to execute a single DAG node; defaults to HTTP dispatch */
  dispatch?: DispatchFn;
  /** Called after each node completes; defaults to no-op (returns 'mock-hash') */
  releasePayment?: PaymentReleaseFn;
  /** Event log for stream replay; defaults to an in-memory SQLite store */
  eventStore?: EventStore;
  /** Heartbeat / auth timing for the WebSocket stream */
  stream?: TaskStreamOptions;
}

/**
 * Attempt to load smart-contracts releasePayment at runtime via dynamic require.
 * Returns undefined when the module is unavailable (e.g. backend CI without
 * smart-contracts compiled). Using require() instead of a static import keeps
 * TypeScript's rootDir constraint intact.
 */
function tryLoadStellarRelease(): StellarReleasePaymentFn | undefined {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require("../../../smart-contracts/src/payment/payment")
      .releasePayment as StellarReleasePaymentFn;
  } catch {
    return undefined;
  }
}

export function createApp(opts: AppOptions = {}): {
  httpServer: HttpServer;
  close: (callback?: () => void) => void;
} {
  const app = express();
  app.use(express.json());
  // ── Global middleware ────────────────────────────────────────────────────────
  app.use((_req, res, next) => {
    if (process.env.NODE_ENV === "production") {
      res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains; preload");
    }
    next();
  });
  app.use(createCorsMiddleware());
  app.use(requestId);
  app.use(requestLogger);

  const dispatch: DispatchFn = opts.dispatch ?? defaultDispatch;
  const releasePayment: PaymentReleaseFn =
    opts.releasePayment ?? createPaymentReleaseFn(tryLoadStellarRelease());

  // ── Health routes ───────────────────────────────────────────────────────────
  app.use("/health", healthRouter);

  // ── Stats routes ───────────────────────────────────────────────────────────
  app.use("/api/stats", createStatsRouter(getTaskDb()));

  // ── Agent routes ───────────────────────────────────────────────────────────
  app.use("/api/agents", agentsRouter);

  // ── POST /api/tasks ────────────────────────────────────────────────────────
  app.post(
    "/api/tasks",
    authMiddleware,
    rateLimitMiddleware,
    validate({ body: CreateTaskSchema }),
    (req: Request, res: Response) => {
      const { prompt, walletPublicKey } = req.body as {
        prompt: string;
        walletPublicKey?: string;
      };

      const taskId = `task_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
      const dag = decompose(taskId, prompt);
      const now = new Date().toISOString();
      const correlationId = res.locals.requestId;

      createTask({
        taskId,
        prompt,
        walletPublicKey:
          walletPublicKey ??
          (req.headers["walletpublickey"] as string | undefined) ??
          "anonymous",
        status: "queued",
        dag,
        createdAt: now,
        updatedAt: now,
        requestId: correlationId,
      });

      const log = createLogger({ requestId: correlationId, taskId });

      // Run the DAG asynchronously — do not await
      setImmediate(() => {
        executeDAG(getTask(taskId)!, dispatch, releasePayment).catch((err) => {
          log.error({ err }, "DAG execution error");
        });
      });

      log.info({ dagNodeCount: dag.length }, "task created");

      return res
        .status(201)
        .json({ taskId, dagPreview: dag, status: "queued" });
    },
  );

  // ── GET /api/tasks ─────────────────────────────────────────────────────────
  app.get(
    "/api/tasks",
    authMiddleware,
    validate({ query: TaskQuerySchema }),
    (req: Request, res: Response) => {
      const walletPublicKey = req.headers["walletpublickey"] as
        string | undefined;
      if (!walletPublicKey)
        return res.status(401).json({ error: "walletpublickey header required" });
      const { page, pageSize, status, sort, q } = req.query as unknown as {
        page: number;
        pageSize: number;
        status?: string;
        sort: "createdAt:asc" | "createdAt:desc";
        q?: string;
      };
      const taskDb = createTaskDb(getTaskDb());
      const { tasks, total } = taskDb.list(walletPublicKey, page, pageSize, {
        status,
        q,
        sort,
      });
      return res.json({ tasks, total, page, pageSize });
    },
  );

  // ── GET /api/tasks/:id ─────────────────────────────────────────────────────
  app.get(
    "/api/tasks/:id",
    validate({ params: TaskIdParamSchema }),
    (req: Request, res: Response) => {
      const task = getTask(req.params.id!);
      if (!task) return res.status(404).json({ error: "Task not found" });
      return res.json({ ...task, id: task.taskId, dag: task.dag });
    },
  );

  // ── DELETE /api/tasks/:id ──────────────────────────────────────────────────
  app.delete(
    "/api/tasks/:id",
    validate({ params: TaskIdParamSchema }),
    (req: Request, res: Response) => {
      const task = getTask(req.params.id!);
      if (!task) return res.status(404).json({ error: "Task not found" });
      if (task.status === "running") {
        return res.status(409).json({ error: "Cannot cancel a running task" });
      }
      const taskDb = createTaskDb(getTaskDb());
      taskDb.updateStatus(req.params.id!, "cancelled");
      return res.json({ ...task, id: task.taskId, status: "cancelled" });
    },
  );

  // ── HTTP server ────────────────────────────────────────────────────────────
  const httpServer = createServer(app);

  // ── Event persistence ──────────────────────────────────────────────────────
  // Record every Coordinator event (with its EventBus-assigned per-task seq) so
  // a (re)connecting client can replay history before live streaming begins —
  // either the full history, or only events past a `?lastEventId` cursor.
  const eventStore = opts.eventStore ?? createEventStore();
  const stopRecording = eventBus.subscribeAll((event) =>
    eventStore.append(event),
  );

  // ── WebSocket: /tasks/:id/stream ───────────────────────────────────────────
  const detachStream = attachTaskStream({
    httpServer,
    eventStore,
    eventBus,
    getTask,
    ...opts.stream,
  });

  // ── Error handler (must be last) ───────────────────────────────────────────
  app.use(errorHandler);

  function close(callback?: () => void): void {
    detachStream();
    stopRecording();
    eventStore.close();
    httpServer.close(callback);
  }

  return { httpServer, close };
}

async function defaultDispatch(
  taskId: string,
  node: DAGNode,
  context: string,
): Promise<unknown> {
  // In production this POSTs to the agent's HTTP endpoint.
  // The e2e test replaces this via opts.dispatch.
  throw new Error(`No agent registered for type: ${node.type}`);
}
