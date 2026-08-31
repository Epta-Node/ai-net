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
import { createLogger } from "../utils/logger";

const logger = createLogger({ component: "job-queue" });

export * from "./jobStore";
export * from "./worker";

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

  constructor(store: JobStore, worker?: JobWorker) {
    this.store = store;
    this.worker = worker;
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
      maxAttempts: options.maxAttempts ?? 3,
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
