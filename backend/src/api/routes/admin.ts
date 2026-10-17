import { Router, type NextFunction, type Request, type Response } from "express";
import { z } from "zod";
import { getGlobalJobQueue, type JobQueue, type JobStatus } from "../../queue";
import { tracingService } from "../../services/tracing";
import { adminAuthMiddleware } from "../middleware/auth";
import {
  AUDIT_EXPORT_MAX_ROWS,
  AUDIT_LOG_CSV_HEADER,
  actorFromRequest,
  auditLogEntryToCsvRow,
  auditLogToCsv,
  backupDatabases,
  getReadOnlyState,
  listAdminAuditLog,
  iterateAdminAuditLog,
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
import { ValidationError, NotFoundError, AppError } from "../../errors";

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

const auditLogExportQuerySchema = z.object({
  format: z.enum(["json", "csv"]).default("json"),
  limit: z.coerce.number().int().min(1).max(AUDIT_EXPORT_MAX_ROWS).default(AUDIT_EXPORT_MAX_ROWS),
});

const reconciliationSchema = z.object({
  triggeredBy: z.enum(["manual", "scheduled", "release"]).default("manual"),
});

const backupSchema = z.object({
  directory: z.string().min(1).optional(),
});

/** Shared query-string schema for the paginated job-listing endpoints. */
const jobListQuerySchema = z.object({
  status: z
    .enum(["pending", "active", "completed", "failed", "dead-letter"])
    .optional(),
  taskId: z.string().min(1).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(50),
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
      target: req.params?.id,
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

  router.use(adminAuthMiddleware);
  router.use(auditAdminRequests);

  /**
   * @openapi
   * /api/admin/read-only:
   *   get:
   *     summary: Get read-only mode state
   *     operationId: getReadOnlyMode
   *     description: Reports whether mutations are currently disabled, and by whom.
   *     tags: [Admin]
   *     security:
   *       - adminApiKey: []
   *     responses:
   *       200:
   *         description: Current read-only state
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/ReadOnlyState'
   *       401:
   *         description: Missing or invalid admin API key
   *       503:
   *         description: ADMIN_API_KEY is not configured
   *   put:
   *     summary: Set read-only mode
   *     operationId: setReadOnlyMode
   *     description: Enables or disables read-only mode. While enabled every mutation outside `/api/admin` and `/api/reconciliation` responds 503.
   *     tags: [Admin]
   *     security:
   *       - adminApiKey: []
   *     requestBody:
   *       required: true
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *             required: [enabled]
   *             properties:
   *               enabled: { type: boolean }
   *               reason: { type: string, maxLength: 500 }
   *     responses:
   *       200:
   *         description: Read-only state updated
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/ReadOnlyState'
   *       400:
   *         description: Invalid request body
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/ValidationError'
   *       401:
   *         description: Missing or invalid admin API key
   *       503:
   *         description: ADMIN_API_KEY is not configured
   */
  router.get("/read-only", (_req: Request, res: Response) => {
    res.json(getReadOnlyState());
  });

  router.put("/read-only", (req: Request, res: Response, next: NextFunction) => {
    const parsed = readOnlySchema.safeParse(req.body);
    if (!parsed.success) {
      next(new ValidationError(
        "Invalid request body",
        { issues: parsed.error.flatten() },
        res.locals.correlationId as string | undefined,
      ));
      return;
    }

    const state = setReadOnlyState(
      parsed.data.enabled,
      actorFromRequest(req),
      parsed.data.reason,
    );
    res.json(state);
  });

  /**
   * @openapi
   * /api/admin/agents:
   *   get:
   *     summary: List agents for administration
   *     operationId: listAdminAgents
   *     description: Returns the agent registry from the operator's point of view, including enable/disable state.
   *     tags: [Admin, Agents]
   *     security:
   *       - adminApiKey: []
   *     parameters:
   *       - in: query
   *         name: status
   *         schema: { type: string, enum: [online, offline] }
   *         description: Filter agents by presence status
   *     responses:
   *       200:
   *         description: Agents with administrative state
   *       400:
   *         description: Invalid query parameters
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/ValidationError'
   *       401:
   *         description: Missing or invalid admin API key
   *       503:
   *         description: ADMIN_API_KEY is not configured
   */
  router.get("/agents", (req: Request, res: Response, next: NextFunction) => {
    const parsed = agentListSchema.safeParse(req.query);
    if (!parsed.success) {
      next(new ValidationError(
        "Invalid query parameters",
        { issues: parsed.error.flatten() },
        res.locals.correlationId as string | undefined,
      ));
      return;
    }
    res.json({ agents: listAgentsForAdmin(parsed.data.status) });
  });

  /**
   * @openapi
   * /api/admin/agents/{id}/enable:
   *   post:
   *     summary: Enable an agent
   *     operationId: enableAgent
   *     description: Re-enables a previously disabled agent in the registry.
   *     tags: [Admin, Agents]
   *     security:
   *       - adminApiKey: []
   *     parameters:
   *       - in: path
   *         name: id
   *         required: true
   *         schema: { type: string }
   *         description: Unique agent identifier
   *     responses:
   *       200:
   *         description: Agent enabled
   *       404:
   *         description: Agent not found
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/NotFoundError'
   *       401:
   *         description: Missing or invalid admin API key
   *       503:
   *         description: ADMIN_API_KEY is not configured
   */
  router.post("/agents/:id/enable", (req: Request, res: Response, next: NextFunction) => {
    const agent = setAgentEnabled(req.params.id, true);
    if (!agent) {
      next(new NotFoundError("Agent", req.params.id, undefined, res.locals.correlationId as string | undefined));
      return;
    }
    res.json({ enabled: true, agent });
  });

  /**
   * @openapi
   * /api/admin/agents/{id}/disable:
   *   post:
   *     summary: Disable an agent
   *     operationId: disableAgent
   *     description: Stops dispatching new work to the agent without removing it from the registry.
   *     tags: [Admin, Agents]
   *     security:
   *       - adminApiKey: []
   *     parameters:
   *       - in: path
   *         name: id
   *         required: true
   *         schema: { type: string }
   *         description: Unique agent identifier
   *     responses:
   *       200:
   *         description: Agent disabled
   *       404:
   *         description: Agent not found
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/NotFoundError'
   *       401:
   *         description: Missing or invalid admin API key
   *       503:
   *         description: ADMIN_API_KEY is not configured
   */
  router.post("/agents/:id/disable", (req: Request, res: Response, next: NextFunction) => {
    const agent = setAgentEnabled(req.params.id, false);
    if (!agent) {
      next(new NotFoundError("Agent", req.params.id, undefined, res.locals.correlationId as string | undefined));
      return;
    }
    res.json({ enabled: false, agent });
  });

  /**
   * @openapi
   * /api/admin/reconciliation/run:
   *   post:
   *     summary: Trigger a payment reconciliation run
   *     operationId: runAdminReconciliation
   *     description: >
   *       Runs payment reconciliation and returns the report. Equivalent to
   *       `POST /api/reconciliation/run`, reachable under the `/api/admin`
   *       control-plane prefix alongside the other operator endpoints.
   *     tags: [Admin, Reconciliation]
   *     security:
   *       - adminApiKey: []
   *     requestBody:
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *             properties:
   *               triggeredBy:
   *                 type: string
   *                 enum: [manual, scheduled, release]
   *                 default: manual
   *     responses:
   *       200:
   *         description: Reconciliation report for this run
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/ReconciliationReport'
   *       400:
   *         description: Invalid request body
   *       401:
   *         description: Missing or invalid admin API key
   *       503:
   *         description: ADMIN_API_KEY is not configured
   */
  router.post(
    "/reconciliation/run",
    asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
      const parsed = reconciliationSchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        next(new ValidationError(
          "Invalid request body",
          { issues: parsed.error.flatten() },
          res.locals.correlationId as string | undefined,
        ));
        return;
      }

      const triggeredBy = parsed.data.triggeredBy as ReconciliationTrigger;
      const report = await reconciliationService.run(triggeredBy);
      res.status(200).json(report);
    }),
  );

  /**
   * @openapi
   * /api/admin/maintenance/vacuum:
   *   post:
   *     summary: Vacuum the application databases
   *     operationId: vacuumDatabases
   *     description: Runs `VACUUM` across the task, payment, agent, job and auth databases to reclaim space and defragment indexes.
   *     tags: [Admin, Maintenance]
   *     security:
   *       - adminApiKey: []
   *     responses:
   *       200:
   *         description: Per-database vacuum results
   *       401:
   *         description: Missing or invalid admin API key
   *       503:
   *         description: ADMIN_API_KEY is not configured
   */
  router.post("/maintenance/vacuum", (_req: Request, res: Response) => {
    res.json({ results: vacuumDatabases() });
  });

  /**
   * @openapi
   * /api/admin/maintenance/backup:
   *   post:
   *     summary: Back up the application databases
   *     operationId: backupDatabases
   *     description: Copies the SQLite database files to a backup directory. Omit `directory` to use the configured default.
   *     tags: [Admin, Maintenance]
   *     security:
   *       - adminApiKey: []
   *     requestBody:
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *             properties:
   *               directory:
   *                 type: string
   *                 minLength: 1
   *                 description: Target directory for the backup
   *     responses:
   *       200:
   *         description: Per-database backup results
   *       400:
   *         description: Invalid request body
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/ValidationError'
   *       401:
   *         description: Missing or invalid admin API key
   *       503:
   *         description: ADMIN_API_KEY is not configured
   */
  router.post(
    "/maintenance/backup",
    asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
      const parsed = backupSchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        next(new ValidationError(
          "Invalid request body",
          { issues: parsed.error.flatten() },
          res.locals.correlationId as string | undefined,
        ));
        return;
      }

      const results = await backupDatabases(parsed.data.directory);
      res.json({ results });
    }),
  );

  /**
   * @openapi
   * /api/admin/audit-log:
   *   get:
   *     summary: Read the administrative audit log
   *     operationId: getAdminAuditLog
   *     description: Every mutating admin request is recorded with actor, target and status code. Set `format=csv` to download it.
   *     tags: [Admin]
   *     security:
   *       - adminApiKey: []
   *     parameters:
   *       - in: query
   *         name: limit
   *         schema: { type: integer, minimum: 1, maximum: 1000, default: 200 }
   *       - in: query
   *         name: offset
   *         schema: { type: integer, minimum: 0, default: 0 }
   *       - in: query
   *         name: format
   *         schema: { type: string, enum: [json, csv], default: json }
   *         description: Set to csv for a downloadable comma-separated log
   *     responses:
   *       200:
   *         description: Audit log entries (JSON, or CSV when `format=csv`)
   *       400:
   *         description: Invalid query parameters
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/ValidationError'
   *       401:
   *         description: Missing or invalid admin API key
   *       503:
   *         description: ADMIN_API_KEY is not configured
   */
  router.get("/audit-log", (req: Request, res: Response, next: NextFunction) => {
    const parsed = auditLogQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      next(new ValidationError(
        "Invalid query parameters",
        { issues: parsed.error.flatten() },
        res.locals.correlationId as string | undefined,
      ));
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

  /**
   * @openapi
   * /api/admin/audit-log/export:
   *   get:
   *     summary: Export the administrative audit log
   *     operationId: exportAdminAuditLog
   *     description: >
   *       Streams the audit log newest-first in bounded batches for compliance
   *       review. CSV cells that could be read as spreadsheet formulas are
   *       neutralised. The export request itself is recorded in the audit log.
   *     tags: [Admin]
   *     security:
   *       - adminApiKey: []
   *     parameters:
   *       - in: query
   *         name: format
   *         schema: { type: string, enum: [json, csv], default: json }
   *       - in: query
   *         name: limit
   *         schema: { type: integer, minimum: 1, maximum: 100000, default: 100000 }
   *         description: Maximum number of entries to export
   *     responses:
   *       200:
   *         description: Streamed audit log (`{ "entries": [...] }` for JSON, or CSV)
   *       400:
   *         description: Invalid query parameters
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/ValidationError'
   *       401:
   *         description: Missing or invalid admin API key
   *       503:
   *         description: ADMIN_API_KEY is not configured
   */
  router.get(
    "/audit-log/export",
    asyncHandler(async (req: Request, res: Response) => {
      const parsed = auditLogExportQuerySchema.safeParse(req.query);
      if (!parsed.success) {
        throw new ValidationError(
          "Invalid query parameters",
          { issues: parsed.error.flatten() },
          res.locals.correlationId as string | undefined,
        );
      }
      const { format, limit } = parsed.data;

      // Honour backpressure so a slow client cannot make the server buffer the export.
      const write = async (chunk: string): Promise<void> => {
        if (res.write(chunk)) return;
        await new Promise<void>((resolve) => {
          const done = () => {
            res.off("drain", done);
            res.off("close", done);
            resolve();
          };
          res.once("drain", done);
          res.once("close", done);
        });
      };

      res.setHeader(
        "Content-Type",
        format === "csv" ? "text/csv; charset=utf-8" : "application/json; charset=utf-8",
      );
      res.setHeader("Content-Disposition", `attachment; filename="audit-log.${format}"`);

      try {
        await write(format === "csv" ? `${AUDIT_LOG_CSV_HEADER}\n` : '{"entries":[');
        let first = true;
        for (const batch of iterateAdminAuditLog(limit)) {
          if (res.destroyed) return;
          const chunk =
            format === "csv"
              ? batch.map((entry) => `${auditLogEntryToCsvRow(entry)}\n`).join("")
              : `${first ? "" : ","}${batch.map((entry) => JSON.stringify(entry)).join(",")}`;
          first = false;
          await write(chunk);
        }
        if (format === "json") await write("]}");
        res.end();
      } catch (err) {
        if (!res.headersSent) {
          res.removeHeader("Content-Disposition");
          throw err;
        }
        // Headers are already sent once streaming starts, so abort the response.
        logger.error({ err }, "audit log export failed");
        res.destroy();
      }
    }),
  );

  // The queue sub-router is mounted once, at `/api/admin/queue`, by the app
  // factory. Mounting it here as well used to expose a duplicated
  // `/api/admin/queue/queue/*` tree and shadowed the canonical paths.
  router.use("/", createAdminQueueRouter(jobQueue));

  router.use((err: Error, _req: Request, _res: Response, next: NextFunction) => {
    logger.error({ err }, "admin operation failed");
    next(err instanceof AppError ? err : new AppError("Admin operation failed", 500, "INTERNAL_ERROR"));
  });

  return router;
}

export function createAdminQueueRouter(queue?: JobQueue): Router {
  const router = Router();
  const jobQueue = queue ?? getGlobalJobQueue();

  router.use(adminAuthMiddleware);

  /**
   * @openapi
   * /api/admin/traces/{id}:
   *   get:
   *     summary: Retrieve a distributed trace by traceId or requestId
   *     operationId: getAdminTrace
   *     description: >
   *       Returns the correlated spans for a given traceId (correlationId) or
   *       requestId. Accepts either identifier and resolves it to the trace.
   *       Requires admin authentication via `X-Admin-API-Key` or
   *       `Authorization: Bearer`.
   *     tags: [Admin]
   *     security:
   *       - adminApiKey: []
   *     parameters:
   *       - in: path
   *         name: id
   *         required: true
   *         schema: { type: string }
   *         description: traceId (correlationId) or requestId to look up
   *     responses:
   *       200:
   *         description: Trace found
   *         content:
   *           application/json:
   *             schema:
   *               type: object
   *               properties:
   *                 correlationId: { type: string }
   *                 spans: { type: array }
   *                 startedAt: { type: string }
   *                 endedAt: { type: string }
   *                 totalDurationMs: { type: number }
   *       404:
   *         description: No trace found for the given id
   *       401:
   *         description: Missing or invalid admin API key
   *       503:
   *         description: ADMIN_API_KEY is not configured
   */
  router.get("/traces/:id", (req: Request, res: Response) => {
    const id = req.params.id;

    // Resolve requestId → correlationId when the id is not already a trace.
    const correlationId = tracingService.resolveRequestId(id) ?? id;

    const trace = tracingService.getTrace(correlationId);
    if (!trace) {
      res.status(404).json({ error: "Trace not found", id });
      return;
    }

    res.json({ ...trace, requestedId: id });
  });

  /**
   * @openapi
   * /api/admin/queue/status:
   *   get:
   *     summary: Get background job queue status and statistics
   *     description: Returns aggregated metrics on pending, active, completed, failed, and dead-letter jobs along with worker status.
   *     tags: [Admin]
   *     security:
   *       - adminApiKey: []
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

  /**
   * @openapi
   * /api/admin/queue:
   *   get:
   *     summary: Queue status (index alias)
   *     operationId: getQueueIndex
   *     description: >
   *       Index alias of `GET /api/admin/queue/status`, returning only the
   *       summary counters and worker status (no active-job listing). Registered
   *       on the queue router root, so it is reachable at both `/api/admin/queue`
   *       and `/api/admin`.
   *     tags: [Admin]
   *     security:
   *       - adminApiKey: []
   *     responses:
   *       200:
   *         description: Queue status and worker metrics
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/QueueStatusResponse'
   *       401:
   *         description: Missing or invalid admin API key
   *       503:
   *         description: ADMIN_API_KEY is not configured
   */
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
   * The queue router is also mounted at the `/api/admin` root, so every
   * operation above is reachable both under `/api/admin/queue/*` (canonical)
   * and under `/api/admin/*` (alias). Documented here so the spec matches the
   * routes that are actually registered.
   *
   * @openapi
   * /api/admin:
   *   get:
   *     summary: Queue status (admin-root alias)
   *     operationId: getAdminRootQueueIndex
   *     description: Alias of `GET /api/admin/queue` reached at the admin root.
   *     tags: [Admin]
   *     security:
   *       - adminApiKey: []
   *     responses:
   *       200:
   *         description: Queue status and worker metrics
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/QueueStatusResponse'
   *       401:
   *         description: Missing or invalid admin API key
   *       503:
   *         description: ADMIN_API_KEY is not configured
   * /api/admin/status:
   *   get:
   *     summary: Get background job queue status and statistics (admin-root alias)
   *     operationId: getAdminRootQueueStatus
   *     description: Alias of `GET /api/admin/queue/status` reached at the admin root.
   *     tags: [Admin]
   *     security:
   *       - adminApiKey: []
   *     responses:
   *       200:
   *         description: Queue status and metrics
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/QueueStatusResponse'
   *       401:
   *         description: Missing or invalid admin API key
   *       503:
   *         description: ADMIN_API_KEY is not configured
   * /api/admin/jobs:
   *   get:
   *     summary: List background jobs in queue (admin-root alias)
   *     operationId: getAdminRootQueueJobs
   *     description: Alias of `GET /api/admin/queue/jobs` reached at the admin root.
   *     tags: [Admin]
   *     security:
   *       - adminApiKey: []
   *     parameters:
   *       - in: query
   *         name: status
   *         schema:
   *           type: string
   *           enum: [queued, active, completed, failed, dead_letter]
   *       - in: query
   *         name: taskId
   *         schema: { type: string }
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
   *       401:
   *         description: Missing or invalid admin API key
   *       503:
   *         description: ADMIN_API_KEY is not configured
   * /api/admin/dead-letter:
   *   get:
   *     summary: List dead-letter jobs (admin-root alias)
   *     operationId: getAdminRootDeadLetter
   *     description: Alias of `GET /api/admin/queue/dead-letter` reached at the admin root.
   *     tags: [Admin]
   *     security:
   *       - adminApiKey: []
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
   *       401:
   *         description: Missing or invalid admin API key
   *       503:
   *         description: ADMIN_API_KEY is not configured
   * /api/admin/retry/{id}:
   *   post:
   *     summary: Retry a dead-letter job (admin-root alias)
   *     operationId: postAdminRootQueueRetry
   *     description: Alias of `POST /api/admin/queue/retry/{id}` reached at the admin root.
   *     tags: [Admin]
   *     security:
   *       - adminApiKey: []
   *     parameters:
   *       - in: path
   *         name: id
   *         required: true
   *         schema: { type: string }
   *         description: Unique Job ID
   *     responses:
   *       200:
   *         description: Job moved back to queue for retry
   *       404:
   *         description: Job not found or not in dead-letter state
   *       401:
   *         description: Missing or invalid admin API key
   *       503:
   *         description: ADMIN_API_KEY is not configured
   * /api/admin/queue/traces/{id}:
   *   get:
   *     summary: Retrieve a distributed trace (queue-prefixed alias)
   *     operationId: getAdminQueueTrace
   *     description: Alias of `GET /api/admin/traces/{id}` reachable under the queue prefix.
   *     tags: [Admin]
   *     security:
   *       - adminApiKey: []
   *     parameters:
   *       - in: path
   *         name: id
   *         required: true
   *         schema: { type: string }
   *         description: traceId (correlationId) or requestId to look up
   *     responses:
   *       200:
   *         description: Trace found
   *       404:
   *         description: No trace found for the given id
   *       401:
   *         description: Missing or invalid admin API key
   *       503:
   *         description: ADMIN_API_KEY is not configured
   */

  /**
   * @openapi
   * /api/admin/queue/jobs:
   *   get:
   *     summary: List background jobs in queue
   *     description: Query jobs filtered by status (queued, active, completed, failed, dead_letter) or taskId with pagination.
   *     tags: [Admin]
   *     security:
   *       - adminApiKey: []
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
  router.get("/jobs", (req: Request, res: Response, next: NextFunction) => {
    const parsed = jobListQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      next(new ValidationError(
        "Invalid query parameters",
        { issues: parsed.error.flatten() },
        res.locals.correlationId as string | undefined,
      ));
      return;
    }

    const { status, taskId, page, pageSize } = parsed.data;
    const result = jobQueue.listJobs({ status: status as JobStatus | undefined, taskId, page, pageSize });
    res.json(result);
  });

  /**
   * @openapi
   * /api/admin/queue/dead-letter:
   *   get:
   *     summary: List dead-letter jobs
   *     description: Retrieves jobs that permanently failed after exhausting maximum retry attempts.
   *     tags: [Admin]
   *     security:
   *       - adminApiKey: []
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
  router.get("/dead-letter", (req: Request, res: Response, next: NextFunction) => {
    const parsed = jobListQuerySchema
      .pick({ page: true, pageSize: true })
      .safeParse(req.query);
    if (!parsed.success) {
      next(new ValidationError(
        "Invalid query parameters",
        { issues: parsed.error.flatten() },
        res.locals.correlationId as string | undefined,
      ));
      return;
    }

    const { page, pageSize } = parsed.data;
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
   *     security:
   *       - adminApiKey: []
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