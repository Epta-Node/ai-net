import { Router, type NextFunction, type Request, type Response } from "express";
import { z } from "zod";
import { getGlobalJobQueue, type JobQueue, type JobStatus } from "../../queue";
import {
  actorFromRequest,
  auditLogToCsv,
  backupDatabases,
  getReadOnlyState,
  listAdminAuditLog,
  listAgentsForAdmin,
  recordAdminAudit,
  setAgentEnabled,
  setReadOnlyState,
  vacuumDatabases,
} from "../../services/adminControl";
import {
  ReconciliationService,
  createDefaultReconciliationService,
} from "../../services/reconciliation";
import type { ReconciliationRouterOptions } from "./reconciliation";
import type { ReconciliationTrigger } from "../../services/reconciliation.types";
import { createLogger } from "../../utils/logger";

const logger = createLogger({ module: "admin" });

const readOnlySchema = z.object({
  enabled: z.boolean(),
  reason: z.string().max(500).optional(),
});

const agentListSchema = z.object({
  status: z.enum(["online", "offline"]).optional(),
});

const auditLogQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(1000).default(200),
  offset: z.coerce.number().int().min(0).default(0),
  format: z.enum(["json", "csv"]).default("json"),
});

const reconciliationSchema = z.object({
  triggeredBy: z.enum(["manual", "scheduled", "release"]).default("manual"),
});

const backupSchema = z.object({
  directory: z.string().min(1).optional(),
});

export interface AdminRouterOptions {
  queue?: JobQueue;
  reconciliation?: ReconciliationRouterOptions;
}

function asyncHandler(
  handler: (req: Request, res: Response, next: NextFunction) => Promise<void>,
) {
  return (req: Request, res: Response, next: NextFunction): void => {
    void handler(req, res, next).catch(next);
  };
}

function auditAdminRequests(req: Request, res: Response, next: NextFunction): void {
  res.on("finish", () => {
    recordAdminAudit({
      at: new Date().toISOString(),
      actor: actorFromRequest(req),
      action: `${req.method} ${req.baseUrl}${req.path}`,
      target: req.params.id,
      statusCode: res.statusCode,
      requestId:
        (res.locals.requestId as string | undefined) ??
        (res.locals.correlationId as string | undefined),
      details: {
        params: req.params,
        query: req.query,
        body: req.method === "GET" ? undefined : req.body,
      },
    });
  });
  next();
}

function getReconciliationService(options?: ReconciliationRouterOptions): ReconciliationService {
  return options?.service ?? createDefaultReconciliationService();
}

export function createAdminRouter(options: AdminRouterOptions = {}): Router {
  const router = Router();
  const jobQueue = options.queue ?? getGlobalJobQueue();
  const reconciliationService = getReconciliationService(options.reconciliation);

  router.use(auditAdminRequests);

  router.get("/read-only", (_req: Request, res: Response) => {
    res.json(getReadOnlyState());
  });

  router.put("/read-only", (req: Request, res: Response) => {
    const parsed = readOnlySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "INVALID_BODY", details: parsed.error.flatten() });
      return;
    }

    const state = setReadOnlyState(
      parsed.data.enabled,
      actorFromRequest(req),
      parsed.data.reason,
    );
    res.json(state);
  });

  router.get("/agents", (req: Request, res: Response) => {
    const parsed = agentListSchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: "INVALID_QUERY", details: parsed.error.flatten() });
      return;
    }
    res.json({ agents: listAgentsForAdmin(parsed.data.status) });
  });

  router.post("/agents/:id/enable", (req: Request, res: Response) => {
    const agent = setAgentEnabled(req.params.id, true);
    if (!agent) {
      res.status(404).json({ error: "AGENT_NOT_FOUND" });
      return;
    }
    res.json({ enabled: true, agent });
  });

  router.post("/agents/:id/disable", (req: Request, res: Response) => {
    const agent = setAgentEnabled(req.params.id, false);
    if (!agent) {
      res.status(404).json({ error: "AGENT_NOT_FOUND" });
      return;
    }
    res.json({ enabled: false, agent });
  });

  router.post(
    "/reconciliation/run",
    asyncHandler(async (req: Request, res: Response) => {
      const parsed = reconciliationSchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        res.status(400).json({ error: "INVALID_BODY", details: parsed.error.flatten() });
        return;
      }

      const triggeredBy = parsed.data.triggeredBy as ReconciliationTrigger;
      const report = await reconciliationService.run(triggeredBy);
      res.status(200).json(report);
    }),
  );

  router.post("/maintenance/vacuum", (_req: Request, res: Response) => {
    res.json({ results: vacuumDatabases() });
  });

  router.post(
    "/maintenance/backup",
    asyncHandler(async (req: Request, res: Response) => {
      const parsed = backupSchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        res.status(400).json({ error: "INVALID_BODY", details: parsed.error.flatten() });
        return;
      }

      const results = await backupDatabases(parsed.data.directory);
      res.json({ results });
    }),
  );

  router.get("/audit-log", (req: Request, res: Response) => {
    const parsed = auditLogQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: "INVALID_QUERY", details: parsed.error.flatten() });
      return;
    }

    const entries = listAdminAuditLog(parsed.data.limit, parsed.data.offset);
    if (parsed.data.format === "csv") {
      res.setHeader("Content-Type", "text/csv; charset=utf-8");
      res.send(auditLogToCsv(entries));
      return;
    }
    res.json({ entries });
  });

  router.use("/queue", createAdminQueueRouter(jobQueue));
  router.use("/", createAdminQueueRouter(jobQueue));

  router.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
    logger.error({ err }, "admin operation failed");
    res.status(500).json({
      error: "ADMIN_OPERATION_FAILED",
      message: err.message,
    });
  });

  return router;
}

export function createAdminQueueRouter(queue?: JobQueue): Router {
  const router = Router();
  const jobQueue = queue ?? getGlobalJobQueue();

  /**
   * @openapi
   * /api/admin/queue/status:
   *   get:
   *     summary: Get background job queue status and statistics
   *     description: Returns aggregated metrics on pending, active, completed, failed, and dead-letter jobs along with worker status.
   *     tags: [Admin]
   *     responses:
   *       200:
   *         description: Queue status and metrics
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/QueueStatusResponse'
   *             example:
   *               status: "healthy"
   *               stats:
   *                 queued: 2
   *                 active: 1
   *                 completed: 140
   *                 failed: 1
   *                 deadLetter: 0
   *               worker:
   *                 running: true
   *                 activeWorkers: 1
   *                 concurrency: 5
   *                 pollIntervalMs: 1000
   *               activeJobs: []
   *               deadLetterJobs: []
   */
  router.get("/status", (_req: Request, res: Response) => {
    const stats = jobQueue.getStats();
    const worker = jobQueue.getWorker();
    const active = jobQueue.listJobs({ status: "active", pageSize: 20 });
    const deadLetter = jobQueue.getDeadLetterJobs(1, 20);

    res.json({
      status: "healthy",
      stats,
      worker: worker
        ? worker.getStatus()
        : {
            running: false,
            activeWorkers: 0,
            concurrency: 0,
            pollIntervalMs: 0,
          },
      activeJobs: active.jobs,
      deadLetterJobs: deadLetter.jobs,
    });
  });

  router.get("/", (_req: Request, res: Response) => {
    const stats = jobQueue.getStats();
    const worker = jobQueue.getWorker();
    res.json({
      status: "healthy",
      stats,
      worker: worker
        ? worker.getStatus()
        : {
            running: false,
            activeWorkers: 0,
            concurrency: 0,
            pollIntervalMs: 0,
          },
    });
  });

  /**
   * @openapi
   * /api/admin/queue/jobs:
   *   get:
   *     summary: List background jobs in queue
   *     description: Query jobs filtered by status (queued, active, completed, failed, dead_letter) or taskId with pagination.
   *     tags: [Admin]
   *     parameters:
   *       - in: query
   *         name: status
   *         schema:
   *           type: string
   *           enum: [queued, active, completed, failed, dead_letter]
   *         description: Filter jobs by status
   *       - in: query
   *         name: taskId
   *         schema: { type: string }
   *         description: Filter jobs by associated task ID
   *       - in: query
   *         name: page
   *         schema: { type: integer, default: 1 }
   *       - in: query
   *         name: pageSize
   *         schema: { type: integer, default: 50 }
   *     responses:
   *       200:
   *         description: List of jobs
   *         content:
   *           application/json:
   *             schema:
   *               type: object
   *               properties:
   *                 jobs:
   *                   type: array
   *                   items:
   *                     $ref: '#/components/schemas/QueueJob'
   *                 total: { type: integer }
   *                 page: { type: integer }
   *                 pageSize: { type: integer }
   */
  router.get("/jobs", (req: Request, res: Response) => {
    const status = req.query.status as JobStatus | undefined;
    const taskId = req.query.taskId as string | undefined;
    const page = req.query.page ? Number(req.query.page) : 1;
    const pageSize = req.query.pageSize ? Number(req.query.pageSize) : 50;

    const result = jobQueue.listJobs({ status, taskId, page, pageSize });
    res.json(result);
  });

  /**
   * @openapi
   * /api/admin/queue/dead-letter:
   *   get:
   *     summary: List dead-letter jobs
   *     description: Retrieves jobs that permanently failed after exhausting maximum retry attempts.
   *     tags: [Admin]
   *     parameters:
   *       - in: query
   *         name: page
   *         schema: { type: integer, default: 1 }
   *       - in: query
   *         name: pageSize
   *         schema: { type: integer, default: 50 }
   *     responses:
   *       200:
   *         description: List of dead-letter jobs
   *         content:
   *           application/json:
   *             schema:
   *               type: object
   *               properties:
   *                 jobs:
   *                   type: array
   *                   items:
   *                     $ref: '#/components/schemas/QueueJob'
   *                 total: { type: integer }
   *                 page: { type: integer }
   *                 pageSize: { type: integer }
   */
  router.get("/dead-letter", (req: Request, res: Response) => {
    const page = req.query.page ? Number(req.query.page) : 1;
    const pageSize = req.query.pageSize ? Number(req.query.pageSize) : 50;

    const result = jobQueue.getDeadLetterJobs(page, pageSize);
    res.json(result);
  });

  /**
   * @openapi
   * /api/admin/queue/retry/{id}:
   *   post:
   *     summary: Retry a dead-letter job
   *     description: Resets attempt count and moves a dead-letter job back to queued status for worker processing.
   *     tags: [Admin]
   *     parameters:
   *       - in: path
   *         name: id
   *         required: true
   *         schema: { type: string }
   *         description: Unique Job ID
   *         example: "job_98fe76dc54ba"
   *     responses:
   *       200:
   *         description: Job moved back to queue for retry
   *         content:
   *           application/json:
   *             schema:
   *               type: object
   *               properties:
   *                 success: { type: boolean, example: true }
   *                 message: { type: string, example: "Job job_98fe76dc54ba moved to pending for retry" }
   *       404:
   *         description: Job not found or not in dead-letter state
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/NotFoundError'
   */
  router.post("/retry/:id", (req: Request, res: Response) => {
    const jobId = req.params.id;
    const success = jobQueue.retryDeadLetter(jobId);

    if (!success) {
      res.status(404).json({ error: `Dead-letter job ${jobId} not found or not in dead-letter status` });
      return;
    }

    res.json({ success: true, message: `Job ${jobId} moved to pending for retry` });
  });

  return router;
}
