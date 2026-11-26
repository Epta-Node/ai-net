import Database from "better-sqlite3";
import path from "path";
import { randomUUID } from "crypto";
import { createLogger } from "../utils/logger";

const logger = createLogger({ component: "task-queue" });

export type QueuePriority = 1 | 2 | 3;
export type QueueJobStatus = "pending" | "leased" | "completed" | "failed";

export interface JobQueueRow {
  id: string;
  taskId: string;
  priority: QueuePriority;
  status: QueueJobStatus;
  leasedAt: string | null;
  leasedBy: string | null;
  leaseExpiry: string | null;
  createdAt: string;
  failedReason?: string | null;
}

export interface TaskQueueOptions {
  db?: Database.Database;
  dbPath?: string;
  leaseTimeoutMs?: number;
  recoveryIntervalMs?: number;
}

export class TaskQueue {
  private readonly db: Database.Database;
  private readonly leaseTimeoutMs: number;
  private readonly recoveryIntervalMs: number;
  private recoveryTimer: NodeJS.Timeout | null = null;

  constructor(options: TaskQueueOptions = {}) {
    this.db = options.db ?? new Database(options.dbPath ?? path.join(process.cwd(), "task-queue.db"));
    this.db.pragma("busy_timeout = 5000");
    this.db.pragma("journal_mode = WAL");
    this.leaseTimeoutMs = options.leaseTimeoutMs ?? 30_000;
    this.recoveryIntervalMs = options.recoveryIntervalMs ?? 30_000;
    this.init();
  }

  private init(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS job_queue (
        id TEXT PRIMARY KEY,
        taskId TEXT NOT NULL,
        priority INTEGER NOT NULL CHECK (priority IN (1,2,3)),
        status TEXT NOT NULL CHECK (status IN ('pending','leased','completed','failed')),
        leasedAt TEXT,
        leasedBy TEXT,
        leaseExpiry TEXT,
        createdAt TEXT NOT NULL,
        failedReason TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_job_queue_dequeue
        ON job_queue (status, priority DESC, createdAt ASC);
      CREATE INDEX IF NOT EXISTS idx_job_queue_lease_expiry
        ON job_queue (status, leaseExpiry);
    `);
  }

  enqueue(taskId: string, priority: QueuePriority): JobQueueRow {
    if (![1, 2, 3].includes(priority)) {
      throw new Error("priority must be 1, 2, or 3");
    }
    const row: JobQueueRow = {
      id: `jq_${randomUUID()}`,
      taskId,
      priority,
      status: "pending",
      leasedAt: null,
      leasedBy: null,
      leaseExpiry: null,
      createdAt: new Date().toISOString(),
      failedReason: null,
    };
    this.db.prepare(`
      INSERT INTO job_queue (id, taskId, priority, status, leasedAt, leasedBy, leaseExpiry, createdAt, failedReason)
      VALUES (@id, @taskId, @priority, @status, @leasedAt, @leasedBy, @leaseExpiry, @createdAt, @failedReason)
    `).run(row);
    return row;
  }

  lease(workerId: string, timeoutMs = this.leaseTimeoutMs): JobQueueRow | undefined {
    const now = new Date();
    const nowIso = now.toISOString();
    const leaseExpiry = new Date(now.getTime() + Math.max(1, timeoutMs)).toISOString();

    const tx = this.db.transaction((wid: string, at: string, exp: string) => {
      const candidate = this.db.prepare(`
        SELECT * FROM job_queue
        WHERE status = 'pending'
        ORDER BY priority DESC, createdAt ASC, rowid ASC
        LIMIT 1
      `).get() as any;
      if (!candidate) return undefined;

      const info = this.db.prepare(`
        UPDATE job_queue
        SET status = 'leased', leasedAt = ?, leasedBy = ?, leaseExpiry = ?
        WHERE id = ? AND status = 'pending'
      `).run(at, wid, exp, candidate.id);
      if (info.changes !== 1) return undefined;
      return this.db.prepare(`SELECT * FROM job_queue WHERE id = ?`).get(candidate.id) as any;
    });

    const row = tx.immediate(workerId, nowIso, leaseExpiry);
    return row ? this.mapRow(row) : undefined;
  }

  complete(jobId: string): boolean {
    const info = this.db.prepare(`
      UPDATE job_queue
      SET status = 'completed', leasedAt = NULL, leasedBy = NULL, leaseExpiry = NULL, failedReason = NULL
      WHERE id = ? AND status = 'leased'
    `).run(jobId);
    return info.changes > 0;
  }

  fail(jobId: string, reason: string): boolean {
    const info = this.db.prepare(`
      UPDATE job_queue
      SET status = 'failed', leasedAt = NULL, leasedBy = NULL, leaseExpiry = NULL, failedReason = ?
      WHERE id = ? AND status IN ('leased','pending')
    `).run(reason, jobId);
    return info.changes > 0;
  }

  requeueExpiredLeases(now = new Date()): number {
    const nowIso = now.toISOString();
    const info = this.db.prepare(`
      UPDATE job_queue
      SET status = 'pending', leasedAt = NULL, leasedBy = NULL, leaseExpiry = NULL
      WHERE status = 'leased' AND leaseExpiry IS NOT NULL AND leaseExpiry <= ?
    `).run(nowIso);
    if (info.changes > 0) {
      logger.warn({ recovered: info.changes }, "re-queued expired leased jobs");
    }
    return info.changes;
  }

  startRecoveryWatchdog(intervalMs = this.recoveryIntervalMs): void {
    if (this.recoveryTimer) return;
    this.recoveryTimer = setInterval(() => {
      try {
        this.requeueExpiredLeases();
      } catch (err) {
        logger.error({ err }, "lease recovery watchdog failed");
      }
    }, intervalMs);
    this.recoveryTimer.unref?.();
  }

  stopRecoveryWatchdog(): void {
    if (this.recoveryTimer) clearInterval(this.recoveryTimer);
    this.recoveryTimer = null;
  }

  counts(): { pending: number; leased: number; completed: number; failed: number } {
    const rows = this.db.prepare(`
      SELECT status, COUNT(*) as c FROM job_queue GROUP BY status
    `).all() as Array<{ status: string; c: number }>;
    const out = { pending: 0, leased: 0, completed: 0, failed: 0 };
    for (const r of rows) {
      if (r.status in out) (out as any)[r.status] = Number(r.c);
    }
    return out;
  }

  getJob(id: string): JobQueueRow | undefined {
    const row = this.db.prepare(`SELECT * FROM job_queue WHERE id = ?`).get(id) as any;
    return row ? this.mapRow(row) : undefined;
  }

  close(): void {
    this.stopRecoveryWatchdog();
    this.db.close();
  }

  private mapRow(row: any): JobQueueRow {
    return {
      id: row.id,
      taskId: row.taskId,
      priority: Number(row.priority) as QueuePriority,
      status: row.status,
      leasedAt: row.leasedAt ?? null,
      leasedBy: row.leasedBy ?? null,
      leaseExpiry: row.leaseExpiry ?? null,
      createdAt: row.createdAt,
      failedReason: row.failedReason ?? null,
    };
  }
}

export class WorkerPool {
  private readonly queue: TaskQueue;
  private readonly workerCount: number;
  private readonly leaseTimeoutMs: number;
  private readonly pollIntervalMs: number;
  private readonly handler: (job: JobQueueRow) => Promise<void>;
  private timers: NodeJS.Timeout[] = [];
  private running = false;
  private active = 0;

  constructor(options: {
    queue: TaskQueue;
    handler: (job: JobQueueRow) => Promise<void>;
    workerCount?: number;
    leaseTimeoutMs?: number;
    pollIntervalMs?: number;
  }) {
    this.queue = options.queue;
    this.handler = options.handler;
    this.workerCount = Math.max(1, options.workerCount ?? Number(process.env.WORKER_CONCURRENCY ?? 3) || 3);
    this.leaseTimeoutMs = options.leaseTimeoutMs ?? 30_000;
    this.pollIntervalMs = options.pollIntervalMs ?? 100;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.queue.startRecoveryWatchdog(30_000);
    for (let i = 0; i < this.workerCount; i++) {
      const workerId = `worker_${i + 1}_${randomUUID().slice(0, 8)}`;
      const loop = async () => {
        if (!this.running) return;
        if (this.active >= this.workerCount) {
          this.timers[i] = setTimeout(loop, this.pollIntervalMs);
          return;
        }
        const job = this.queue.lease(workerId, this.leaseTimeoutMs);
        if (!job) {
          this.timers[i] = setTimeout(loop, this.pollIntervalMs);
          return;
        }
        this.active += 1;
        try {
          await this.handler(job);
          this.queue.complete(job.id);
        } catch (err: any) {
          this.queue.fail(job.id, err?.message ?? String(err));
        } finally {
          this.active -= 1;
          this.timers[i] = setTimeout(loop, 0);
        }
      };
      this.timers[i] = setTimeout(loop, 0);
    }
  }

  async stop(): Promise<void> {
    this.running = false;
    for (const t of this.timers) clearTimeout(t);
    this.timers = [];
    this.queue.stopRecoveryWatchdog();
    while (this.active > 0) {
      await new Promise((r) => setTimeout(r, 20));
    }
  }

  getActiveCount(): number {
    return this.active;
  }

  getWorkerCount(): number {
    return this.workerCount;
  }
}
