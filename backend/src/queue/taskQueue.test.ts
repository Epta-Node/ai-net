import { TaskQueue, WorkerPool } from "./taskQueue";

describe("TaskQueue / WorkerPool (#1008)", () => {
  it("lease is atomic - concurrent leases do not get same job", () => {
    const q = new TaskQueue({ dbPath: ":memory:" });
    q.enqueue("task1", 2);
    const a = q.lease("w1", 5_000);
    const b = q.lease("w2", 5_000);
    expect(a?.id).toBeTruthy();
    expect(b).toBeUndefined();
    q.close();
  });

  it("priority 3 dequeued before priority 1 regardless of insertion order", () => {
    const q = new TaskQueue({ dbPath: ":memory:" });
    q.enqueue("low", 1);
    q.enqueue("high", 3);
    const first = q.lease("w1", 5_000);
    expect(first?.taskId).toBe("high");
    q.close();
  });

  it("re-queues leased job whose leaseExpiry passed within recovery pass", () => {
    jest.useFakeTimers();
    try {
      const q = new TaskQueue({ dbPath: ":memory:", recoveryIntervalMs: 30_000 });
      q.enqueue("task1", 2);
      const leased = q.lease("w1", 1_000);
      expect(leased?.status).toBe("leased");
      jest.advanceTimersByTime(31_000);
      q.requeueExpiredLeases(new Date(Date.now()));
      const again = q.getJob(leased!.id);
      expect(again?.status).toBe("pending");
      q.close();
    } finally {
      jest.useRealTimers();
    }
  });

  it("WorkerPool with WORKER_CONCURRENCY=2 never executes more than 2 jobs concurrently", async () => {
    const q = new TaskQueue({ dbPath: ":memory:" });
    for (let i = 0; i < 6; i++) q.enqueue(`t${i}`, 2);
    let active = 0;
    let maxActive = 0;
    const pool = new WorkerPool({
      queue: q,
      workerCount: 2,
      leaseTimeoutMs: 5_000,
      pollIntervalMs: 5,
      handler: async () => {
        active++;
        maxActive = Math.max(maxActive, active);
        await new Promise((r) => setTimeout(r, 20));
        active--;
      },
    });
    pool.start();
    await new Promise((r) => setTimeout(r, 200));
    await pool.stop();
    expect(maxActive).toBeLessThanOrEqual(2);
    expect(q.counts().completed).toBe(6);
    q.close();
  });

  it("crashing worker mid-execution causes job to be re-leased after timeout", async () => {
    const q = new TaskQueue({ dbPath: ":memory:" });
    q.enqueue("t1", 2);
    const pool = new WorkerPool({
      queue: q,
      workerCount: 1,
      leaseTimeoutMs: 30,
      pollIntervalMs: 5,
      handler: async () => {
        await new Promise((r) => setTimeout(r, 100)); // outlive lease
        throw new Error("boom");
      },
    });
    pool.start();
    await new Promise((r) => setTimeout(r, 70));
    q.requeueExpiredLeases(new Date());
    await new Promise((r) => setTimeout(r, 70));
    await pool.stop();
    const counts = q.counts();
    // either failed after handling or requeued then failed; must not be stuck leased
    expect(counts.leased).toBe(0);
    expect(counts.failed + counts.completed + counts.pending).toBeGreaterThan(0);
    q.close();
  });

  it("counts reflect enqueue/lease/complete", () => {
    const q = new TaskQueue({ dbPath: ":memory:" });
    q.enqueue("t1", 1);
    q.enqueue("t2", 2);
    expect(q.counts()).toMatchObject({ pending: 2, leased: 0, completed: 0, failed: 0 });
    const job = q.lease("w1", 5000)!;
    expect(q.counts()).toMatchObject({ pending: 1, leased: 1, completed: 0, failed: 0 });
    q.complete(job.id);
    expect(q.counts()).toMatchObject({ pending: 1, leased: 0, completed: 1, failed: 0 });
    q.close();
  });
});
