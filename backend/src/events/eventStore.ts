/**
 * Append-only SQLite-backed event store.
 *
 * Responsibilities
 * ────────────────
 * • Persist every {@link AppEvent} with a globally-unique `globalSeq` and a
 *   per-task `taskSeq` (the per-task cursor assigned upstream by the EventBus).
 * • Expose read queries needed by replay, projection, and WebSocket resume.
 *
 * Schema ownership
 * ────────────────
 * The DDL is defined in exactly one place — the migration system:
 *   backend/src/db/migrations/tasks/002_create_task_events_table.up.sql  (schema B)
 *   backend/src/db/migrations/tasks/006_replace_task_events_schema.up.sql (schema A)
 *
 * When `createEventStore` is called without a pre-migrated database (e.g. in
 * unit tests or when operating against an in-memory DB), it applies both
 * migration files in sequence — exactly what the production migrator does —
 * so the resulting schema is identical regardless of how the store is created.
 *
 * There is no separate `events.sql` DDL: the migration files ARE the single
 * source of truth.
 */

import Database from 'better-sqlite3';
import { readFileSync } from 'fs';
import { mkdirSync } from 'fs';
import { dirname, isAbsolute, join } from 'path';
import type { AppEvent } from './eventTypes';
import { validateEvent } from './schemaRegistry';
import { createLogger } from '../utils/logger';

const log = createLogger({ component: 'eventStore' });
import type { EventArchive } from './eventArchive';
import { createEventArchive } from './eventArchive';
import { getConfig } from '../config';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** An event that has been committed to the store and carries both seq fields. */
export type StoredEvent = AppEvent & {
  /** Globally-ordered sequence number assigned on INSERT. */
  globalSeq: number;
  /** Per-task monotonic cursor (matches the value stamped by EventBus). */
  taskSeq: number;
  // Re-surface shared BaseEvent fields so callers don't need to narrow
  // the discriminated union before reading these universally-present fields.
  type: AppEvent['type'];
  taskId: string;
  occurredAt: string;
  version: number;
};

/** Options accepted by time-range queries. */
export interface TimeRangeOptions {
  /** ISO-8601 start (inclusive). */
  from: string;
  /** ISO-8601 end (inclusive). */
  to: string;
}

/** The public contract of the event store. */
export interface EventStore {
  /**
   * Atomically append an event.  The `taskSeq` field on the incoming event is
   * used as the per-task cursor (it must already be stamped by the EventBus).
   * Returns the stored event with `globalSeq` filled in.
   */
  append(event: AppEvent): StoredEvent;

  /** All events for a task in chronological order (full replay). */
  listByTask(taskId: string): StoredEvent[];

  /**
   * Events for a task with `taskSeq` strictly greater than `afterSeq`.
   * Used for cursor-based WebSocket stream resume.
   *
   * `limit` caps how many rows are returned in a single read, so a caller that
   * needs to drain a large backlog can page through it instead of materialising
   * the whole gap in one statement. Omitting it keeps the original unbounded
   * behaviour for the replay/archive callers that genuinely want everything.
   */
  listByTaskSince(taskId: string, afterSeq: number, limit?: number): StoredEvent[];

  /**
   * All events whose `occurred_at` falls within [from, to] (ISO-8601 strings,
   * both inclusive).  Ordered by `occurred_at` ascending.
   */
  listByTimeRange(options: TimeRangeOptions): StoredEvent[];

  /**
   * All events of a specific type within an optional time range.
   * When `options` is omitted the full history is returned.
   */
  listByType(type: string, options?: TimeRangeOptions): StoredEvent[];

  /**
   * Return the highest `taskSeq` stored for every taskId that has at least one
   * event.  Used by the EventBus on startup to rehydrate its per-task sequence
   * counters so that post-restart events continue from where the previous run
   * left off rather than resetting to 0 and hitting the UNIQUE constraint.
   *
   * Returns a Map keyed by taskId, value = max taskSeq stored for that task.
   */
  maxTaskSeqPerTask(): Map<string, number>;

  /**
   * Retention archive sharing this store's database file.
   *
   * Holds `task_event_archive` (full-fidelity copies of purged events) and
   * `task_event_summary` (the materialized per-task/per-node projection).
   * Because it shares the connection, archive + purge happen in a single
   * transaction — see `EventArchive.compactTask`.
   */
  archive: EventArchive;

  /** Release the underlying database connection. */
  close(): void;
}

// ---------------------------------------------------------------------------
// Row → AppEvent mapping
// ---------------------------------------------------------------------------

interface EventRow {
  global_seq: number;
  task_seq: number;
  version: number;
  type: string;
  task_id: string;
  node_id: string | null;
  occurred_at: string;
  payload: string | null;
}

function rowToStoredEvent(row: EventRow): StoredEvent {
  const base = {
    globalSeq: row.global_seq,
    taskSeq: row.task_seq,
    version: row.version,
    type: row.type as AppEvent['type'],
    taskId: row.task_id,
    occurredAt: row.occurred_at,
  };

  const payload = row.payload != null ? JSON.parse(row.payload) : undefined;
  const extra = {
    ...(row.node_id != null ? { nodeId: row.node_id } : {}),
    ...(payload !== undefined ? { payload } : {}),
  };

  return { ...base, ...extra } as StoredEvent;
}

// ---------------------------------------------------------------------------
// DDL — loaded from the canonical migration files
// ---------------------------------------------------------------------------

/**
 * Bootstrap the task_events schema in a database that has NOT been migrated
 * through the full migration chain (e.g. in-memory DBs in unit tests).
 *
 * The canonical schema is defined entirely within the migration system:
 *   - 002_create_task_events_table.up.sql  →  creates schema B (legacy shape)
 *   - 005_replace_task_events_schema.up.sql → transforms schema B → schema A
 *
 * Running both migrations in sequence is identical to what the production
 * migrator does, so in-memory and file-backed databases end up with exactly
 * the same schema A shape.  This is the single source of truth: no DDL is
 * duplicated outside of the migration files.
 */
function applyDDL(db: import('better-sqlite3').Database): void {
  const migrationsDir = join(__dirname, '..', 'db', 'migrations', 'tasks');
  const migration002 = readFileSync(
    join(migrationsDir, '002_create_task_events_table.up.sql'),
    'utf8',
  );
  const migration005 = readFileSync(
    join(migrationsDir, '006_replace_task_events_schema.up.sql'),
    'utf8',
  );
  db.exec(migration002);
  db.exec(migration005);
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a SQLite-backed {@link EventStore}.
 *
 * @param db  An existing better-sqlite3 `Database` instance, or a file path
 *            string.  Defaults to an in-memory database — suitable for a
 *            long-running server and for unit tests alike.  Production wiring
 *            goes through {@link getEventStore} so the log is actually durable;
 *            a store left on `:memory:` discards the whole event log on restart,
 *            which also makes the retention job a no-op.
 */
export function createEventStore(db?: Database.Database | string): EventStore {
  const database =
    typeof db === 'string'
      ? new Database(db)
      : db ?? new Database(':memory:');

  database.pragma('journal_mode = WAL');
  database.pragma('busy_timeout = 5000');
  applyDDL(database);

  // The archive shares this connection so archive + purge are atomic.
  const archive = createEventArchive(database);

  // ---------------------------------------------------------------------------
  // Prepared statements
  // ---------------------------------------------------------------------------

  const insertStmt = database.prepare(`
    INSERT INTO task_events
      (task_seq, version, type, task_id, node_id, occurred_at, payload)
    VALUES
      (@task_seq, @version, @type, @task_id, @node_id, @occurred_at, @payload)
  `);

  const listByTaskStmt = database.prepare(`
    SELECT * FROM task_events
    WHERE task_id = ?
    ORDER BY task_seq ASC
  `);

  const listByTaskSinceStmt = database.prepare(`
    SELECT * FROM task_events
    WHERE task_id = ? AND task_seq > ?
    ORDER BY task_seq ASC
  `);

  // Bounded variant of the cursor query. Stream flushes page through the
  // backlog with this so a single read never materialises an arbitrarily large
  // gap (see TaskStreamHub).
  const listByTaskSinceLimitedStmt = database.prepare(`
    SELECT * FROM task_events
    WHERE task_id = ? AND task_seq > ?
    ORDER BY task_seq ASC
    LIMIT ?
  `);

  const listByTimeRangeStmt = database.prepare(`
    SELECT * FROM task_events
    WHERE occurred_at >= ? AND occurred_at <= ?
    ORDER BY occurred_at ASC
  `);

  const listByTypeStmt = database.prepare(`
    SELECT * FROM task_events
    WHERE type = ?
    ORDER BY occurred_at ASC
  `);

  const listByTypeRangeStmt = database.prepare(`
    SELECT * FROM task_events
    WHERE type = ? AND occurred_at >= ? AND occurred_at <= ?
    ORDER BY occurred_at ASC
  `);

  const maxTaskSeqStmt = database.prepare(`
    SELECT task_id, MAX(task_seq) AS max_seq
    FROM task_events
    GROUP BY task_id
  `);

  // ---------------------------------------------------------------------------
  // Store implementation
  // ---------------------------------------------------------------------------

  return {
    append(event: AppEvent): StoredEvent {
      const validation = validateEvent(event as unknown as Parameters<typeof validateEvent>[0]);
      if (!validation.valid) {
        log.warn({ errors: validation.errors, type: event.type }, 'Event validation notice');
      }

      // taskSeq is stamped by the EventBus before this is called; fall back to
      // 0 only as a defensive measure so the insert never fails on a missing
      // value.
      const taskSeq = event.taskSeq ?? 0;

      const nodeId =
        'nodeId' in event && event.nodeId != null ? (event.nodeId as string) : null;

      const result = insertStmt.run({
        task_seq: taskSeq,
        version: event.version ?? 1,
        type: event.type,
        task_id: event.taskId,
        node_id: nodeId,
        occurred_at: event.occurredAt,
        payload:
          'payload' in event && event.payload !== undefined
            ? JSON.stringify(event.payload)
            : null,
      });

      return {
        ...event,
        taskSeq,
        globalSeq: result.lastInsertRowid as number,
      } as StoredEvent;
    },

    listByTask(taskId: string): StoredEvent[] {
      return (listByTaskStmt.all(taskId) as EventRow[]).map(rowToStoredEvent);
    },

    listByTaskSince(taskId: string, afterSeq: number, limit?: number): StoredEvent[] {
      const rows =
        limit === undefined
          ? (listByTaskSinceStmt.all(taskId, afterSeq) as EventRow[])
          : (listByTaskSinceLimitedStmt.all(taskId, afterSeq, limit) as EventRow[]);
      return rows.map(rowToStoredEvent);
    },

    listByTimeRange({ from, to }: TimeRangeOptions): StoredEvent[] {
      return (listByTimeRangeStmt.all(from, to) as EventRow[]).map(rowToStoredEvent);
    },

    listByType(type: string, options?: TimeRangeOptions): StoredEvent[] {
      if (options) {
        return (listByTypeRangeStmt.all(type, options.from, options.to) as EventRow[]).map(
          rowToStoredEvent
        );
      }
      return (listByTypeStmt.all(type) as EventRow[]).map(rowToStoredEvent);
    },

    maxTaskSeqPerTask(): Map<string, number> {
      const rows = maxTaskSeqStmt.all() as Array<{ task_id: string; max_seq: number }>;
      const result = new Map<string, number>();
      for (const { task_id, max_seq } of rows) {
        result.set(task_id, max_seq);
      }
      return result;
    },

    archive,

    close(): void {
      database.close();
    },
  };
}

// ---------------------------------------------------------------------------
// Process-wide accessor
// ---------------------------------------------------------------------------

let _eventStore: EventStore | null = null;
let _eventStoreConnection: Database.Database | null = null;

/** Absolute path (or `:memory:`) the event store is configured to use. */
export function getEventStorePath(): string {
  const configured = getConfig().EVENT_STORE_PATH;
  if (configured === ':memory:' || isAbsolute(configured)) return configured;
  return join(process.cwd(), configured);
}

/**
 * Lazily open the shared, process-wide event store.
 *
 * Follows the same accessor convention as `getTaskDb()` / `getDb()`: the
 * connection is created on first use and reused thereafter, so the EventBus,
 * the HTTP/WebSocket layer and the retention service all address the same
 * database file.  This is what makes the log durable across restarts and what
 * gives `EventBus` real `maxTaskSeqPerTask()` data to rehydrate from.
 */
export function getEventStore(): EventStore {
  if (!_eventStore) {
    const filePath = getEventStorePath();
    if (filePath !== ':memory:') {
      mkdirSync(dirname(filePath), { recursive: true });
    }
    // Open the connection here rather than letting createEventStore do it, so
    // the same handle stays available for maintenance pragmas.
    const connection = new Database(filePath);
    connection.pragma('journal_mode = WAL');
    connection.pragma('busy_timeout = 5000');
    _eventStoreConnection = connection;
    _eventStore = createEventStore(connection);
  }
  return _eventStore;
}

/**
 * The raw connection behind {@link getEventStore}, for maintenance passes that
 * need SQLite pragmas (`DbMaintenanceService`).  Null until the store is opened.
 */
export function getEventStoreConnection(): Database.Database | null {
  return _eventStoreConnection;
}

export async function closeEventStore(): Promise<void> {
  if (_eventStore) {
    _eventStore.close();
  }
  _eventStoreConnection = null;
  _eventStore = null;
}
