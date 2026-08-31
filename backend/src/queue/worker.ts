import { createLogger } from "../utils/logger";
import type { Job, JobStore } from "./jobStore";

const logger = createLogger({ component: "job-worker" });

export type JobHandler<T = any, R = any> = (
  job: Job<T>,
  updateProgress: (percentage: number) => void
) => Promise<R>;

export interface JobWorkerOptions {
  jobStore: JobStore;
  handler: JobHandler;
  concurrency?: number;
  pollIntervalMs?: number;
  baseBackoffMs?: number;
  maxAttempts?: number;
  autoStart?: boolean;
}

export class JobWorker {
  private readonly store: JobStore;
  private readonly handler: JobHandler;
  private readonly concurrency: number;
  private readonly pollIntervalMs: number;
  private readonly baseBackoffMs: number;
  private readonly maxAttempts: number;

  private isRunning = false;
  private activeJobsCount = 0;
  private pollTimer: NodeJS.Timeout | null = null;
  private processingPromise: Promise<void> | null = null;

  // Event handlers
  public onJobStarted?: (job: Job) => void;
  public onJobCompleted?: (job: Job, result: any) => void;
  public onJobFailed?: (job: Job, error: Error, willRetry: boolean, nextRunAt?: string) => void;
  public onJobDeadLetter?: (job: Job, error: Error) => void;
  public onJobProgress?: (job: Job, progress: number) => void;

  constructor(options: JobWorkerOptions) {
    this.store = options.jobStore;
    this.handler = options.handler;
    this.concurrency = options.concurrency ?? 3;
    this.pollIntervalMs = options.pollIntervalMs ?? 100;
    this.baseBackoffMs = options.baseBackoffMs ?? 1000;
    this.maxAttempts = options.maxAttempts ?? 3;

    if (options.autoStart) {
      this.start();
    }
  }

  public start(): void {
    if (this.isRunning) return;
    this.isRunning = true;

    logger.info(
      { concurrency: this.concurrency, pollIntervalMs: this.pollIntervalMs },
      "starting job worker"
    );

    // On worker startup, resume/recover incomplete jobs from previous run
    try {
      this.store.recoverIncompleteJobs();
    } catch (err) {
      logger.error({ err }, "error recovering incomplete jobs on startup");
    }

    this.scheduleNextPoll(0);
  }

  public async stop(timeoutMs = 10_000): Promise<void> {
    if (!this.isRunning) return;
    this.isRunning = false;

    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }

    logger.info({ activeJobs: this.activeJobsCount }, "stopping job worker");

    const start = Date.now();
    while (this.activeJobsCount > 0 && Date.now() - start < timeoutMs) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }

    if (this.activeJobsCount > 0) {
      logger.warn(
        { activeJobs: this.activeJobsCount },
        "job worker stopped with in-flight jobs still active"
      );
    } else {
      logger.info("job worker stopped cleanly");
    }
  }

  public trigger(): void {
    if (!this.isRunning) return;
    // Process next available jobs immediately
    setImmediate(() => {
      this.processJobs();
    });
  }

  public getActiveCount(): number {
    return this.activeJobsCount;
  }

  public getConcurrency(): number {
    return this.concurrency;
  }

  public getStatus(): {
    running: boolean;
    activeWorkers: number;
    concurrency: number;
    pollIntervalMs: number;
  } {
    return {
      running: this.isRunning,
      activeWorkers: this.activeJobsCount,
      concurrency: this.concurrency,
      pollIntervalMs: this.pollIntervalMs,
    };
  }

  private scheduleNextPoll(delayMs = this.pollIntervalMs): void {
    if (!this.isRunning) return;
    if (this.pollTimer) clearTimeout(this.pollTimer);

    this.pollTimer = setTimeout(() => {
      this.processJobs();
    }, delayMs);
  }

  private async processJobs(): Promise<void> {
    if (!this.isRunning) return;

    try {
      while (this.isRunning && this.activeJobsCount < this.concurrency) {
        const job = this.store.getNextPendingJob();
        if (!job) break;

        // Atomically mark job as active
        this.store.updateStatus(job.id, "active");
        this.activeJobsCount++;

        // Execute job in background
        this.executeJob(job)
          .catch((err) => {
            logger.error({ jobId: job.id, err }, "unhandled error in executeJob");
          })
          .finally(() => {
            this.activeJobsCount--;
            this.trigger();
          });
      }
    } catch (err) {
      logger.error({ err }, "error in worker job polling loop");
    } finally {
      this.scheduleNextPoll();
    }
  }

  private async executeJob(job: Job): Promise<void> {
    logger.info({ jobId: job.id, taskId: job.taskId, attempt: job.attempts + 1 }, "processing job");

    this.onJobStarted?.(job);

    const updateProgress = (percentage: number) => {
      const clamped = Math.max(0, Math.min(100, Math.round(percentage)));
      this.store.updateProgress(job.id, clamped);
      this.onJobProgress?.(job, clamped);
    };

    try {
      const result = await this.handler(job, updateProgress);

      const now = new Date().toISOString();
      this.store.updateStatus(job.id, "completed", {
        progress: 100,
        completedAt: now,
      });

      logger.info({ jobId: job.id, taskId: job.taskId }, "job completed successfully");
      this.onJobCompleted?.(job, result);
    } catch (error: any) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      const attempts = job.attempts + 1;
      const maxAllowedAttempts = job.maxAttempts || this.maxAttempts;
      const now = new Date().toISOString();

      if (attempts < maxAllowedAttempts) {
        // Exponential backoff: base * 2^(attempt - 1)
        const delayMs = this.baseBackoffMs * Math.pow(2, attempts - 1);
        const nextRunAt = new Date(Date.now() + delayMs).toISOString();

        this.store.updateStatus(job.id, "failed", {
          attempts,
          lastError: errorMessage,
          nextRunAt,
        });

        logger.warn(
          {
            jobId: job.id,
            taskId: job.taskId,
            attempts,
            maxAllowedAttempts,
            nextRunAt,
            err: errorMessage,
          },
          "job failed, scheduled for retry"
        );

        this.onJobFailed?.(job, error, true, nextRunAt);
      } else {
        // Exceeded max retry attempts -> move to dead-letter queue
        this.store.updateStatus(job.id, "dead-letter", {
          attempts,
          lastError: errorMessage,
          failedAt: now,
        });

        logger.error(
          {
            jobId: job.id,
            taskId: job.taskId,
            attempts,
            err: errorMessage,
          },
          "job permanently failed, moved to dead-letter queue"
        );

        this.onJobFailed?.(job, error, false);
        this.onJobDeadLetter?.(job, error);
      }
    }
  }
}
