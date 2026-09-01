/**
 * SQLite connection pool.
 *
 * `better-sqlite3` is synchronous and a single `Database` handle serialises
 * every statement run through it. Under concurrent load that turns unrelated
 * reads into a queue behind whatever write happens to be in flight.
 *
 * This pool splits the two access patterns:
 *
 *  - **Reads** are served from a set of read-only handles. With `journal_mode
 *    = WAL`, readers do not block the writer and the writer does not block
 *    readers, so these run genuinely in parallel with respect to the OS.
 *  - **Writes** go through a single writer handle behind a FIFO queue, which
 *    is what SQLite requires anyway: there can only ever be one writer.
 *
 * Readers are opened lazily between `min` and `max`. An acquire that finds no
 * idle reader and cannot grow the pool waits up to `acquireTimeoutMs` before
 * rejecting, so a saturated pool sheds load instead of hanging.
 *
 * @example
 *   const pool = createPool({ filePath: "tasks.db" });
 *   const row = await pool.read((db) => db.prepare("SELECT 1 AS n").get());
 *   await pool.write((db) => db.prepare("INSERT INTO t VALUES (?)").run(1));
 *   await pool.close();
 */

import Database from "better-sqlite3";
import { createLogger } from "../utils/logger";

const logger = createLogger({ component: "db-pool" });

/** Tunables for a single pool instance. */
export interface PoolOptions {
  /** Path to the SQLite database file. */
  filePath: string;
  /** Reader connections opened eagerly at construction. Default: 2. */
  min?: number;
  /** Upper bound on reader connections. Default: 10. */
  max?: number;
  /** How long `read` waits for a free reader before rejecting, in ms. Default: 5000. */
  acquireTimeoutMs?: number;
  /** Run `SELECT 1` on a reader before handing it out. Default: true. */
  healthCheck?: boolean;
  /** Applied to every new connection, e.g. to create tables. */
  onCreate?: (db: Database.Database) => void;
}

/** Point-in-time view of pool utilisation. */
export interface PoolMetrics {
  /** Readers currently checked out. */
  activeConnections: number;
  /** Readers open and available. */
  idleConnections: number;
  /** Readers open in total (active + idle). */
  totalConnections: number;
  /** Callers currently waiting for a reader. */
  pendingAcquires: number;
  /** Writes queued behind the writer, excluding the one running. */
  pendingWrites: number;
  /** Reader acquisitions served since construction. */
  totalAcquires: number;
  /** Acquisitions that rejected on timeout. */
  timedOutAcquires: number;
  /** Connections discarded because their health check failed. */
  failedHealthChecks: number;
  /** Mean wait for a reader, in ms. */
  averageWaitMs: number;
  /** Longest wait for a reader, in ms. */
  maxWaitMs: number;
}

/** A pooled SQLite database. */
export interface SqlitePool {
  /** Run `fn` on a read-only connection, which is held until `fn` settles. */
  read<T>(fn: (db: Database.Database) => T | PromiseLike<T>): Promise<T>;
  /** Run `fn` on the writer, serialised behind any queued writes. */
  write<T>(fn: (db: Database.Database) => T | PromiseLike<T>): Promise<T>;
  /**
   * Run `fn` on the writer inside a transaction, rolling back if it throws.
   *
   * `fn` must be synchronous: better-sqlite3 transactions cannot span an
   * await, because another statement could interleave before the commit.
   */
  transaction<T>(fn: (db: Database.Database) => T): Promise<T>;
  /** Current utilisation snapshot. */
  metrics(): PoolMetrics;
  /** Drain in-flight work, then close every connection. Idempotent. */
  close(): Promise<void>;
  /** True once `close` has been called. */
  readonly closed: boolean;
  /**
   * The writer handle, for callers that still use the synchronous API.
   *
   * Statements issued directly on this handle bypass the write queue. That is
   * safe for individual statements, because better-sqlite3 runs them to
   * completion synchronously, but a multi-statement transaction started here
   * could interleave with an async body passed to `write`. Prefer
   * `transaction` for anything spanning more than one statement.
   */
  readonly writer: Database.Database;
}

export const DEFAULT_MIN_CONNECTIONS = 2;
export const DEFAULT_MAX_CONNECTIONS = 10;
export const DEFAULT_ACQUIRE_TIMEOUT_MS = 5_000;

interface Waiter {
  resolve: (db: Database.Database) => void;
  reject: (err: Error) => void;
  /** Set when the waiter is settled, so a late timer becomes a no-op. */
  settled: boolean;
  timer: NodeJS.Timeout;
  queuedAt: number;
}

/** Raised when no reader becomes available within `acquireTimeoutMs`. */
export class PoolTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`Timed out acquiring a database connection after ${timeoutMs}ms`);
    this.name = "PoolTimeoutError";
  }
}

/** Raised when the pool is used after `close`. */
export class PoolClosedError extends Error {
  constructor() {
    super("Connection pool has been closed");
    this.name = "PoolClosedError";
  }
}

function applyPragmas(db: Database.Database, readonly: boolean): void {
  // WAL lets readers and the writer proceed concurrently. It is a property of
  // the database file, so setting it on the writer covers every connection,
  // but a read-only handle cannot set it at all.
  if (!readonly) {
    db.pragma("journal_mode = WAL");
    // NORMAL is the recommended durability level under WAL: still crash-safe,
    // without an fsync on every commit.
    db.pragma("synchronous = NORMAL");
  }
  db.pragma("busy_timeout = 5000");
  db.pragma("foreign_keys = ON");
}

/**
 * Create a pool over `filePath`.
 *
 * The writer is opened eagerly so the schema exists before any reader attaches
 * to the file; read-only handles cannot create one.
 */
export function createPool(options: PoolOptions): SqlitePool {
  const {
    filePath,
    min = DEFAULT_MIN_CONNECTIONS,
    max = DEFAULT_MAX_CONNECTIONS,
    acquireTimeoutMs = DEFAULT_ACQUIRE_TIMEOUT_MS,
    healthCheck = true,
    onCreate,
  } = options;

  if (min < 1) throw new RangeError("pool min must be at least 1");
  if (max < min) throw new RangeError("pool max must be >= min");

  // The writer also creates the file and runs `onCreate`, so it must exist
  // before any read-only handle is opened.
  const writer = new Database(filePath);
  applyPragmas(writer, false);
  onCreate?.(writer);

  const idle: Database.Database[] = [];
  const waiters: Waiter[] = [];
  const writeQueue: Array<() => void> = [];

  let openReaders = 0;
  let activeReaders = 0;
  let writing = false;
  let closed = false;

  let totalAcquires = 0;
  let timedOutAcquires = 0;
  let failedHealthChecks = 0;
  let totalWaitMs = 0;
  let maxWaitMs = 0;

  function openReader(): Database.Database {
    const db = new Database(filePath, { readonly: true });
    applyPragmas(db, true);
    openReaders += 1;
    return db;
  }

  /** `SELECT 1` round-trip; a throw means the handle is unusable. */
  function isHealthy(db: Database.Database): boolean {
    if (!healthCheck) return true;
    try {
      db.prepare("SELECT 1").get();
      return true;
    } catch (err) {
      logger.warn({ err }, "pooled connection failed its health check");
      return false;
    }
  }

  /** Close a handle and stop counting it as open. */
  function closeHandle(db: Database.Database): void {
    openReaders -= 1;
    try {
      db.close();
    } catch {
      // Already closed or closing; nothing useful to do.
    }
  }

  /** Drop a handle that failed its health check. */
  function discard(db: Database.Database): void {
    failedHealthChecks += 1;
    closeHandle(db);
  }

  function recordWait(ms: number): void {
    totalAcquires += 1;
    totalWaitMs += ms;
    if (ms > maxWaitMs) maxWaitMs = ms;
  }

  function acquire(): Promise<Database.Database> {
    if (closed) return Promise.reject(new PoolClosedError());

    // Drain any idle handle that still answers a ping.
    while (idle.length > 0) {
      const db = idle.pop() as Database.Database;
      if (isHealthy(db)) {
        activeReaders += 1;
        recordWait(0);
        return Promise.resolve(db);
      }
      discard(db);
    }

    if (openReaders < max) {
      const db = openReader();
      activeReaders += 1;
      recordWait(0);
      return Promise.resolve(db);
    }

    // Saturated: wait for a release, or give up.
    return new Promise<Database.Database>((resolve, reject) => {
      const waiter: Waiter = {
        resolve,
        reject,
        settled: false,
        queuedAt: Date.now(),
        timer: setTimeout(() => {
          if (waiter.settled) return;
          waiter.settled = true;
          const index = waiters.indexOf(waiter);
          if (index !== -1) waiters.splice(index, 1);
          timedOutAcquires += 1;
          reject(new PoolTimeoutError(acquireTimeoutMs));
        }, acquireTimeoutMs),
      };
      waiters.push(waiter);
    });
  }

  function release(db: Database.Database): void {
    activeReaders -= 1;

    if (closed) {
      closeHandle(db);
      return;
    }

    // Hand straight to the longest-waiting caller, skipping any that timed out.
    while (waiters.length > 0) {
      const waiter = waiters.shift() as Waiter;
      if (waiter.settled) continue;
      waiter.settled = true;
      clearTimeout(waiter.timer);

      if (!isHealthy(db)) {
        // Discarding frees a slot, so the pool is now below `max` and a
        // replacement can always be opened for the waiter.
        discard(db);
        const fresh = openReader();
        activeReaders += 1;
        recordWait(Date.now() - waiter.queuedAt);
        waiter.resolve(fresh);
        return;
      }

      activeReaders += 1;
      recordWait(Date.now() - waiter.queuedAt);
      waiter.resolve(db);
      return;
    }

    if (!isHealthy(db)) {
      discard(db);
      return;
    }

    // Shrink back toward `min` rather than holding every handle we ever opened.
    if (idle.length >= min) {
      closeHandle(db);
      return;
    }

    idle.push(db);
  }

  async function read<T>(fn: (db: Database.Database) => T | PromiseLike<T>): Promise<T> {
    const db = await acquire();
    try {
      // Awaited so an async body cannot outlive the connection it is using.
      return await fn(db);
    } finally {
      release(db);
    }
  }

  /** Serialise writes so only one runs against the writer handle at a time. */
  function enqueueWrite<T>(run: () => T | PromiseLike<T>): Promise<T> {
    if (closed) return Promise.reject(new PoolClosedError());

    return new Promise<T>((resolve, reject) => {
      const task = async () => {
        writing = true;
        try {
          // Awaited before the queue advances, so an async body still holds
          // the writer exclusively for its whole duration.
          resolve(await run());
        } catch (err) {
          reject(err as Error);
        } finally {
          writing = false;
          const next = writeQueue.shift();
          if (next) next();
        }
      };

      if (writing) writeQueue.push(task);
      else void task();
    });
  }

  function write<T>(fn: (db: Database.Database) => T | PromiseLike<T>): Promise<T> {
    return enqueueWrite(() => fn(writer));
  }

  function transaction<T>(fn: (db: Database.Database) => T): Promise<T> {
    // better-sqlite3's `transaction()` wrapper rolls back if the body throws.
    return enqueueWrite(() => writer.transaction(() => fn(writer))());
  }

  function metrics(): PoolMetrics {
    return {
      activeConnections: activeReaders,
      idleConnections: idle.length,
      totalConnections: openReaders,
      pendingAcquires: waiters.filter((w) => !w.settled).length,
      pendingWrites: writeQueue.length,
      totalAcquires,
      timedOutAcquires,
      failedHealthChecks,
      averageWaitMs: totalAcquires === 0 ? 0 : totalWaitMs / totalAcquires,
      maxWaitMs,
    };
  }

  async function close(): Promise<void> {
    if (closed) return;
    closed = true;

    // Reject anyone still queued; they will never be served.
    while (waiters.length > 0) {
      const waiter = waiters.shift() as Waiter;
      if (waiter.settled) continue;
      waiter.settled = true;
      clearTimeout(waiter.timer);
      waiter.reject(new PoolClosedError());
    }

    // Let in-flight reads and the current write finish before closing handles;
    // closing underneath a running statement would abort it.
    const deadline = Date.now() + DEFAULT_ACQUIRE_TIMEOUT_MS;
    while ((activeReaders > 0 || writing) && Date.now() < deadline) {
      await new Promise((r) => setImmediate(r));
    }

    while (idle.length > 0) {
      closeHandle(idle.pop() as Database.Database);
    }

    try {
      writer.close();
    } catch {
      // Best effort.
    }

    logger.info({ filePath }, "connection pool closed");
  }

  // Warm the pool to `min` so the first requests do not pay connection setup.
  for (let i = 0; i < min; i += 1) {
    idle.push(openReader());
  }

  return {
    read,
    write,
    transaction,
    metrics,
    close,
    get closed() {
      return closed;
    },
    get writer() {
      return writer;
    },
  };
}
