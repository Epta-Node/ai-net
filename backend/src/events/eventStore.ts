/**
 * Append-only SQLite-backed event store.
 *
 * Responsibilities
 * ────────────────
 * • Persist every {@link AppEvent} with a globally-unique `globalSeq` and a
 *   per-task `taskSeq` (the per-task cursor assigned upstream by the EventBus).
 * • Expose read queries needed by replay, projection, and WebSocket resume.
 * • Own the DDL — the schema in `../../db/events.sql` is the authoritative
 *   documentation; this module applies an equivalent DDL inline so the store
 *   can be instantiated without an external migration tool (e.g. in tests).
 *
 * Compatibility note
 * ──────────────────
 * The coordinator still imports the legacy {@link createEventStore} from
 * `../coordinator/eventStore`.  That module now re-exports from here so both
 * import paths resolve to the same implementation without breaking existing
 * callers or the tests in `tests/replay.test.ts`.
 */

import Database from 'better-sqlite3';
import { readFileSync } from 'fs';
import { join } from 'path';
import type { AppEvent } from './eventTypes';

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
   */
  listByTaskSince(taskId: string, afterSeq: number): StoredEvent[];

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

  // nodeId is only present on node-level events; omit the key when absent so
  // the type narrowing in eventTypes.ts stays clean.
  if (row.node_id != null) {
    return { ...base, nodeId: row.node_id, payload } as StoredEvent;
  }
  return { ...base, payload } as StoredEvent;
}

// ---------------------------------------------------------------------------
// DDL — mirrors backend/src/db/events.sql
// ---------------------------------------------------------------------------

const DDL = `
  CREATE TABLE IF NOT EXISTS task_events (
    global_seq  INTEGER PRIMARY KEY AUTOINCREMENT,
    task_seq    INTEGER NOT NULL,
    version     INTEGER NOT NULL DEFAULT 1,
    type        TEXT    NOT NULL,
    task_id     TEXT    NOT NULL,
    node_id     TEXT,
    occurred_at TEXT    NOT NULL,
    payload     TEXT,
    UNIQUE (task_id, task_seq)
  );

  CREATE INDEX IF NOT EXISTS idx_events_task_seq
    ON task_events (task_id, task_seq ASC);

  CREATE INDEX IF NOT EXISTS idx_events_occurred_at
    ON task_events (occurred_at ASC);

  CREATE INDEX IF NOT EXISTS idx_events_type
    ON task_events (type, occurred_at ASC);
`;

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a SQLite-backed {@link EventStore}.
 *
 * @param db  An existing better-sqlite3 `Database` instance, or a file path
 *            string.  Defaults to an in-memory database — suitable for a
 *            long-running server and for unit tests alike.
 */
export function createEventStore(db?: Database.Database | string): EventStore {
  const database =
    typeof db === 'string'
      ? new Database(db)
      : db ?? new Database(':memory:');

  database.pragma('journal_mode = WAL');
  database.pragma('busy_timeout = 5000');
  database.exec(DDL);

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

    listByTaskSince(taskId: string, afterSeq: number): StoredEvent[] {
      return (listByTaskSinceStmt.all(taskId, afterSeq) as EventRow[]).map(rowToStoredEvent);
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

    close(): void {
      database.close();
    },
  };
}
