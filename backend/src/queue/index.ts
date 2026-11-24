import { nanoid } from "nanoid";
import {
  type Job,
  type JobStatus,
  type JobPriority,
  type JobStore,
  getJobDb,
  closeJobDb,
  createJobStore,
} from "./jobStore";
import { JobWorker, type JobWorkerOptions, type JobHandler } from "./worker";
import { DeadLetterQueue } from "./dlq";
import { createLogger } from "../utils/logger";

const logger = createLogger({ component: "job-queue" });

export * from "./jobStore";
export * from "./worker";
export * from "./backoff";
export * from "./dlq";

/**
 * Thrown by {@link JobQueue.enqueueUnique} when a job for the same `taskId`
 * is already pending, active or retriable in the store.
 *
 * Callers can distinguish a deduplication rejection from other errors by
 * checking `error instanceof DuplicateJobError`.
 */
export class DuplicateJobError extends Error {
  public readonly taskId: string;

  constructor(taskId: string) {
    super(
      `A pending or active job for taskId "${taskId}" already exists. ` +
        "Submit a new job only after the existing one has completed or been moved to the dead-letter queue."
    );
    this.name = "DuplicateJobError";
    this.taskId = taskId;
  }
}

export interface EnqueueOptions<T = any> {
  taskId: string;
  type?: string;
  payload?: T;
  priority?: JobPriority;
  maxAttempts?: number;
}

export class JobQueue {
  private readonly store: JobStore;
  private worker?: JobWorker;
  private defaultMaxAttempts = 3;
  /** Dead-letter facade over the same store (issues #802, #739). */
  private readonly deadLetterQueue: DeadLetterQueue;

  constructor(store: JobStore, worker?: JobWorker) {
    this.store = store;
    this.worker = worker;
    this.deadLetterQueue = new DeadLetterQueue(store, { emitEvents: false });
  }

  public enqueue<T = any>(options: EnqueueOptions<T>): Job<T> {
    const id = `job_${nanoid(12)}`;
    const now = new Date().toISOString();

    const job: Job<T> = {
      id,
      taskId: options.taskId,
      type: options.type ?? "execute_task",
      payload: options.payload ?? ({} as T),
      status: "pending",
      priority: options.priority ?? "normal",
      progress: 0,
      attempts: 0,
      maxAttempts: options.maxAttempts ?? this.defaultMaxAttempts,
      nextRunAt: now,
      createdAt: now,
      updatedAt: now,
    };

    this.store.insert(job);
    logger.info({ jobId: job.id, taskId: job.taskId, priority: job.priority }, "job enqueued");

    // Trigger worker immediately if available
    this.worker?.trigger();

    return job;
  }

  /**
   * Enqueue a job only when no pending, active or retriable job for the same
   * `taskId` is already in the store.
   *
   * This is the primary entry-point for distributed job submission: two backend
   * instances submitting the same logical task in the same window will end up
   * with exactly one queued job between them.
   *
   * @throws {DuplicateJobError} when an in-flight or pending job for `taskId`
   *   already exists.  Terminal jobs (`completed`, `dead-letter`) do not block
   *   re-submission.
   */
  public enqueueUnique<T = any>(options: EnqueueOptions<T>): Job<T> {
    if (this.store.hasPendingJobForTask(options.taskId)) {
      logger.warn(
        { taskId: options.taskId },
        "duplicate job submission rejected: a pending or active job for this taskId already exists"
      );
      throw new DuplicateJobError(options.taskId);
    }
    return this.enqueue(options);
  }

  public getJob(id: string): Job | undefined {
    return this.store.findById(id);
  }

  public getJobByTaskId(taskId: string): Job | undefined {
    return this.store.findByTaskId(taskId);
  }

  public updateProgress(id: string, progress: number): void {
    this.store.updateProgress(id, progress);
  }

  public getStats() {
    return this.store.getStats();
  }

  public listJobs(filter?: {
    status?: JobStatus;
    taskId?: string;
    page?: number;
    pageSize?: number;
  }) {
    return this.store.list(filter);
  }

  public getDeadLetterJobs(page = 1, pageSize = 50) {
    return this.store.getDeadLetterJobs(page, pageSize);
  }

  public retryDeadLetter(jobId: string): boolean {
    const success = this.store.retryDeadLetterJob(jobId);
    if (success) {
      this.worker?.trigger();
    }
    return success;
  }

  /**
   * The dead-letter facade over this queue's store (issues #802, #739).
   *
   * Exposed so admin routes and the operator CLI share one implementation of
   * list/replay/purge instead of growing a second copy of each query.
   */
  public getDeadLetterQueue(): DeadLetterQueue {
    return this.deadLetterQueue;
  }

  /**
   * Delete dead-letter entries older than `olderThanDays`, then kick the
   * worker so any job another operator just replayed is picked up promptly.
   *
   * @returns the number of entries deleted.
   */
  public purgeDeadLetters(olderThanDays: number): number {
    const purged = this.deadLetterQueue.purge(olderThanDays);
    if (purged > 0) {
      this.worker?.trigger();
    }
    return purged;
  }

  /** Attempts given to jobs enqueued without an explicit `maxAttempts` (#752). */
  public setDefaultMaxAttempts(maxAttempts: number): void {
    this.defaultMaxAttempts = maxAttempts;
  }

  public setWorker(worker: JobWorker): void {
    this.worker = worker;
  }

  public getWorker(): JobWorker | undefined {
    return this.worker;
  }

  public getStore(): JobStore {
    return this.store;
  }
}

// Global default singleton queue instance
let _globalJobQueue: JobQueue | null = null;

export function getGlobalJobQueue(): JobQueue {
  if (!_globalJobQueue) {
    const store = createJobStore(getJobDb());
    _globalJobQueue = new JobQueue(store);
  }
  return _globalJobQueue;
}

export function setGlobalJobQueue(queue: JobQueue): void {
  _globalJobQueue = queue;
}

export function createJobQueue(store?: JobStore, worker?: JobWorker): JobQueue {
  const jobStore = store ?? createJobStore(getJobDb());
  return new JobQueue(jobStore, worker);
}
