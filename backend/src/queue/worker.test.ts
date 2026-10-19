import fs from "fs";
import os from "os";
import path from "path";
// Real SQLite via the built-in `node:sqlite` driver: the default Jest project
// maps the native `better-sqlite3` addon to an inert stub (see
// backend/__mocks__/better-sqlite3.js), which cannot execute a claim, a
// conditional UPDATE or a transaction, so this suite could never assert
// anything. tests/support/betterSqlite3Shim.ts explains the trade-off.
import { openSqliteDatabase } from "../../tests/support/betterSqlite3Shim";
import { createJobStore, type JobStore, type Job } from "./jobStore";
import { JobWorker } from "./worker";
import { JobQueue } from "./index";

describe("Background Job Queue & Worker", () => {
  let db: ReturnType<typeof openSqliteDatabase>;
  let store: JobStore;

  beforeEach(() => {
    db = openSqliteDatabase(":memory:");
    store = createJobStore(db);
  });

  afterEach(() => {
    db.close();
  });

  /** Minimal valid job row; every field can be overridden per test. */
  function makeJob(overrides: Partial<Job> = {}): Job {
    const now = new Date().toISOString();
    return {
      id: `job_${Math.random().toString(36).slice(2, 10)}`,
      taskId: `task_${Math.random().toString(36).slice(2, 10)}`,
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
      ...overrides,
    };
  }

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

    it("rejects status transition from stale prior status (#649)", () => {
      const now = new Date().toISOString();
      store.insert({
        id: "job_stale_1",
        taskId: "t_stale_1",
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

      // Try transitioning from expected status "active" when status is already "completed"
      const result = store.updateStatus("job_stale_1", "active", { expectedStatus: "active" });
      expect(result).toBe(false);

      const current = store.findById("job_stale_1");
      expect(current?.status).toBe("completed");
    });

    it("50 concurrent updateStatus calls converge on exactly one terminal state without clobbering fields (#649)", () => {
      const now = new Date().toISOString();
      store.insert({
        id: "job_concurrent_1",
        taskId: "t_conc_1",
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

      // Perform progress updates and completion updates in rapid sequence
      for (let i = 0; i < 50; i++) {
        store.updateProgress("job_concurrent_1", Math.min(100, 50 + i));
        store.updateStatus("job_concurrent_1", "completed", {
          completedAt: now,
          expectedStatus: "active",
        });
      }

      const finalJob = store.findById("job_concurrent_1");
      expect(finalJob?.status).toBe("completed");
      expect(finalJob?.progress).toBeGreaterThanOrEqual(50);

      // Verify job_history has records
      const historyCount = (db.prepare("SELECT COUNT(*) as c FROM job_history WHERE jobId = ?").get("job_concurrent_1") as any).c;
      expect(historyCount).toBe(1);
    });

    it("claimNextPendingJob marks the returned job active and never returns it twice", () => {
      const now = new Date().toISOString();
      const job = makeJob({ id: "claim_1", createdAt: now, nextRunAt: now });
      store.insert(job);

      const claimed = store.claimNextPendingJob(now);

      // The row comes back already flipped to 'active' — the caller never has
      // to (and must not) run a second UPDATE to take ownership.
      expect(claimed?.id).toBe("claim_1");
      expect(claimed?.status).toBe("active");
      expect(store.findById("claim_1")?.status).toBe("active");

      // A second claim hands out nothing, so the handler behind it cannot be
      // scheduled a second time for the same row.
      expect(store.claimNextPendingJob(now)).toBeUndefined();
    });

    it("claimNextPendingJob leaves non-runnable jobs alone", () => {
      const now = new Date().toISOString();
      const future = new Date(Date.now() + 60_000).toISOString();

      store.insert(makeJob({ id: "running_1", status: "active", createdAt: now, nextRunAt: now }));
      store.insert(makeJob({ id: "scheduled_1", status: "pending", createdAt: now, nextRunAt: future }));
      store.insert(
        makeJob({ id: "exhausted_1", status: "failed", attempts: 3, maxAttempts: 3, createdAt: now, nextRunAt: now })
      );

      expect(store.claimNextPendingJob(now)).toBeUndefined();
      expect(store.findById("running_1")?.status).toBe("active");
      expect(store.findById("scheduled_1")?.status).toBe("pending");
      expect(store.findById("exhausted_1")?.status).toBe("failed");
    });

    it("a second claimant over its own connection loses the row already claimed elsewhere", () => {
      // Regression test for the race this change fixes. Claiming used to be a
      // `getNextPendingJob()` SELECT followed by a separate `updateStatus()`
      // UPDATE. Two workers over the same SQLite file could both see the same
      // candidate row in that gap; the second UPDATE then matched
      // unconditionally, so both ran the handler (duplicate payment / duplicate
      // side effects) for one job. Here both connections deliberately perform
      // the stale read first — the exact interleaving the old code allowed —
      // and the atomic claim must refuse the second one.
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-net-claim-"));
      const dbPath = path.join(dir, "jobs.sqlite");

      const dbA = openSqliteDatabase(dbPath);
      const dbB = openSqliteDatabase(dbPath);
      dbA.pragma("busy_timeout = 5000");
      dbB.pragma("busy_timeout = 5000");

      try {
        const storeA = createJobStore(dbA);
        const storeB = createJobStore(dbB);
        const now = new Date().toISOString();
        storeA.insert(makeJob({ id: "shared_1", createdAt: now, nextRunAt: now }));

        // Both workers look before either claims: same row, same nextRunAt.
        expect(storeA.getNextPendingJob(now)?.id).toBe("shared_1");
        expect(storeB.getNextPendingJob(now)?.id).toBe("shared_1");

        // Only one of them can come away with it.
        const winner = storeA.claimNextPendingJob(now);
        const loser = storeB.claimNextPendingJob(now);
        expect(winner?.id).toBe("shared_1");
        expect(winner?.status).toBe("active");
        expect(loser).toBeUndefined();
      } finally {
        dbA.close();
        dbB.close();
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });

    it("two connections claiming a two-job queue get one distinct job each", () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-net-claim-"));
      const dbPath = path.join(dir, "jobs.sqlite");

      const dbA = openSqliteDatabase(dbPath);
      const dbB = openSqliteDatabase(dbPath);
      dbA.pragma("busy_timeout = 5000");
      dbB.pragma("busy_timeout = 5000");

      try {
        const storeA = createJobStore(dbA);
        const storeB = createJobStore(dbB);
        const now = new Date().toISOString();
        storeA.insert(makeJob({ id: "shared_1", createdAt: now, nextRunAt: now }));
        storeA.insert(makeJob({ id: "shared_2", createdAt: now, nextRunAt: now }));

        const claimedA = storeA.claimNextPendingJob(now);
        const claimedB = storeB.claimNextPendingJob(now);

        expect(claimedA).toBeDefined();
        expect(claimedB).toBeDefined();
        expect(claimedA!.id).not.toBe(claimedB!.id);
        expect(new Set([claimedA!.id, claimedB!.id])).toEqual(new Set(["shared_1", "shared_2"]));
        expect(storeA.claimNextPendingJob(now)).toBeUndefined();
      } finally {
        dbA.close();
        dbB.close();
        fs.rmSync(dir, { recursive: true, force: true });
      }
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
      expect(finalJob?.lastError).toContain("max attempts exceeded (3/3)");
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

    it(
      "multiple worker processes over one SQLite file each run a job exactly once (#647)",
      async () => {
        // End-to-end version of the claim fix: several workers, each with its
        // own connection to the same file — the shape of a multi-process /
        // multi-replica deployment — draining a shared queue. Every job must be
        // handled exactly once: no job left behind, none run twice.
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-net-workers-"));
        const dbPath = path.join(dir, "jobs.sqlite");
        const connections: Array<ReturnType<typeof openSqliteDatabase>> = [];
        const workers: JobWorker[] = [];
        const handled = new Set<string>();
        let duplicateRuns = 0;

        const WORKER_COUNT = 4;
        const TOTAL_JOBS = 50;

        try {
          const now = new Date().toISOString();
          const seeder = openSqliteDatabase(dbPath);
          connections.push(seeder);
          const seedStore = createJobStore(seeder);
          for (let i = 0; i < TOTAL_JOBS; i++) {
            seedStore.insert(
              makeJob({ id: `job_${i}`, taskId: `task_${i}`, createdAt: now, nextRunAt: now })
            );
          }

          for (let w = 0; w < WORKER_COUNT; w++) {
            const conn = openSqliteDatabase(dbPath);
            conn.pragma("busy_timeout = 5000");
            connections.push(conn);

            workers.push(
              new JobWorker({
                jobStore: createJobStore(conn),
                handler: async (job) => {
                  if (handled.has(job.id)) {
                    duplicateRuns++;
                  }
                  handled.add(job.id);
                  return { success: true };
                },
                pollIntervalMs: 10,
                autoStart: false,
              })
            );
          }

          workers.forEach((worker) => worker.start());

          const deadline = Date.now() + 20_000;
          while (handled.size < TOTAL_JOBS && Date.now() < deadline) {
            await new Promise((resolve) => setTimeout(resolve, 20));
          }

          await Promise.all(workers.map((worker) => worker.stop()));

          expect(handled.size).toBe(TOTAL_JOBS);
          expect(duplicateRuns).toBe(0);
          // Every job reached the terminal state — the codebase's terminal
          // status is `completed` (there is no separate `done` status).
          expect(seedStore.getStats().completed).toBe(TOTAL_JOBS);
          // Nothing left runnable, and nothing stuck mid-flight.
          expect(seedStore.getNextPendingJob(new Date(Date.now() + 60_000).toISOString())).toBeUndefined();
          expect(seedStore.getStats().active).toBe(0);
        } finally {
          await Promise.all(workers.map((worker) => worker.stop().catch(() => undefined)));
          connections.forEach((conn) => conn.close());
          fs.rmSync(dir, { recursive: true, force: true });
        }
      },
      30_000
    );
  });

  describe("Restart mid-stream (#349 — in-flight jobs resume, not fail)", () => {
    it("a job still running when the worker stops is resumed and completed by a fresh worker instance", async () => {
      // Simulates a graceful shutdown that catches a job mid-execution: the
      // handler never resolves before stop() gives up waiting, so the job
      // stays "active" in the store rather than being marked failed — exactly
      // what api/app.ts's close() -> jobWorker.stop(timeoutMs) produces when
      // the drain window elapses with work still outstanding.
      let releaseHandler!: () => void;
      let resolveHandlerStarted!: () => void;
      const handlerStarted = new Promise<void>((resolve) => {
        resolveHandlerStarted = resolve;
      });

      const firstWorker = new JobWorker({
        jobStore: store,
        handler: async () => {
          resolveHandlerStarted();
          // Hang until explicitly released — outlives the worker's stop()
          // timeout, so stop() returns while this job is still "active".
          await new Promise<void>((releaseResolve) => {
            releaseHandler = releaseResolve;
          });
          return { success: true };
        },
        pollIntervalMs: 20,
        autoStart: false,
      });

      const queue = new JobQueue(store, firstWorker);
      const job = queue.enqueue({ taskId: "task_mid_stream" });

      firstWorker.start();
      await handlerStarted;

      // Job is now actively executing. "Shut down" with a short drain
      // window — the handler is hung, so stop() times out waiting and
      // returns with the job still active, exactly like a real deploy that
      // catches a slow task.
      await firstWorker.stop(50);

      const midShutdownState = store.findById(job.id);
      expect(midShutdownState?.status).toBe("active");

      // "Restart": a brand-new JobWorker over the SAME store (in a real
      // process this is the same jobs.db file reopened) — its start() calls
      // recoverIncompleteJobs(), which is what actually makes the job
      // resumable rather than lost.
      const secondWorker = new JobWorker({
        jobStore: store,
        handler: async (_job, updateProgress) => {
          updateProgress(100);
          return { success: true, resumed: true };
        },
        pollIntervalMs: 20,
        autoStart: false,
      });

      const completed = new Promise<void>((resolve) => {
        secondWorker.onJobCompleted = (completedJob) => {
          if (completedJob.id === job.id) resolve();
        };
      });

      secondWorker.start();
      await completed;
      await secondWorker.stop();

      const finalState = store.findById(job.id);
      expect(finalState?.status).toBe("completed");
      expect(finalState?.progress).toBe(100);
      expect(finalState?.completedAt).toBeDefined();

      // Release the first handler's promise so it doesn't leak a dangling
      // timer/microtask into later tests.
      releaseHandler();
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

  describe("Job Deduplication (enqueueUnique)", () => {
    it("hasPendingJobForTask returns false when no job exists for the taskId", () => {
      expect(store.hasPendingJobForTask("task_nonexistent")).toBe(false);
    });

    it("hasPendingJobForTask returns true for a pending job", () => {
      const job = makeJob({ taskId: "task_dedup_1" });
      store.insert(job);
      expect(store.hasPendingJobForTask("task_dedup_1")).toBe(true);
    });

    it("hasPendingJobForTask returns true for an active job", () => {
      const job = makeJob({ taskId: "task_dedup_2", status: "active" });
      store.insert(job);
      expect(store.hasPendingJobForTask("task_dedup_2")).toBe(true);
    });

    it("hasPendingJobForTask returns true for a failed-but-retriable job", () => {
      const job = makeJob({ taskId: "task_dedup_3", status: "failed", attempts: 1, maxAttempts: 3 });
      store.insert(job);
      expect(store.hasPendingJobForTask("task_dedup_3")).toBe(true);
    });

    it("hasPendingJobForTask returns false for a completed job (terminal)", () => {
      const job = makeJob({ taskId: "task_dedup_4", status: "completed" });
      store.insert(job);
      expect(store.hasPendingJobForTask("task_dedup_4")).toBe(false);
    });

    it("hasPendingJobForTask returns false for a dead-letter job (terminal)", () => {
      const job = makeJob({ taskId: "task_dedup_5", status: "dead-letter" });
      store.insert(job);
      expect(store.hasPendingJobForTask("task_dedup_5")).toBe(false);
    });

    it("enqueueUnique succeeds when no existing job for taskId", () => {
      const queue = new JobQueue(store);
      expect(() => queue.enqueueUnique({ taskId: "task_unique_1" })).not.toThrow();
      const job = store.findByTaskId("task_unique_1");
      expect(job).toBeDefined();
      expect(job?.status).toBe("pending");
    });

    it("enqueueUnique throws DuplicateJobError when a pending job already exists", async () => {
      const { DuplicateJobError } = await import("./index.js");
      const queue = new JobQueue(store);
      queue.enqueueUnique({ taskId: "task_unique_2" });

      expect(() => queue.enqueueUnique({ taskId: "task_unique_2" })).toThrow(DuplicateJobError);
    });

    it("enqueueUnique succeeds after the prior job completes (terminal state allows re-submission)", async () => {
      const { DuplicateJobError } = await import("./index.js");
      const queue = new JobQueue(store);
      const job = queue.enqueueUnique({ taskId: "task_unique_3" });

      // Simulate job completion
      store.updateStatus(job.id, "completed", { completedAt: new Date().toISOString() });

      // Re-submission should succeed after completion
      expect(() => queue.enqueueUnique({ taskId: "task_unique_3" })).not.toThrow(DuplicateJobError);
    });

    it("DuplicateJobError carries the offending taskId", async () => {
      const { DuplicateJobError } = await import("./index.js");
      const queue = new JobQueue(store);
      queue.enqueueUnique({ taskId: "task_unique_4" });

      let caught: unknown;
      try {
        queue.enqueueUnique({ taskId: "task_unique_4" });
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(DuplicateJobError);
      expect((caught as InstanceType<typeof DuplicateJobError>).taskId).toBe("task_unique_4");
    });
  });
});
