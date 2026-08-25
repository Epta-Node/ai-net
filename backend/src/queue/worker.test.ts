import Database from "better-sqlite3";
import { createJobStore, type JobStore, type Job } from "./jobStore";
import { JobWorker } from "./worker";
import { JobQueue } from "./index";

describe("Background Job Queue & Worker", () => {
  let db: Database.Database;
  let store: JobStore;

  beforeEach(() => {
    db = new Database(":memory:");
    store = createJobStore(db);
  });

  afterEach(() => {
    db.close();
  });

  describe("JobStore operations", () => {
    it("inserts and retrieves a job by id and taskId", () => {
      const now = new Date().toISOString();
      const job: Job = {
        id: "job_001",
        taskId: "task_001",
        type: "execute_task",
        payload: { prompt: "test prompt" },
        status: "pending",
        priority: "normal",
        progress: 0,
        attempts: 0,
        maxAttempts: 3,
        nextRunAt: now,
        createdAt: now,
        updatedAt: now,
      };

      store.insert(job);

      const foundById = store.findById("job_001");
      expect(foundById).toBeDefined();
      expect(foundById?.id).toBe("job_001");
      expect(foundById?.taskId).toBe("task_001");
      expect(foundById?.payload).toEqual({ prompt: "test prompt" });
      expect(foundById?.status).toBe("pending");
      expect(foundById?.priority).toBe("normal");

      const foundByTaskId = store.findByTaskId("task_001");
      expect(foundByTaskId).toBeDefined();
      expect(foundByTaskId?.id).toBe("job_001");
    });

    it("updates job status, attempts, error and progress", () => {
      const now = new Date().toISOString();
      store.insert({
        id: "job_002",
        taskId: "task_002",
        type: "execute_task",
        payload: {},
        status: "pending",
        priority: "high",
        progress: 0,
        attempts: 0,
        maxAttempts: 3,
        nextRunAt: now,
        createdAt: now,
        updatedAt: now,
      });

      store.updateProgress("job_002", 45);
      expect(store.findById("job_002")?.progress).toBe(45);

      store.updateStatus("job_002", "failed", {
        attempts: 1,
        lastError: "Agent connection timeout",
      });

      const updated = store.findById("job_002");
      expect(updated?.status).toBe("failed");
      expect(updated?.attempts).toBe(1);
      expect(updated?.lastError).toBe("Agent connection timeout");
    });

    it("orders runnable pending jobs by priority (critical > high > normal > low)", () => {
      const now = new Date().toISOString();

      store.insert({
        id: "job_low",
        taskId: "t_low",
        type: "execute_task",
        payload: {},
        status: "pending",
        priority: "low",
        progress: 0,
        attempts: 0,
        maxAttempts: 3,
        nextRunAt: now,
        createdAt: new Date(Date.now() - 5000).toISOString(),
        updatedAt: now,
      });

      store.insert({
        id: "job_critical",
        taskId: "t_crit",
        type: "execute_task",
        payload: {},
        status: "pending",
        priority: "critical",
        progress: 0,
        attempts: 0,
        maxAttempts: 3,
        nextRunAt: now,
        createdAt: now,
        updatedAt: now,
      });

      store.insert({
        id: "job_high",
        taskId: "t_high",
        type: "execute_task",
        payload: {},
        status: "pending",
        priority: "high",
        progress: 0,
        attempts: 0,
        maxAttempts: 3,
        nextRunAt: now,
        createdAt: now,
        updatedAt: now,
      });

      // 1st should be critical
      const first = store.getNextPendingJob();
      expect(first?.id).toBe("job_critical");
      store.updateStatus(first!.id, "completed");

      // 2nd should be high
      const second = store.getNextPendingJob();
      expect(second?.id).toBe("job_high");
      store.updateStatus(second!.id, "completed");

      // 3rd should be low
      const third = store.getNextPendingJob();
      expect(third?.id).toBe("job_low");
      store.updateStatus(third!.id, "completed");

      // 4th should be undefined
      expect(store.getNextPendingJob()).toBeUndefined();
    });

    it("recovers incomplete active jobs on server restart", () => {
      const now = new Date().toISOString();
      store.insert({
        id: "job_active_1",
        taskId: "t_act_1",
        type: "execute_task",
        payload: {},
        status: "active",
        priority: "normal",
        progress: 50,
        attempts: 1,
        maxAttempts: 3,
        nextRunAt: now,
        createdAt: now,
        updatedAt: now,
      });

      expect(store.findById("job_active_1")?.status).toBe("active");

      const recovered = store.recoverIncompleteJobs();
      expect(recovered).toBe(1);

      const jobAfterRecovery = store.findById("job_active_1");
      expect(jobAfterRecovery?.status).toBe("pending");
    });
  });

  describe("JobWorker Lifecycle & Execution", () => {
    it("successfully processes a job from pending to completed with progress tracking", async () => {
      const processed: string[] = [];
      const progressValues: number[] = [];

      const handler = async (job: Job, updateProgress: (pct: number) => void) => {
        processed.push(job.id);
        updateProgress(25);
        updateProgress(75);
        return { success: true };
      };

      const worker = new JobWorker({
        jobStore: store,
        handler,
        pollIntervalMs: 20,
        autoStart: false,
      });

      worker.onJobProgress = (_job, pct) => {
        progressValues.push(pct);
      };

      const queue = new JobQueue(store, worker);
      const job = queue.enqueue({ taskId: "task_success", payload: { step: 1 } });

      expect(job.status).toBe("pending");

      worker.start();

      // Wait for completion
      await new Promise<void>((resolve) => {
        worker.onJobCompleted = (completedJob) => {
          if (completedJob.id === job.id) {
            resolve();
          }
        };
      });

      await worker.stop();

      const finalJob = store.findById(job.id);
      expect(finalJob?.status).toBe("completed");
      expect(finalJob?.progress).toBe(100);
      expect(finalJob?.completedAt).toBeDefined();
      expect(processed).toContain(job.id);
      expect(progressValues).toContain(25);
      expect(progressValues).toContain(75);
    });

    it("retries failed jobs with exponential backoff up to 3 attempts", async () => {
      let callCount = 0;

      const handler = async (_job: Job) => {
        callCount++;
        if (callCount < 3) {
          throw new Error(`Transient failure attempt ${callCount}`);
        }
        return { success: true, attemptsNeeded: callCount };
      };

      const worker = new JobWorker({
        jobStore: store,
        handler,
        pollIntervalMs: 10,
        baseBackoffMs: 20, // fast backoff for test speed
        autoStart: false,
      });

      const queue = new JobQueue(store, worker);
      const job = queue.enqueue({ taskId: "task_retry_test" });

      worker.start();

      await new Promise<void>((resolve) => {
        worker.onJobCompleted = (completedJob) => {
          if (completedJob.id === job.id) {
            resolve();
          }
        };
      });

      await worker.stop();

      expect(callCount).toBe(3);
      const finalJob = store.findById(job.id);
      expect(finalJob?.status).toBe("completed");
      expect(finalJob?.attempts).toBe(2); // 2 failed attempts before 3rd succeeded
    });

    it("moves job to dead-letter queue after 3 failed attempts", async () => {
      let callCount = 0;

      const handler = async (_job: Job) => {
        callCount++;
        throw new Error(`Permanent failure ${callCount}`);
      };

      const worker = new JobWorker({
        jobStore: store,
        handler,
        pollIntervalMs: 10,
        baseBackoffMs: 10,
        maxAttempts: 3,
        autoStart: false,
      });

      let deadLetterJob: Job | null = null;

      worker.onJobDeadLetter = (job) => {
        deadLetterJob = job;
      };

      const queue = new JobQueue(store, worker);
      const job = queue.enqueue({ taskId: "task_dead_letter" });

      worker.start();

      await new Promise<void>((resolve) => {
        const interval = setInterval(() => {
          const current = store.findById(job.id);
          if (current?.status === "dead-letter") {
            clearInterval(interval);
            resolve();
          }
        }, 15);
      });

      await worker.stop();

      expect(callCount).toBe(3);
      const finalJob = store.findById(job.id);
      expect(finalJob?.status).toBe("dead-letter");
      expect(finalJob?.attempts).toBe(3);
      expect(finalJob?.lastError).toContain("Permanent failure 3");
      expect(finalJob?.failedAt).toBeDefined();
      expect(deadLetterJob).not.toBeNull();

      // Dead letter queue querying
      const deadLetters = queue.getDeadLetterJobs();
      expect(deadLetters.total).toBe(1);
      expect(deadLetters.jobs[0].id).toBe(job.id);

      // Retry dead letter job
      const retrySuccess = queue.retryDeadLetter(job.id);
      expect(retrySuccess).toBe(true);

      const retriedJob = store.findById(job.id);
      expect(retriedJob?.status).toBe("pending");
      expect(retriedJob?.attempts).toBe(0);
      expect(retriedJob?.lastError).toBeNull();
    });

    it("respects priority ordering when multiple jobs are pending", async () => {
      const executionOrder: string[] = [];

      const handler = async (job: Job) => {
        executionOrder.push(job.priority);
        return { priority: job.priority };
      };

      const worker = new JobWorker({
        jobStore: store,
        handler,
        concurrency: 1, // sequential execution to verify order
        pollIntervalMs: 10,
        autoStart: false,
      });

      const queue = new JobQueue(store, worker);

      // Enqueue in non-priority order
      queue.enqueue({ taskId: "t1", priority: "low" });
      queue.enqueue({ taskId: "t2", priority: "critical" });
      queue.enqueue({ taskId: "t3", priority: "normal" });
      queue.enqueue({ taskId: "t4", priority: "high" });

      worker.start();

      await new Promise<void>((resolve) => {
        const interval = setInterval(() => {
          if (executionOrder.length === 4) {
            clearInterval(interval);
            resolve();
          }
        }, 15);
      });

      await worker.stop();

      expect(executionOrder).toEqual(["critical", "high", "normal", "low"]);
    });
  });

  describe("Queue Stats & Admin Operations", () => {
    it("reports accurate stats across pending, active, completed, failed and dead-letter", () => {
      const now = new Date().toISOString();
      const queue = new JobQueue(store);

      store.insert({
        id: "j1",
        taskId: "t1",
        type: "execute_task",
        payload: {},
        status: "pending",
        priority: "normal",
        progress: 0,
        attempts: 0,
        maxAttempts: 3,
        nextRunAt: now,
        createdAt: now,
        updatedAt: now,
      });

      store.insert({
        id: "j2",
        taskId: "t2",
        type: "execute_task",
        payload: {},
        status: "active",
        priority: "normal",
        progress: 50,
        attempts: 1,
        maxAttempts: 3,
        nextRunAt: now,
        createdAt: now,
        updatedAt: now,
      });

      store.insert({
        id: "j3",
        taskId: "t3",
        type: "execute_task",
        payload: {},
        status: "completed",
        priority: "normal",
        progress: 100,
        attempts: 1,
        maxAttempts: 3,
        nextRunAt: now,
        createdAt: now,
        updatedAt: now,
      });

      store.insert({
        id: "j4",
        taskId: "t4",
        type: "execute_task",
        payload: {},
        status: "dead-letter",
        priority: "normal",
        progress: 0,
        attempts: 3,
        maxAttempts: 3,
        nextRunAt: now,
        createdAt: now,
        updatedAt: now,
      });

      const stats = queue.getStats();
      expect(stats.pending).toBe(1);
      expect(stats.active).toBe(1);
      expect(stats.completed).toBe(1);
      expect(stats.deadLetter).toBe(1);
      expect(stats.total).toBe(4);
    });
  });
});
