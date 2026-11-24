/**
 * Idempotency store — prevents duplicate task creation on retried submissions.
 *
 * ### How it works
 *
 * 1. A client sends an `Idempotency-Key` header with `POST /api/tasks`.
 * 2. The middleware **reserves** the `(wallet, key)` slot *before* the handler
 *    is dispatched:
 *    - **Reserved** — the caller owns the slot and executes the handler.
 *    - **Replay** — a completed record already exists; the stored response is
 *      returned and the handler is never invoked.
 *    - **Conflict** — a reservation is still in flight for the same
 *      `(wallet, key)`; the caller gets a 409 and the handler is never invoked.
 * 3. After the handler returns, the reservation is **promoted** to a completed
 *    record holding the response envelope.
 * 4. If the handler fails (4xx/5xx/throw) the reservation is **released** so a
 *    genuine retry is not blocked by the failure.
 * 5. A background cleanup sweep runs every `cleanupIntervalMs` (default 5 min)
 *    and deletes entries past their TTL.
 *
 * ### Why the reservation is inserted *before* dispatch
 *
 * The previous implementation looked the key up and only wrote the response
 * *after* the handler finished — a check-then-execute race. Two concurrent
 * requests carrying the same key both missed the lookup and both ran the
 * handler, so a double-clicked payment button charged twice while the store
 * still looked correct. `reserve()` is a single `INSERT OR IGNORE` against a
 * composite `(wallet, key)` primary key, so of N concurrent callers exactly
 * one can win; the rest observe `conflict` or `replay`.
 *
 * ### Storage
 *
 * SQLite-backed via `better-sqlite3`.  The DDL is applied inline so the store
 * can be instantiated without an external migration tool (tests, single-process
 * deploys).  Accepts an existing `Database.Database` instance or creates an
 * in-memory store when none is provided.
 *
 * ### Fencing token
 *
 * A reservation is identified by a random `reservationId`.  Promotion and
 * release both require that id to still match the stored row, so a handler
 * that outlives its reservation TTL (and whose slot has meanwhile been
 * reclaimed by a fresh request) can never overwrite the newer request's
 * response.
 *
 * ### Thread safety
 *
 * `better-sqlite3` is synchronous and serialised; concurrent access from
 * multiple Express handlers on the same Node.js thread is safe.  Across
 * processes sharing the same SQLite file the primary-key constraint on
 * `(wallet, key)` provides the mutual exclusion.
 */

import Database from 'better-sqlite3';
import { randomUUID } from 'crypto';
import { createLogger } from '../utils/logger';
import { config } from '../config';
import { resolveDatabasePath, isInMemoryPath, openDatabase } from '../db/index';
import type { Config } from '../config';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Lifecycle state of a stored idempotency slot. */
export type IdempotencyStatus = 'pending' | 'completed';

/** The outcome of trying to claim an `(wallet, key)` slot. */
export type IdempotencyReservationStatus = 'reserved' | 'replay' | 'conflict';

export interface IdempotencyEntry {
  /** Wallet the key is scoped to. */
  wallet: string;
  /** The client-supplied idempotency key. */
  key: string;
  /** Whether the slot is still in flight or holds a replayable response. */
  status: IdempotencyStatus;
  /** HTTP status code of the original response. Absent while `pending`. */
  statusCode?: number;
  /** Serialised response body (JSON string). Absent while `pending`. */
  responseBody?: string;
  /** ISO-8601 timestamp when the entry was created. */
  createdAt: string;
  /** ISO-8601 timestamp when the entry expires. */
  expiresAt: string;
}

export interface IdempotencyReservation {
  status: IdempotencyReservationStatus;
  /**
   * Fencing token that must be presented to `complete()` / `release()`.
   * Present when `status === 'reserved'`.
   */
  reservationId?: string;
  /** The stored response. Present when `status === 'replay'`. */
  entry?: IdempotencyEntry;
}

export interface IdempotencyStoreOptions {
  /** Time-to-live in milliseconds for completed records.  Default: 24 h. */
  ttlMs?: number;
  /**
   * Time-to-live in milliseconds for *pending* reservations.  Kept short so a
   * handler that dies without releasing its slot does not block the key for a
   * full day.  Default: 5 min.
   */
  pendingTtlMs?: number;
  /** Background cleanup interval in ms.  Default: 5 min.  Set to 0 to disable. */
  cleanupIntervalMs?: number;
}

export interface IdempotencyStore {
  /**
   * Atomically claim `(wallet, key)` before the handler is dispatched.
   * Exactly one concurrent caller receives `reserved`.
   */
  reserve(wallet: string, key: string): IdempotencyReservation;
  /**
   * Promote a pending reservation to a completed record holding the response.
   * No-op unless `reservationId` still matches the stored row.
   */
  complete(
    wallet: string,
    key: string,
    reservationId: string,
    statusCode: number,
    body: unknown,
  ): void;
  /**
   * Drop a pending reservation so the key can be retried.  No-op unless
   * `reservationId` still matches the stored row.
   */
  release(wallet: string, key: string, reservationId: string): void;
  /** Look up an entry by `(wallet, key)`.  Returns `undefined` when absent. */
  get(wallet: string, key: string): IdempotencyEntry | undefined;
  /** Delete a single entry. */
  delete(wallet: string, key: string): void;
  /** Remove all expired entries.  Returns the count of deleted rows. */
  cleanup(): number;
  /** Start the background cleanup interval.  Idempotent. */
  startCleanup(): void;
  /** Stop the background cleanup interval.  Idempotent. */
  stopCleanup(): void;
  /** Release the underlying database handle. */
  close(): void;
}

// ---------------------------------------------------------------------------
// DDL
// ---------------------------------------------------------------------------

/**
 * Slots are scoped to `(wallet, key)` so one client can never replay another
 * client's stored response, and so the same key may legitimately be reused by
 * two different wallets.
 */
const DDL = `
  CREATE TABLE IF NOT EXISTS idempotency_keys (
    wallet         TEXT    NOT NULL,
    key            TEXT    NOT NULL,
    status         TEXT    NOT NULL,
    reservation_id TEXT    NOT NULL,
    status_code    INTEGER,
    body           TEXT,
    created_at     TEXT    NOT NULL,
    expires_at     TEXT    NOT NULL,
    PRIMARY KEY (wallet, key)
  );

  CREATE INDEX IF NOT EXISTS idx_idempotency_expires_at
    ON idempotency_keys (expires_at);
`;

/**
 * Create the current schema, transparently upgrading a pre-#658 table.
 *
 * The legacy table keyed rows on `key` alone with a non-null response, so its
 * rows cannot be attributed to a wallet — carrying them forward would preserve
 * exactly the cross-wallet replay hole this change closes.  They are therefore
 * dropped; the table is only a short-lived response cache, so the only cost is
 * that a retry within the old 24 h window is no longer replayed.
 */
function applySchema(database: Database.Database, log: { warn: (o: unknown, m: string) => void }): void {
  const columns = database.prepare('PRAGMA table_info(idempotency_keys)').all() as {
    name: string;
  }[];
  const isLegacy =
    columns.length > 0 && !columns.some((column) => column.name === 'wallet');

  if (isLegacy) {
    // Renaming first, then dropping, releases the legacy table's indexes so the
    // same index names can be reused below.
    database.exec('ALTER TABLE idempotency_keys RENAME TO idempotency_keys_legacy');
    database.exec('DROP TABLE idempotency_keys_legacy');
    log.warn(
      { table: 'idempotency_keys' },
      'upgraded legacy unscoped idempotency table to wallet-scoped schema; cached responses were dropped',
    );
  }

  database.exec(DDL);
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
const DEFAULT_PENDING_TTL_MS = 5 * 60 * 1000; // 5 minutes
const DEFAULT_CLEANUP_MS = 5 * 60 * 1000; // 5 minutes

export function createIdempotencyStore(
  db?: Database.Database | string,
  options: IdempotencyStoreOptions = {},
): IdempotencyStore {
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
  const pendingTtlMs = options.pendingTtlMs ?? DEFAULT_PENDING_TTL_MS;
  const cleanupIntervalMs = options.cleanupIntervalMs ?? DEFAULT_CLEANUP_MS;

  const database =
    typeof db === 'string'
      ? new Database(db)
      : db ?? new Database(':memory:');

  database.pragma('journal_mode = WAL');
  database.pragma('busy_timeout = 5000');

  const log = createLogger({ component: 'idempotency' });

  applySchema(database, log);

  // ── Prepared statements ──────────────────────────────────────────────────

  // The reservation insert is the whole point of the fix: a single statement
  // against the composite primary key, so concurrent callers cannot both win.
  const reserveStmt = database.prepare(`
    INSERT OR IGNORE INTO idempotency_keys
      (wallet, key, status, reservation_id, status_code, body, created_at, expires_at)
    VALUES (@wallet, @key, 'pending', @reservationId, NULL, NULL, @createdAt, @expiresAt)
  `);

  // Deliberately unfiltered by expiry: an expired row is reclaimable, and the
  // caller has to be able to see it to know that.
  const selectStmt = database.prepare(`
    SELECT wallet, key, status, status_code, body, created_at, expires_at
    FROM idempotency_keys
    WHERE wallet = ? AND key = ?
  `);

  const deleteExpiredStmt = database.prepare(`
    DELETE FROM idempotency_keys
    WHERE wallet = ? AND key = ? AND expires_at <= ?
  `);

  const completeStmt = database.prepare(`
    UPDATE idempotency_keys
    SET status = 'completed',
        status_code = @statusCode,
        body = @body,
        expires_at = @expiresAt
    WHERE wallet = @wallet AND key = @key
      AND status = 'pending' AND reservation_id = @reservationId
  `);

  const releaseStmt = database.prepare(`
    DELETE FROM idempotency_keys
    WHERE wallet = ? AND key = ? AND status = 'pending' AND reservation_id = ?
  `);

  const deleteStmt = database.prepare(`
    DELETE FROM idempotency_keys WHERE wallet = ? AND key = ?
  `);

  const cleanupStmt = database.prepare(`
    DELETE FROM idempotency_keys WHERE expires_at <= ?
  `);

  // ── Helpers ──────────────────────────────────────────────────────────────

  function toEntry(row: {
    wallet: string;
    key: string;
    status: string;
    status_code: number | null;
    body: string | null;
    created_at: string;
    expires_at: string;
  }): IdempotencyEntry {
    return {
      wallet: row.wallet,
      key: row.key,
      status: row.status === 'pending' ? 'pending' : 'completed',
      statusCode: row.status_code ?? undefined,
      responseBody: row.body ?? undefined,
      createdAt: row.created_at,
      expiresAt: row.expires_at,
    };
  }

  // ── Cleanup interval ─────────────────────────────────────────────────────

  let cleanupTimer: ReturnType<typeof setInterval> | null = null;

  // ── Public API ───────────────────────────────────────────────────────────

  const store: IdempotencyStore = {
    reserve(wallet: string, key: string): IdempotencyReservation {
      const reservationId = randomUUID();

      // Bounded retry: an expired row may need reclaiming before the insert can
      // succeed, and two processes can race for the same reclaimed slot.
      for (let attempt = 0; attempt < 3; attempt++) {
        const now = new Date();
        const nowIso = now.toISOString();
        const expiresAt = new Date(now.getTime() + pendingTtlMs).toISOString();

        const inserted = reserveStmt.run({
          wallet,
          key,
          reservationId,
          createdAt: nowIso,
          expiresAt,
        });

        if (inserted.changes === 1) {
          return { status: 'reserved', reservationId };
        }

        // Someone already owns the slot — replay it, reject it, or reclaim it.
        const row = selectStmt.get(wallet, key) as
          | {
              wallet: string;
              key: string;
              status: string;
              status_code: number | null;
              body: string | null;
              created_at: string;
              expires_at: string;
            }
          | undefined;

        if (!row) continue; // Deleted between the failed insert and this read.

        if (row.expires_at <= nowIso) {
          deleteExpiredStmt.run(wallet, key, nowIso);
          continue;
        }

        if (row.status === 'completed') {
          return { status: 'replay', entry: toEntry(row) };
        }

        // Still in flight for this (wallet, key) — never run the handler again.
        return { status: 'conflict' };
      }

      // Could not claim the slot without stealing it.  Refusing is the safe
      // outcome: the alternative is a second side effect.
      return { status: 'conflict' };
    },

    complete(
      wallet: string,
      key: string,
      reservationId: string,
      statusCode: number,
      body: unknown,
    ): void {
      const expiresAt = new Date(Date.now() + ttlMs).toISOString();
      completeStmt.run({
        wallet,
        key,
        reservationId,
        statusCode,
        body: JSON.stringify(body),
        expiresAt,
      });
    },

    release(wallet: string, key: string, reservationId: string): void {
      releaseStmt.run(wallet, key, reservationId);
    },

    get(wallet: string, key: string): IdempotencyEntry | undefined {
      const row = selectStmt.get(wallet, key) as
        | {
            wallet: string;
            key: string;
            status: string;
            status_code: number | null;
            body: string | null;
            created_at: string;
            expires_at: string;
          }
        | undefined;
      return row ? toEntry(row) : undefined;
    },

    delete(wallet: string, key: string): void {
      deleteStmt.run(wallet, key);
    },

    cleanup(): number {
      const now = new Date().toISOString();
      const result = cleanupStmt.run(now);
      const deleted = result.changes;
      if (deleted > 0) {
        log.info({ deleted }, 'expired idempotency entries cleaned up');
      }
      return deleted;
    },

    startCleanup(): void {
      if (cleanupTimer !== null) return;
      if (cleanupIntervalMs <= 0) return;

      // Run an initial cleanup on start.
      store.cleanup();

      cleanupTimer = setInterval(() => {
        try {
          store.cleanup();
        } catch (err) {
          log.error({ err }, 'idempotency cleanup failed');
        }
      }, cleanupIntervalMs);

      // Unref so the timer does not keep the process alive.
      if (cleanupTimer && typeof cleanupTimer === 'object' && 'unref' in cleanupTimer) {
        (cleanupTimer as NodeJS.Timeout).unref();
      }
    },

    stopCleanup(): void {
      if (cleanupTimer !== null) {
        clearInterval(cleanupTimer);
        cleanupTimer = null;
      }
    },

    close(): void {
      store.stopCleanup();
      database.close();
    },
  };

  return store;
}

// ---------------------------------------------------------------------------
// Singleton (used by the application unless overridden in tests)
// ---------------------------------------------------------------------------

let _defaultStore: IdempotencyStore | null = null;

/**
 * Get or create the default singleton idempotency store.
 *
 * - In `test` environments the store uses an in-memory database (fast, no
 *   disk I/O, isolated per test run).
 * - In all other environments the store opens the same file-backed SQLite
 *   database as the rest of the backend (resolved from `DB_PATH` /
 *   `DATABASE_URL`), ensuring idempotency keys survive a process restart and
 *   are shared when the same file is mounted by multiple processes.
 *
 * The store is lazily initialised on first call.
 */
export function getDefaultIdempotencyStore(
  configOverride?: Pick<
    Config,
    | 'NODE_ENV'
    | 'IDEMPOTENCY_TTL_MS'
    | 'IDEMPOTENCY_PENDING_TTL_MS'
    | 'IDEMPOTENCY_CLEANUP_MS'
  >,
): IdempotencyStore {
  if (!_defaultStore) {
    const isTest = (configOverride?.NODE_ENV ?? config.NODE_ENV) === 'test';

    let db: Database.Database;
    if (isTest) {
      db = new Database(':memory:');
    } else {
      // Reuse the main application database file so idempotency keys survive
      // restarts and are consistent across any replicas that share the same
      // SQLite file (e.g. single-node deploys with a bind-mounted volume).
      const dbPath = resolveDatabasePath();
      db = isInMemoryPath(dbPath) ? new Database(':memory:') : openDatabase(dbPath);
    }

    _defaultStore = createIdempotencyStore(db, {
      ttlMs: configOverride?.IDEMPOTENCY_TTL_MS ?? config.IDEMPOTENCY_TTL_MS,
      cleanupIntervalMs: configOverride?.IDEMPOTENCY_CLEANUP_MS ?? config.IDEMPOTENCY_CLEANUP_MS,
    });
  }
  return _defaultStore;
}

/** Reset the singleton — only for test teardown. */
export function resetDefaultIdempotencyStore(): void {
  if (_defaultStore) {
    _defaultStore.stopCleanup();
    _defaultStore = null;
  }
}
