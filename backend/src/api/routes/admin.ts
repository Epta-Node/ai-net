import { Router, Request, Response } from "express";
import { getGlobalJobQueue, type JobQueue, type JobStatus } from "../../queue";

export function createAdminQueueRouter(queue?: JobQueue): Router {
  const router = Router();
  const jobQueue = queue ?? getGlobalJobQueue();

  /**
   * @openapi
   * /api/admin/queue/status:
   *   get:
   *     summary: Get background job queue status and statistics
   *     tags: [Admin]
   *     responses:
   *       200:
   *         description: Queue status and metrics
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
   *     summary: List jobs in queue with optional status filter
   *     tags: [Admin]
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
   *     tags: [Admin]
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
   *     tags: [Admin]
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
