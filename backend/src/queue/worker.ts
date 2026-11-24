import os from "os";
import { nanoid } from "nanoid";
import { createLogger } from "../utils/logger";
import type { Job, JobLease, JobStore } from "./jobStore";
import {
  DEFAULT_JOB_BACKOFF_MAX_MS,
  computeBackoffDelayMs,
  recordJobDeadLetter,
  recordJobRetry,
  recordRetryLag,
  type RandomFn,
} from "./backoff";
import { DeadLetterQueue } from "./dlq";

const logger = createLogger({ component: "job-worker" });

/**
 * How long a worker's claim on a job stays valid without a heartbeat before
 * startup recovery may hand it to someone else (issue #648).
 *
 * Deliberately well above {@link DEFAULT_JOB_LEASE_HEARTBEAT_MS}: a job is
 * renewed three times before its lease could lapse, so one late or dropped
 * heartbeat can never cause a running job to be reclaimed and executed twice.
 */
export const DEFAULT_JOB_LEASE_TTL_MS = 30_000;

/**
 * How often a worker renews the leases on the jobs it is processing.
 *
 * A third of the default TTL, which is also the ratio `JOB_LEASE_TTL_MS` /
 * `JOB_LEASE_HEARTBEAT_MS` ships with.
 */
export const DEFAULT_JOB_LEASE_HEARTBEAT_MS = 10_000;

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
  /** Ceiling for a single retry delay (issue #752). Defaults to five minutes. */
  maxBackoffMs?: number;
  maxAttempts?: number;
  /** Randomness source for backoff jitter; defaults to `Math.random`. */
  random?: RandomFn;
  autoStart?: boolean;
  /**
   * Unique id stamped on every job this worker claims, so its heartbeats and
   * shutdown only ever touch its own rows (issue #648). Defaults to
   * `<hostname>-<pid>-<random>`, which is unique per process even when several
   * workers share one SQLite file.
   */
  workerId?: string;
  /**
   * How long this worker's claim on a job stays valid without a heartbeat.
   * Defaults to {@link DEFAULT_JOB_LEASE_TTL_MS}.
   */
  leaseTtlMs?: number;
  /**
   * How often to renew the lease while a job runs. Defaults to a third of
   * `leaseTtlMs` (or {@link DEFAULT_JOB_LEASE_HEARTBEAT_MS} at the default TTL).
   */
  leaseHeartbeatMs?: number;
}

export class JobWorker {
  private readonly store: JobStore;
  private readonly handler: JobHandler;
  private readonly concurrency: number;
  private readonly pollIntervalMs: number;
  private readonly baseBackoffMs: number;
  private readonly maxBackoffMs: number;
  private readonly random: RandomFn;
  private readonly maxAttempts: number;
  private readonly leaseTtlMs: number;
  private readonly leaseHeartbeatMs: number;
  /**
   * Where jobs go once their retry budget is gone (issue #802). Shares this
   * worker's store, so the park is the same atomic status transition the
   * worker already relied on — plus the `job.dead_lettered` event emission.
   */
  private readonly deadLetterQueue: DeadLetterQueue;

  /** Id stamped on every lease this worker takes (issue #648). */
  public readonly workerId: string;

  /** Lease-renewal timers for the jobs currently being processed, by job id. */
  private readonly leaseHeartbeatTimers = new Map<string, NodeJS.Timeout>();

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
    this.maxBackoffMs = options.maxBackoffMs ?? DEFAULT_JOB_BACKOFF_MAX_MS;
    this.random = options.random ?? Math.random;
    this.maxAttempts = options.maxAttempts ?? 3;
    this.leaseTtlMs = options.leaseTtlMs ?? DEFAULT_JOB_LEASE_TTL_MS;
    // Default the heartbeat to a third of the TTL; an explicit interval is
    // honoured as-is (operators and tests tune it) but a heartbeat that is not
    // shorter than the TTL would let a live job's lease lapse between renewals.
    this.leaseHeartbeatMs =
      options.leaseHeartbeatMs ?? Math.max(1, Math.floor(this.leaseTtlMs / 3));
    if (this.leaseHeartbeatMs >= this.leaseTtlMs) {
      logger.warn(
        { leaseHeartbeatMs: this.leaseHeartbeatMs, leaseTtlMs: this.leaseTtlMs },
        "lease heartbeat interval is not shorter than the lease TTL; running jobs risk being reclaimed as expired"
      );
    }
    this.workerId = options.workerId ?? `${os.hostname()}-${process.pid}-${nanoid(6)}`;
    this.deadLetterQueue = new DeadLetterQueue(this.store, { emitEvents: true });

    if (options.autoStart) {
      this.start();
    }
  }

  public start(): void {
    if (this.isRunning) return;
    this.isRunning = true;

    logger.info(
      {
        concurrency: this.concurrency,
        pollIntervalMs: this.pollIntervalMs,
        workerId: this.workerId,
        leaseTtlMs: this.leaseTtlMs,
        leaseHeartbeatMs: this.leaseHeartbeatMs,
      },
      "starting job worker"
    );

    // On worker startup, resume/recover jobs whose lease has expired
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

    // Hand back every lease this worker still holds (issue #648). Jobs that
    // finished during the drain already cleared theirs; anything left is work
    // this process will never complete, and a `NULL` lease lets the next
    // recovery pass resume it instead of waiting out a full TTL.
    this.releaseLeases();
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
    /** Number of jobs this worker currently holds a lease and heartbeat for. */
    activeLeases: number;
  } {
    return {
      running: this.isRunning,
      activeWorkers: this.activeJobsCount,
      concurrency: this.concurrency,
      pollIntervalMs: this.pollIntervalMs,
      activeLeases: this.leaseHeartbeatTimers.size,
    };
  }

  /** A fresh lease for this worker, expiring one TTL from now (issue #648). */
  private newLease(): JobLease {
    return {
      owner: this.workerId,
      expiresAt: new Date(Date.now() + this.leaseTtlMs).toISOString(),
    };
  }

  /**
   * Start renewing this worker's lease on `jobId` for as long as it runs.
   *
   * The timer is `unref`ed so a background renewal never keeps the process (or
   * a Jest worker) alive by itself.
   */
  private startLeaseHeartbeat(jobId: string): void {
    this.clearLeaseHeartbeat(jobId);

    const timer = setInterval(() => {
      try {
        const renewed = this.store.extendLease(jobId, this.workerId, this.newLease().expiresAt);
        if (!renewed) {
          // The job finished, or another worker reclaimed it as expired. Stop
          // renewing rather than fight over a lease we no longer hold.
          logger.warn(
            { jobId, workerId: this.workerId },
            "job lease is no longer owned by this worker; stopping its heartbeat"
          );
          this.clearLeaseHeartbeat(jobId);
        }
      } catch (err) {
        // Never let a database hiccup escape an interval callback: an unhandled
        // throw here would take the process down.
        logger.error({ jobId, err }, "failed to renew job lease");
      }
    }, this.leaseHeartbeatMs);

    timer.unref?.();
    this.leaseHeartbeatTimers.set(jobId, timer);
  }

  private clearLeaseHeartbeat(jobId: string): void {
    const timer = this.leaseHeartbeatTimers.get(jobId);
    if (!timer) return;
    clearInterval(timer);
    this.leaseHeartbeatTimers.delete(jobId);
  }

  /** Drop the leases on every job this worker still owns (graceful stop only). */
  private releaseLeases(): void {
    for (const jobId of [...this.leaseHeartbeatTimers.keys()]) {
      this.clearLeaseHeartbeat(jobId);
      try {
        this.store.releaseLease(jobId, this.workerId);
      } catch (err) {
        logger.error({ jobId, err }, "failed to release job lease on shutdown");
      }
    }
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
        // Atomic claim: a single conditional UPDATE inside a BEGIN IMMEDIATE
        // transaction, so two workers — or two processes over the same SQLite
        // file — can never be handed the same row and run the handler twice.
        // The same statement takes the lease, so the row is owned from the
        // instant it turns 'active' (#648). `undefined` means nothing is
        // runnable right now.
        const job = this.store.claimNextPendingJob(undefined, this.newLease());
        if (!job) break;

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

    if (job.attempts > 0 && job.nextRunAt) {
      const scheduledAt = Date.parse(job.nextRunAt);
      if (!Number.isNaN(scheduledAt)) recordRetryLag(Date.now() - scheduledAt);
    }

    this.onJobStarted?.(job);

    // Keep the lease alive for as long as the handler runs, so a liveness pass
    // in another instance never mistakes this job for an orphan (#648).
    this.startLeaseHeartbeat(job.id);

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
        expectedStatus: "active",
      });

      logger.info({ jobId: job.id, taskId: job.taskId }, "job completed successfully");
      this.onJobCompleted?.(job, result);
    } catch (error: any) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      const attempts = job.attempts + 1;
      const maxAllowedAttempts = job.maxAttempts || this.maxAttempts;

      if (attempts < maxAllowedAttempts) {
        // Full-jitter exponential backoff: random(0, min(cap, base * 2^(attempt - 1)))
        const delayMs = computeBackoffDelayMs(
          attempts,
          this.baseBackoffMs,
          this.maxBackoffMs,
          this.random
        );
        const nextRunAt = new Date(Date.now() + delayMs).toISOString();

        this.store.updateStatus(job.id, "failed", {
          attempts,
          lastError: errorMessage,
          nextRunAt,
          expectedStatus: "active",
        });
        recordJobRetry();

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
        // Exceeded max retry attempts -> isolate in the dead-letter queue
        // (issue #802). `push` performs the guarded status transition, parks
        // the last error against the row and emits `job.dead_lettered`, so a
        // poison message can never be re-claimed by the main queue.
        this.deadLetterQueue.push(job, error, { attempts, maxAttempts: maxAllowedAttempts });
        recordJobDeadLetter();

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
    } finally {
      // Completed, failed, retried and thrown jobs all stop heartbeating here;
      // `updateStatus` has already cleared the lease columns on every path that
      // takes the job out of 'active', and a thrown job's lease simply lapses.
      this.clearLeaseHeartbeat(job.id);
    }
  }
}
