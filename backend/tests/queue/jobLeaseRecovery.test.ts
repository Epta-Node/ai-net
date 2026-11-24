/**
 * Lease-based startup recovery — real-SQL tests for issue #648.
 *
 * The bug: `JobWorker.start()` reset *every* `active` job back to `pending`, so
 * a second instance booting while the first was mid-flight re-queued work that
 * was already running and the handler executed twice (a money bug for
 * payment-settling jobs).
 *
 * The fix is a lease. A worker stamps `leaseOwner`/`leaseExpiresAt` on the row
 * inside the same `UPDATE` that claims it, renews it with a heartbeat while the
 * handler runs, and clears it when the job finishes, is retried, or the worker
 * drains. Startup recovery is then a single conditional `UPDATE` that reclaims
 * only rows whose lease has lapsed — or that never had an owner.
 *
 * Every test here runs against real SQLite via
 * `tests/support/betterSqlite3Shim`, so the conditional `UPDATE`s, `RETURNING`
 * and `BEGIN IMMEDIATE` transactions are genuinely exercised (the default Jest
 * project maps `better-sqlite3` to an inert stub — see that file).
 */

import { createJobStore, initJobSchema, type Job, type JobStore } from "../../src/queue/jobStore";
import {
  DEFAULT_JOB_LEASE_HEARTBEAT_MS,
  DEFAULT_JOB_LEASE_TTL_MS,
  JobWorker,
} from "../../src/queue/worker";
import { openSqliteDatabase } from "../support/betterSqlite3Shim";

// Leases are compared against the real clock by the worker, so fixtures are
// derived from `Date.now()` rather than a frozen instant.
const ago = (ms: number): string => new Date(Date.now() - ms).toISOString();
const ahead = (ms: number): string => new Date(Date.now() + ms).toISOString();
const nowIso = (): string => new Date().toISOString();

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Poll until `condition` holds, so tests never depend on a fixed sleep length. */
async function waitFor(condition: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (condition()) return;
    await sleep(5);
  }
  throw new Error(`condition was not met within ${timeoutMs}ms`);
}

/** A manually settled promise, for holding a handler open mid-flight. */
function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

/** A runnable job row; every field is overridable so tests can set up states. */
function makeJob(overrides: Partial<Job> = {}): Job {
  const stamp = ago(1000);
  return {
    id: "job-1",
    taskId: "task-1",
    type: "inference",
    payload: { prompt: "hello" },
    status: "pending",
    priority: "normal",
    progress: 0,
    attempts: 0,
    maxAttempts: 3,
    nextRunAt: ago(1000),
    createdAt: stamp,
    updatedAt: stamp,
    ...overrides,
  };
}

const columnNames = (database: ReturnType<typeof openSqliteDatabase>): string[] =>
  (database.prepare("PRAGMA table_info(jobs)").all() as Array<{ name: string }>).map((c) => c.name);

describe("job leases (#648)", () => {
  let db: ReturnType<typeof openSqliteDatabase>;
  let store: JobStore;

  beforeEach(() => {
    db = openSqliteDatabase(":memory:");
    store = createJobStore(db);
  });

  afterEach(() => {
    try {
      db.close();
    } catch {
      // Already closed by the test.
    }
  });

  describe("startup recovery of orphaned work", () => {
    it("reclaims an active job whose lease has expired", () => {
      store.insert(
        makeJob({
          id: "orphan",
          status: "active",
          attempts: 1,
          leaseOwner: "dead-process",
          leaseExpiresAt: ago(60_000),
        })
      );

      expect(store.recoverIncompleteJobs(nowIso())).toBe(1);

      const recovered = store.findById("orphan")!;
      expect(recovered.status).toBe("pending");
      expect(recovered.leaseOwner).toBeNull();
      expect(recovered.leaseExpiresAt).toBeNull();
    });

    it("leaves a job whose lease is still valid with its owner", () => {
      const leaseExpiresAt = ahead(30_000);
      store.insert(
        makeJob({
          id: "in-flight",
          status: "active",
          attempts: 1,
          progress: 40,
          leaseOwner: "live-worker",
          leaseExpiresAt,
        })
      );

      expect(store.recoverIncompleteJobs(nowIso())).toBe(0);

      const inFlight = store.findById("in-flight")!;
      expect(inFlight.status).toBe("active");
      expect(inFlight.leaseOwner).toBe("live-worker");
      expect(inFlight.leaseExpiresAt).toBe(leaseExpiresAt);
      expect(inFlight.progress).toBe(40);
    });

    it("treats a lease expiring exactly at 'now' as valid and one millisecond later as lapsed", () => {
      const expiresAt = nowIso();
      store.insert(
        makeJob({
          id: "boundary",
          status: "active",
          leaseOwner: "live-worker",
          leaseExpiresAt: expiresAt,
        })
      );

      expect(store.recoverIncompleteJobs(expiresAt)).toBe(0);
      expect(store.findById("boundary")!.status).toBe("active");

      expect(store.recoverIncompleteJobs(new Date(Date.parse(expiresAt) + 1).toISOString())).toBe(1);
      expect(store.findById("boundary")!.status).toBe("pending");
    });

    it("reclaims active rows that never had an owner", () => {
      // A row written before the lease columns existed…
      store.insert(makeJob({ id: "legacy", status: "active", attempts: 1 }));
      // …and one released by a worker that drained on shutdown.
      store.insert(
        makeJob({
          id: "released",
          status: "active",
          attempts: 1,
          leaseOwner: null,
          leaseExpiresAt: null,
        })
      );

      expect(store.recoverIncompleteJobs(nowIso())).toBe(2);
      expect(store.findById("legacy")!.status).toBe("pending");
      expect(store.findById("released")!.status).toBe("pending");
    });

    it("leaves jobs that are not active alone", () => {
      store.insert(makeJob({ id: "pending" }));
      store.insert(makeJob({ id: "completed", status: "completed" }));
      store.insert(
        makeJob({
          id: "dead",
          status: "dead-letter",
          attempts: 3,
          leaseOwner: "dead-process",
          leaseExpiresAt: ago(60_000),
        })
      );

      expect(store.recoverIncompleteJobs(nowIso())).toBe(0);
      expect(store.getStats()).toMatchObject({
        pending: 1,
        active: 0,
        completed: 1,
        deadLetter: 1,
      });
    });

    it("makes a recovered job runnable immediately", () => {
      store.insert(
        makeJob({
          id: "orphan",
          status: "active",
          attempts: 1,
          nextRunAt: ahead(60_000),
          leaseExpiresAt: ago(1000),
        })
      );
      const recoveredAt = nowIso();

      expect(store.recoverIncompleteJobs(recoveredAt)).toBe(1);

      expect(Date.parse(store.findById("orphan")!.nextRunAt)).toBeLessThanOrEqual(
        Date.parse(recoveredAt)
      );
      expect(store.getNextPendingJob(recoveredAt)?.id).toBe("orphan");
    });
  });

  describe("claiming takes the lease", () => {
    it("stamps owner and expiry in the statement that activates the job", () => {
      store.insert(makeJob({ id: "claimable" }));
      const leaseExpiresAt = ahead(30_000);

      const claimed = store.claimNextPendingJob(nowIso(), {
        owner: "worker-a",
        expiresAt: leaseExpiresAt,
      })!;

      expect(claimed.id).toBe("claimable");
      expect(claimed.status).toBe("active");
      expect(claimed.leaseOwner).toBe("worker-a");
      expect(claimed.leaseExpiresAt).toBe(leaseExpiresAt);

      // The stored row agrees: a claimed job is never active-but-unowned, which
      // is the window startup recovery used to fall into.
      expect(store.findById("claimable")).toMatchObject({
        status: "active",
        leaseOwner: "worker-a",
        leaseExpiresAt,
      });
    });

    it("never hands an already-claimed job to a second worker", () => {
      store.insert(makeJob({ id: "only-one" }));

      expect(
        store.claimNextPendingJob(nowIso(), { owner: "worker-a", expiresAt: ahead(30_000) })?.id
      ).toBe("only-one");
      expect(
        store.claimNextPendingJob(nowIso(), { owner: "worker-a", expiresAt: ahead(30_000) })
      ).toBeUndefined();
      expect(
        store.claimNextPendingJob(nowIso(), { owner: "worker-b", expiresAt: ahead(30_000) })
      ).toBeUndefined();
    });

    it("leaves the lease columns NULL for callers that claim without a lease", () => {
      store.insert(makeJob({ id: "unleased" }));

      const claimed = store.claimNextPendingJob(nowIso())!;

      expect(claimed.status).toBe("active");
      expect(claimed.leaseOwner).toBeNull();
      expect(claimed.leaseExpiresAt).toBeNull();
      // An unleased claim stays recoverable, exactly as before #648.
      expect(store.recoverIncompleteJobs(nowIso())).toBe(1);
    });
  });

  describe("heartbeats and shutdown are owner-scoped", () => {
    it("renews the lease only for the owning worker", () => {
      store.insert(
        makeJob({
          id: "owned",
          status: "active",
          attempts: 1,
          leaseOwner: "worker-a",
          leaseExpiresAt: ahead(1000),
        })
      );
      const renewedUntil = ahead(60_000);

      expect(store.extendLease("owned", "worker-a", renewedUntil)).toBe(true);
      expect(store.findById("owned")!.leaseExpiresAt).toBe(renewedUntil);

      expect(store.extendLease("owned", "worker-b", ahead(120_000))).toBe(false);
      expect(store.findById("owned")).toMatchObject({
        leaseOwner: "worker-a",
        leaseExpiresAt: renewedUntil,
      });
    });

    it("refuses to renew a lease once the job has left 'active'", () => {
      store.insert(
        makeJob({
          id: "finished",
          status: "active",
          attempts: 1,
          leaseOwner: "worker-a",
          leaseExpiresAt: ahead(30_000),
        })
      );
      store.updateStatus("finished", "completed", { progress: 100 });

      expect(store.extendLease("finished", "worker-a", ahead(60_000))).toBe(false);
      expect(store.findById("finished")!.leaseExpiresAt).toBeNull();
    });

    it("hands a job back on shutdown without re-queueing it", () => {
      store.insert(
        makeJob({
          id: "draining",
          status: "active",
          attempts: 1,
          leaseOwner: "worker-a",
          leaseExpiresAt: ahead(30_000),
        })
      );

      expect(store.releaseLease("draining", "worker-b")).toBe(false);
      expect(store.findById("draining")!.leaseOwner).toBe("worker-a");

      expect(store.releaseLease("draining", "worker-a")).toBe(true);
      const draining = store.findById("draining")!;
      expect(draining.status).toBe("active"); // recovery decides when to re-queue
      expect(draining.leaseOwner).toBeNull();
      expect(draining.leaseExpiresAt).toBeNull();

      // A released lease reads as "no owner", so the next startup resumes it
      // instead of waiting out the TTL.
      expect(store.recoverIncompleteJobs(nowIso())).toBe(1);
      expect(store.findById("draining")!.status).toBe("pending");
    });
  });

  describe("leaving 'active' releases the lease", () => {
    it("clears the lease when a job completes", () => {
      store.insert(
        makeJob({
          id: "done",
          status: "active",
          attempts: 1,
          leaseOwner: "worker-a",
          leaseExpiresAt: ahead(30_000),
        })
      );

      store.updateStatus("done", "completed", { progress: 100, completedAt: nowIso() });

      expect(store.findById("done")).toMatchObject({
        status: "completed",
        leaseOwner: null,
        leaseExpiresAt: null,
      });
    });

    it("clears the lease when a job fails and is scheduled for retry", () => {
      store.insert(
        makeJob({
          id: "retry",
          status: "active",
          attempts: 1,
          leaseOwner: "worker-a",
          leaseExpiresAt: ahead(30_000),
        })
      );

      store.updateStatus("retry", "failed", { attempts: 2, lastError: "boom", nextRunAt: nowIso() });

      expect(store.findById("retry")).toMatchObject({ leaseOwner: null, leaseExpiresAt: null });
      // …so the retry is claimable straight away, by any worker.
      expect(
        store.claimNextPendingJob(nowIso(), { owner: "worker-b", expiresAt: ahead(30_000) })?.id
      ).toBe("retry");
    });

    it("keeps the lease while the job is still active", () => {
      store.insert(
        makeJob({
          id: "ticking",
          status: "active",
          attempts: 1,
          leaseOwner: "worker-a",
          leaseExpiresAt: ahead(30_000),
        })
      );

      store.updateStatus("ticking", "active", { progress: 50 });
      store.updateProgress("ticking", 60);

      expect(store.findById("ticking")).toMatchObject({
        status: "active",
        progress: 60,
        leaseOwner: "worker-a",
      });
    });

    it("clears the lease when a dead-lettered job is retried", () => {
      store.insert(
        makeJob({
          id: "dead",
          status: "dead-letter",
          attempts: 3,
          leaseOwner: "worker-a",
          leaseExpiresAt: ago(1000),
        })
      );

      expect(store.retryDeadLetterJob("dead")).toBe(true);

      expect(store.findById("dead")).toMatchObject({
        status: "pending",
        leaseOwner: null,
        leaseExpiresAt: null,
      });
    });
  });

  describe("schema migration", () => {
    it("adds the lease columns to a pre-#648 database, idempotently", () => {
      const legacy = openSqliteDatabase(":memory:");
      try {
        // The jobs table as it shipped before #648 (no lease columns).
        legacy.exec(`
          CREATE TABLE jobs (
            id           TEXT PRIMARY KEY,
            taskId       TEXT NOT NULL,
            type         TEXT NOT NULL,
            payloadJson  TEXT NOT NULL,
            status       TEXT NOT NULL DEFAULT 'pending',
            priority     TEXT NOT NULL DEFAULT 'normal',
            priorityNum  INTEGER NOT NULL DEFAULT 2,
            progress     INTEGER NOT NULL DEFAULT 0,
            attempts     INTEGER NOT NULL DEFAULT 0,
            maxAttempts  INTEGER NOT NULL DEFAULT 3,
            lastError    TEXT,
            nextRunAt    TEXT NOT NULL,
            createdAt    TEXT NOT NULL,
            updatedAt    TEXT NOT NULL,
            completedAt  TEXT,
            failedAt     TEXT
          );
        `);
        legacy
          .prepare(
            `INSERT INTO jobs (
               id, taskId, type, payloadJson, status, priority, priorityNum,
               progress, attempts, maxAttempts, nextRunAt, createdAt, updatedAt
             ) VALUES ('legacy', 'task-1', 'inference', '{}', 'active', 'normal', 2, 0, 1, 3, ?, ?, ?)`
          )
          .run(ago(5000), ago(5000), ago(5000));

        expect(columnNames(legacy)).not.toContain("leaseOwner");

        initJobSchema(legacy); // upgrade to the lease schema
        initJobSchema(legacy); // and again: must stay a no-op

        expect(columnNames(legacy)).toEqual(
          expect.arrayContaining(["leaseOwner", "leaseExpiresAt"])
        );

        // The row written before the columns existed survives and reads as
        // unowned, so a crashed pre-#648 deployment resumes after the upgrade
        // instead of being stranded.
        const legacyStore = createJobStore(legacy);
        expect(legacyStore.findById("legacy")!.leaseOwner).toBeNull();
        expect(legacyStore.recoverIncompleteJobs(nowIso())).toBe(1);
        expect(legacyStore.findById("legacy")!.status).toBe("pending");
      } finally {
        legacy.close();
      }
    });
  });

  describe("JobWorker lease lifecycle", () => {
    it("ships a heartbeat well inside the default TTL", () => {
      expect(DEFAULT_JOB_LEASE_HEARTBEAT_MS).toBeLessThan(DEFAULT_JOB_LEASE_TTL_MS);
      expect(DEFAULT_JOB_LEASE_TTL_MS / DEFAULT_JOB_LEASE_HEARTBEAT_MS).toBeGreaterThanOrEqual(3);
    });

    it("defaults to a worker id that is unique per instance", () => {
      const first = new JobWorker({ jobStore: store, handler: async () => undefined });
      const second = new JobWorker({ jobStore: store, handler: async () => undefined });

      expect(first.workerId).not.toBe(second.workerId);
      expect(first.workerId).toContain(String(process.pid));
    });

    it("claims under its own worker id and clears the lease when the job completes", async () => {
      store.insert(makeJob({ id: "worker-job" }));

      let whileRunning: Job | undefined;
      const started = deferred();
      const finished = deferred();
      const worker = new JobWorker({
        jobStore: store,
        workerId: "worker-a",
        pollIntervalMs: 5,
        leaseTtlMs: 60_000,
        leaseHeartbeatMs: 30_000,
        handler: async () => ({ ok: true }),
      });
      worker.onJobStarted = (job) => {
        whileRunning = store.findById(job.id);
        started.resolve();
      };
      worker.onJobCompleted = () => finished.resolve();

      worker.start();
      await started.promise;

      expect(whileRunning).toMatchObject({
        id: "worker-job",
        status: "active",
        leaseOwner: "worker-a",
      });
      expect(whileRunning!.leaseExpiresAt).not.toBeNull();
      expect(Date.parse(whileRunning!.leaseExpiresAt!)).toBeGreaterThan(Date.now());

      await finished.promise;
      await worker.stop();

      expect(store.findById("worker-job")).toMatchObject({
        status: "completed",
        leaseOwner: null,
        leaseExpiresAt: null,
      });
      expect(worker.getStatus()).toMatchObject({ running: false, activeLeases: 0 });
    });

    it("renews the lease while a long-running handler is in flight", async () => {
      store.insert(makeJob({ id: "long-job" }));
      const gate = deferred();
      let initialExpiry: string | null = null;

      const worker = new JobWorker({
        jobStore: store,
        workerId: "worker-hb",
        pollIntervalMs: 5,
        leaseTtlMs: 400,
        leaseHeartbeatMs: 20,
        handler: async () => {
          initialExpiry = store.findById("long-job")!.leaseExpiresAt;
          await gate.promise;
        },
      });
      const finished = deferred();
      worker.onJobCompleted = () => finished.resolve();

      worker.start();
      await waitFor(() => initialExpiry !== null && worker.getStatus().activeLeases === 1);

      // The heartbeat pushes the expiry forward on its own, so no recovery pass
      // (and therefore no second execution) is needed to keep the claim alive.
      await waitFor(() => store.findById("long-job")!.leaseExpiresAt !== initialExpiry);
      expect(store.findById("long-job")!.leaseOwner).toBe("worker-hb");

      gate.resolve();
      await finished.promise;
      await worker.stop();

      expect(worker.getStatus().activeLeases).toBe(0);
      expect(store.findById("long-job")!.leaseExpiresAt).toBeNull();
    });

    it("hands its lease back on shutdown so the next startup resumes the work", async () => {
      store.insert(makeJob({ id: "interrupted" }));
      const started = deferred();

      const worker = new JobWorker({
        jobStore: store,
        workerId: "worker-drain",
        pollIntervalMs: 5,
        leaseTtlMs: 60_000,
        leaseHeartbeatMs: 30_000,
        // Never settles, so the worker has to stop with the job still running.
        handler: () => new Promise<void>(() => {}),
      });
      worker.onJobStarted = () => started.resolve();

      worker.start();
      await started.promise;
      await waitFor(() => store.findById("interrupted")!.leaseOwner === "worker-drain");

      await worker.stop(50); // the drain window elapses with the handler stuck

      const interrupted = store.findById("interrupted")!;
      expect(interrupted.status).toBe("active"); // the work is unfinished…
      expect(interrupted.leaseOwner).toBeNull(); // …but no longer claimed
      expect(interrupted.leaseExpiresAt).toBeNull();
      expect(worker.getStatus().activeLeases).toBe(0);

      // A NULL lease reads as "no owner", so the next startup resumes it instead
      // of waiting out the TTL.
      expect(store.recoverIncompleteJobs(nowIso())).toBe(1);
      expect(store.findById("interrupted")!.status).toBe("pending");
    });

    it("never re-queues a job a live worker is still processing (#648 regression)", async () => {
      store.insert(makeJob({ id: "in-flight" }));
      const gate = deferred();
      const runs: string[] = [];

      const worker = new JobWorker({
        jobStore: store,
        workerId: "worker-live",
        pollIntervalMs: 5,
        leaseTtlMs: 60_000,
        leaseHeartbeatMs: 30_000,
        handler: async (job) => {
          runs.push(job.id);
          await gate.promise;
        },
      });
      const finished = deferred();
      worker.onJobCompleted = () => finished.resolve();

      worker.start();
      await waitFor(() => runs.length === 1);

      // Exactly what a second instance's `start()` does to the same database.
      // Before #648 this reset the row to 'pending' and the handler ran twice.
      expect(store.recoverIncompleteJobs(nowIso())).toBe(0);
      expect(store.findById("in-flight")).toMatchObject({
        status: "active",
        leaseOwner: "worker-live",
      });

      gate.resolve();
      await finished.promise;
      await worker.stop();

      expect(runs).toEqual(["in-flight"]); // executed exactly once
      expect(store.findById("in-flight")).toMatchObject({
        status: "completed",
        leaseOwner: null,
        leaseExpiresAt: null,
      });
    });

    it("resumes a crashed worker's job on startup once its lease has lapsed", async () => {
      // The row a process that claimed this job and died left behind: 'active'
      // with a lease that is already in the past.
      store.insert(
        makeJob({
          id: "orphan",
          status: "active",
          attempts: 1,
          leaseOwner: "crashed-process",
          leaseExpiresAt: ago(1000),
        })
      );

      const runs: string[] = [];
      const worker = new JobWorker({
        jobStore: store,
        workerId: "resumer",
        pollIntervalMs: 5,
        handler: async (job) => {
          runs.push(job.id);
        },
      });
      const finished = deferred();
      worker.onJobCompleted = () => finished.resolve();

      worker.start(); // start() runs a recovery pass before polling
      await finished.promise;
      await worker.stop();

      expect(runs).toEqual(["orphan"]);
      expect(store.findById("orphan")).toMatchObject({
        status: "completed",
        attempts: 1, // resumed, not counted as a fresh attempt
        leaseOwner: null,
        leaseExpiresAt: null,
      });
    });

    it("does not steal a job held under a live lease, then picks it up once that lease lapses", async () => {
      store.insert(
        makeJob({
          id: "held",
          status: "active",
          attempts: 1,
          leaseOwner: "other-live-worker",
          leaseExpiresAt: ahead(60_000),
        })
      );

      const runs: string[] = [];
      const worker = new JobWorker({
        jobStore: store,
        workerId: "observer",
        pollIntervalMs: 5,
        handler: async (job) => {
          runs.push(job.id);
        },
      });

      worker.start(); // the startup pass must leave a live lease alone
      await sleep(50);
      expect(runs).toEqual([]);
      expect(store.findById("held")!.leaseOwner).toBe("other-live-worker");

      // The other worker's last heartbeat lands in the past — it is gone.
      expect(store.extendLease("held", "other-live-worker", ago(1000))).toBe(true);

      // ...and the next startup pass hands its work to whoever is running.
      expect(store.recoverIncompleteJobs(nowIso())).toBe(1);
      await waitFor(() => runs.length === 1);
      await worker.stop();

      expect(store.findById("held")).toMatchObject({ status: "completed", leaseOwner: null });
    });
  });
});

// __WORKER_TESTS__
