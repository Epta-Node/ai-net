/**
 * Retention archive for the append-only event store (issue #383).
 *
 * Purpose
 * ───────
 * `task_events` is the hot, query-facing table behind WebSocket replay and
 * per-task timeline reads.  It grows without bound, which bloats the database
 * file and widens the index scans every read pays for.  This module holds the
 * two tables that make bounded growth possible:
 *
 * • `task_event_archive` — a full-fidelity copy of every purged event row, so a
 *   finished task's complete timeline stays queryable after the live rows are
 *   removed.  Purged data is *moved*, not destroyed.
 * • `task_event_summary` — the materialized/compacted projection: one row per
 *   (task, DAG node) with per-type counters and timing, which is what makes
 *   the live table able to plateau.
 *
 * Why these tables live in the *same* SQLite file as `task_events`
 * ───────────────────────────────────────────────────────────────────
 * better-sqlite3 gives real ACID transactions within one database file and no
 * cross-file atomicity at all.  Because archive and purge must be a single
 * all-or-nothing fact — never "archived but not purged" and never "purged but
 * not archived" — both tables deliberately share the event store's file so
 * that {@link EventArchive.compactTask} can wrap archive + purge in one
 * transaction.  Splitting the archive into a separate `*.db` file would force a
 * two-phase scheme and reintroduce a genuine data-loss window on any crash
 * between the two writes.
 *
 * Data-loss safety
 * ────────────────
 * {@link EventArchive.compactTask} deletes a row only after an independent
 * read-back confirms the archive holds at least as many rows for that task as
 * the live table did immediately before the delete.  A short or failing archive
 * write throws, which rolls the whole transaction back, so a purge can never
 * outrun its archive.  See `compactTask` for the exact sequence.
 */

import type { Database } from "better-sqlite3";
import type { StoredEvent } from "./eventStore";
import { SYSTEM_TASK_ID, TERMINAL_EVENT_TYPES } from "./retentionConstants";

/** Terminal task statuses — the only tasks eligible for compaction. */
export type TerminalTaskStatus = "completed" | "failed" | "cancelled";

/**
 * Sentinel used in place of SQL NULL for the `node_id` dimension of
 * `task_event_summary`.
 *
 * SQLite treats NULLs as distinct in a `PRIMARY KEY` on a rowid table, so a
 * `(task_id, node_id)` primary key would fail to deduplicate task-level rows
 * (which have no node) and `ON CONFLICT DO UPDATE` would never fire for them.
 * Storing the empty string makes task-level and node-level rows collide
 * correctly.  An empty `node_id` in either table therefore means "task-level".
 */
export const TASK_LEVEL_NODE_ID = "";

/** A candidate task whose events may be eligible for compaction. */
export interface CompactionCandidate {
  taskId: string;
  /** ISO-8601 timestamp of the task's most recent event. */
  lastOccurredAt: string;
  /** `type` of the task's highest-`task_seq` event. */
  lastEventType: string;
  /** Number of live events currently stored for the task. */
  eventCount: number;
}

/** The materialized projection of one (task, node) pair. */
export interface TaskEventSummary {
  taskId: string;
  /** Empty string for task-level events; see {@link TASK_LEVEL_NODE_ID}. */
  nodeId: string;
  eventCount: number;
  counts: Record<string, number>;
  firstOccurredAt: string;
  lastOccurredAt: string;
  durationMs: number;
  finalTaskSeq: number;
  terminalStatus: TerminalTaskStatus | null;
  compactedAt: string;
}

/** Outcome of a single {@link EventArchive.compactTask} call. */
export interface CompactionOutcome {
  /**
   * True when events were archived, summarized and purged.  False when the
   * task had no live events to begin with — a no-op, not an error.
   */
  compacted: boolean;
  /** Why the task was skipped, when `compacted` is false. */
  reason?: string;
  /** Rows copied into `task_event_archive`. */
  eventsArchived: number;
  /** Rows written to `task_event_summary`. */
  summariesWritten: number;
  /** Rows deleted from `task_events`. */
  eventsPurged: number;
}

// ---------------------------------------------------------------------------
// DDL — mirrors the archive/summary section of backend/src/db/events.sql
// ---------------------------------------------------------------------------

export const ARCHIVE_DDL = `
  CREATE TABLE IF NOT EXISTS task_event_archive (
    global_seq  INTEGER NOT NULL,
    task_seq    INTEGER NOT NULL,
    version     INTEGER NOT NULL DEFAULT 1,
    type        TEXT    NOT NULL,
    task_id     TEXT    NOT NULL,
    node_id     TEXT    NOT NULL DEFAULT '',
    occurred_at TEXT    NOT NULL,
    payload     TEXT,
    archived_at TEXT    NOT NULL,
    -- Makes re-archiving the same events a no-op rather than a constraint
    -- violation, which is what makes a repeated compaction pass safe.
    UNIQUE (task_id, task_seq)
  );

  CREATE INDEX IF NOT EXISTS idx_archive_task
    ON task_event_archive (task_id, task_seq ASC);

  CREATE INDEX IF NOT EXISTS idx_archive_occurred_at
    ON task_event_archive (occurred_at ASC);

  CREATE TABLE IF NOT EXISTS task_event_summary (
    task_id            TEXT    NOT NULL,
    node_id            TEXT    NOT NULL DEFAULT '',
    event_count        INTEGER NOT NULL,
    cnt_task_created   INTEGER NOT NULL DEFAULT 0,
    cnt_node_started   INTEGER NOT NULL DEFAULT 0,
    cnt_node_completed INTEGER NOT NULL DEFAULT 0,
    cnt_node_failed    INTEGER NOT NULL DEFAULT 0,
    cnt_payment_locked   INTEGER NOT NULL DEFAULT 0,
    cnt_payment_released INTEGER NOT NULL DEFAULT 0,
    cnt_task_completed INTEGER NOT NULL DEFAULT 0,
    cnt_task_failed    INTEGER NOT NULL DEFAULT 0,
    first_occurred_at  TEXT    NOT NULL,
    last_occurred_at   TEXT    NOT NULL,
    duration_ms        INTEGER NOT NULL DEFAULT 0,
    final_task_seq     INTEGER NOT NULL,
    terminal_status    TEXT,
    compacted_at       TEXT    NOT NULL,
    PRIMARY KEY (task_id, node_id)
  );

  CREATE INDEX IF NOT EXISTS idx_summary_compacted_at
    ON task_event_summary (compacted_at ASC);
`;

/**
 * Index on the hot table that lets the candidate scan stream a per-task
 * aggregate instead of building a temp b-tree.  Without it the
 * `GROUP BY task_id` in {@link EventArchive.findCompactionCandidates} degrades
 * as the table grows — which is precisely the cost this feature exists to bound.
 */
export const CANDIDATE_SCAN_INDEX_DDL = `
  CREATE INDEX IF NOT EXISTS idx_events_task_occurred
    ON task_events (task_id, occurred_at ASC);
`;

/** Public contract for the retention archive. */
export interface EventArchive {
  /**
   * Archive, summarize and purge every live event for one finished task.
   *
   * @param taskId       Task whose events should be compacted.
   * @param terminalStatus Terminal status recorded on the summary rows.  Supplied
   *                      by the caller because it is authoritative in the tasks
   *                      database, not the event store.
   * @param assertStillCompacting Invoked *inside* the transaction immediately
   *                      before the archive write.  It should re-verify that the
   *                      task is still finished and throw otherwise; the throw
   *                      rolls back and nothing is purged.  This narrows the
   *                      cross-database time-of-check/time-of-use window between
   *                      selecting a candidate and purging it.
   */
  compactTask(
    taskId: string,
    terminalStatus: TerminalTaskStatus,
    assertStillCompacting: () => void,
  ): CompactionOutcome;

  /**
   * Tasks whose most recent event is strictly older than `cutoffIso`, oldest
   * first, capped at `limit`.  Excludes the `system` pseudo-task used by the
   * agent monitor, whose events are not task events.
   */
  findCompactionCandidates(cutoffIso: string, limit: number): CompactionCandidate[];

  /** Full-fidelity archived events for a task, in `task_seq` order. */
  listArchivedByTask(taskId: string): StoredEvent[];

  /** Materialized summaries for a task, ordered by `node_id`. */
  listSummaryByTask(taskId: string): TaskEventSummary[];

  /** Live row count in `task_events`. */
  countLiveEvents(): number;

  /** Row count in `task_event_archive`. */
  countArchivedEvents(): number;
}

// ---------------------------------------------------------------------------
// Row shapes
// ---------------------------------------------------------------------------

interface ArchivedRow {
  global_seq: number;
  task_seq: number;
  version: number;
  type: string;
  task_id: string;
  node_id: string;
  occurred_at: string;
  payload: string | null;
}

interface SummaryAggregateRow {
  node_id: string;
  event_count: number;
  cnt_task_created: number;
  cnt_node_started: number;
  cnt_node_completed: number;
  cnt_node_failed: number;
  cnt_payment_locked: number;
  cnt_payment_released: number;
  cnt_task_completed: number;
  cnt_task_failed: number;
  first_occurred_at: string;
  last_occurred_at: string;
  final_task_seq: number;
}

interface SummaryRow {
  task_id: string;
  node_id: string;
  event_count: number;
  cnt_task_created: number;
  cnt_node_started: number;
  cnt_node_completed: number;
  cnt_node_failed: number;
  cnt_payment_locked: number;
  cnt_payment_released: number;
  cnt_task_completed: number;
  cnt_task_failed: number;
  first_occurred_at: string;
  last_occurred_at: string;
  duration_ms: number;
  final_task_seq: number;
  terminal_status: string | null;
  compacted_at: string;
}

interface CountRow {
  n: number;
}

function rowToArchivedEvent(row: ArchivedRow): StoredEvent {
  const base = {
    globalSeq: row.global_seq,
    taskSeq: row.task_seq,
    version: row.version,
    type: row.type as StoredEvent['type'],
    taskId: row.task_id,
    occurredAt: row.occurred_at,
  };
  const payload = row.payload != null ? JSON.parse(row.payload) : undefined;
  if (row.node_id !== TASK_LEVEL_NODE_ID) {
    return { ...base, nodeId: row.node_id, payload } as StoredEvent;
  }
  return { ...base, payload } as StoredEvent;
}

function rowToSummary(row: SummaryRow): TaskEventSummary {
  return {
    taskId: row.task_id,
    nodeId: row.node_id,
    eventCount: row.event_count,
    counts: {
      TaskCreated: row.cnt_task_created,
      NodeStarted: row.cnt_node_started,
      NodeCompleted: row.cnt_node_completed,
      NodeFailed: row.cnt_node_failed,
      PaymentLocked: row.cnt_payment_locked,
      PaymentReleased: row.cnt_payment_released,
      TaskCompleted: row.cnt_task_completed,
      TaskFailed: row.cnt_task_failed,
    },
    firstOccurredAt: row.first_occurred_at,
    lastOccurredAt: row.last_occurred_at,
    durationMs: row.duration_ms,
    finalTaskSeq: row.final_task_seq,
    terminalStatus: row.terminal_status as TerminalTaskStatus | null,
    compactedAt: row.compacted_at,
  };
}

/** Parse an ISO timestamp to epoch ms, returning 0 for unparseable input. */
function toEpochMs(iso: string): number {
  const parsed = Date.parse(iso);
  return Number.isFinite(parsed) ? parsed : 0;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create the retention archive bound to an event-store connection.
 *
 * @param db The same `better-sqlite3` handle that owns `task_events`.  Sharing
 *           the connection is what makes archive + purge atomic.
 */
export function createEventArchive(db: Database): EventArchive {
  db.exec(ARCHIVE_DDL);
  db.exec(CANDIDATE_SCAN_INDEX_DDL);

  const countLiveStmt = db.prepare("SELECT COUNT(*) AS n FROM task_events");
  const countArchivedStmt = db.prepare(
    "SELECT COUNT(*) AS n FROM task_event_archive WHERE task_id = ?",
  );
  const countTaskStmt = db.prepare(
    "SELECT COUNT(*) AS n FROM task_events WHERE task_id = ?",
  );
  const countAllArchivedStmt = db.prepare(
    "SELECT COUNT(*) AS n FROM task_event_archive",
  );

  const insertArchiveStmt = db.prepare(`
    INSERT OR IGNORE INTO task_event_archive
      (global_seq, task_seq, version, type, task_id, node_id, occurred_at, payload, archived_at)
    SELECT
      global_seq, task_seq, version, type, task_id,
      COALESCE(node_id, ''), occurred_at, payload, @archived_at
    FROM task_events
    WHERE task_id = @task_id
  `);

  const deleteLiveStmt = db.prepare("DELETE FROM task_events WHERE task_id = ?");

  const aggregateStmt = db.prepare(`
    SELECT
      COALESCE(node_id, '') AS node_id,
      COUNT(*) AS event_count,
      SUM(CASE WHEN type = 'TaskCreated'    THEN 1 ELSE 0 END) AS cnt_task_created,
      SUM(CASE WHEN type = 'NodeStarted'    THEN 1 ELSE 0 END) AS cnt_node_started,
      SUM(CASE WHEN type = 'NodeCompleted'  THEN 1 ELSE 0 END) AS cnt_node_completed,
      SUM(CASE WHEN type = 'NodeFailed'     THEN 1 ELSE 0 END) AS cnt_node_failed,
      SUM(CASE WHEN type = 'PaymentLocked'  THEN 1 ELSE 0 END) AS cnt_payment_locked,
      SUM(CASE WHEN type = 'PaymentReleased'THEN 1 ELSE 0 END) AS cnt_payment_released,
      SUM(CASE WHEN type = 'TaskCompleted'  THEN 1 ELSE 0 END) AS cnt_task_completed,
      SUM(CASE WHEN type = 'TaskFailed'     THEN 1 ELSE 0 END) AS cnt_task_failed,
      MIN(occurred_at) AS first_occurred_at,
      MAX(occurred_at) AS last_occurred_at,
      MAX(task_seq) AS final_task_seq
    FROM task_events
    WHERE task_id = ?
    GROUP BY node_id
  `);

  const upsertSummaryStmt = db.prepare(`
    INSERT INTO task_event_summary
      (task_id, node_id, event_count,
       cnt_task_created, cnt_node_started, cnt_node_completed, cnt_node_failed,
       cnt_payment_locked, cnt_payment_released, cnt_task_completed, cnt_task_failed,
       first_occurred_at, last_occurred_at, duration_ms, final_task_seq,
       terminal_status, compacted_at)
    VALUES
      (@task_id, @node_id, @event_count,
       @cnt_task_created, @cnt_node_started, @cnt_node_completed, @cnt_node_failed,
       @cnt_payment_locked, @cnt_payment_released, @cnt_task_completed, @cnt_task_failed,
       @first_occurred_at, @last_occurred_at, @duration_ms, @final_task_seq,
       @terminal_status, @compacted_at)
    ON CONFLICT (task_id, node_id) DO UPDATE SET
      event_count        = excluded.event_count,
      cnt_task_created   = excluded.cnt_task_created,
      cnt_node_started   = excluded.cnt_node_started,
      cnt_node_completed = excluded.cnt_node_completed,
      cnt_node_failed    = excluded.cnt_node_failed,
      cnt_payment_locked = excluded.cnt_payment_locked,
      cnt_payment_released = excluded.cnt_payment_released,
      cnt_task_completed = excluded.cnt_task_completed,
      cnt_task_failed    = excluded.cnt_task_failed,
      first_occurred_at  = excluded.first_occurred_at,
      last_occurred_at   = excluded.last_occurred_at,
      duration_ms        = excluded.duration_ms,
      final_task_seq     = excluded.final_task_seq,
      terminal_status    = excluded.terminal_status,
      compacted_at       = excluded.compacted_at
  `);

  const candidatesStmt = db.prepare(`
    SELECT
      e.task_id AS task_id,
      MAX(e.occurred_at) AS last_occurred_at,
      (
        SELECT t.type FROM task_events t
        WHERE t.task_id = e.task_id
        ORDER BY t.task_seq DESC
        LIMIT 1
      ) AS last_event_type,
      COUNT(*) AS event_count
    FROM task_events e
    WHERE e.occurred_at < @cutoff
      AND e.task_id <> @excluded_task_id
    GROUP BY e.task_id
    ORDER BY last_occurred_at ASC
    LIMIT @limit
  `);

  const listArchivedStmt = db.prepare(`
    SELECT global_seq, task_seq, version, type, task_id, node_id, occurred_at, payload
    FROM task_event_archive
    WHERE task_id = ?
    ORDER BY task_seq ASC
  `);

  const listSummaryStmt = db.prepare(`
    SELECT * FROM task_event_summary
    WHERE task_id = ?
    ORDER BY node_id ASC
  `);

  return {
    compactTask(
      taskId: string,
      terminalStatus: TerminalTaskStatus,
      assertStillCompacting: () => void,
    ): CompactionOutcome {
      const archivedAt = new Date().toISOString();

      // better-sqlite3 transactions are synchronous and cannot span an await,
      // which is exactly what we want here: the whole archive-verify-purge
      // sequence is one uninterruptible unit.
      const run = db.transaction((): CompactionOutcome => {
        // 1. Re-assert eligibility inside the transaction. A throw here rolls
        //    back before anything has been written.
        assertStillCompacting();

        // 2. Record exactly how many live rows we are about to move.
        const preCount = (countTaskStmt.get(taskId) as CountRow).n;
        if (preCount === 0) {
          return {
            compacted: false,
            reason: "no-live-events",
            eventsArchived: 0,
            summariesWritten: 0,
            eventsPurged: 0,
          };
        }

        // 3. Archive first. INSERT OR IGNORE keeps a repeated pass a no-op.
        insertArchiveStmt.run({ task_id: taskId, archived_at: archivedAt });

        // 4. VERIFY the archive before permitting any delete. This is the
        //    guarantee that a purge can never outrun its archive: the count
        //    read-back is independent of the write above, and a shortfall
        //    throws, which rolls the transaction back with the live rows intact.
        const archivedCount = (countArchivedStmt.get(taskId) as CountRow).n;
        if (archivedCount < preCount) {
          throw new Error(
            `[event-archive] refusing to purge task ${taskId}: archive holds ` +
              `${archivedCount} row(s) but ${preCount} were selected for compaction`,
          );
        }

        // 5. Materialize the summary while the rows are still available.
        const aggregates = aggregateStmt.all(taskId) as SummaryAggregateRow[];
        for (const agg of aggregates) {
          const durationMs = Math.max(
            0,
            toEpochMs(agg.last_occurred_at) - toEpochMs(agg.first_occurred_at),
          );
          upsertSummaryStmt.run({
            task_id: taskId,
            node_id: agg.node_id,
            event_count: agg.event_count,
            cnt_task_created: agg.cnt_task_created,
            cnt_node_started: agg.cnt_node_started,
            cnt_node_completed: agg.cnt_node_completed,
            cnt_node_failed: agg.cnt_node_failed,
            cnt_payment_locked: agg.cnt_payment_locked,
            cnt_payment_released: agg.cnt_payment_released,
            cnt_task_completed: agg.cnt_task_completed,
            cnt_task_failed: agg.cnt_task_failed,
            first_occurred_at: agg.first_occurred_at,
            last_occurred_at: agg.last_occurred_at,
            duration_ms: durationMs,
            final_task_seq: agg.final_task_seq,
            terminal_status: terminalStatus,
            compacted_at: archivedAt,
          });
        }

        // 6. Only now is a delete permitted.
        const deleted = deleteLiveStmt.run(taskId).changes;
        if (deleted !== preCount) {
          throw new Error(
            `[event-archive] purge of task ${taskId} removed ${deleted} row(s) ` +
              `but ${preCount} were archived — rolling back`,
          );
        }

        return {
          compacted: true,
          eventsArchived: preCount,
          summariesWritten: aggregates.length,
          eventsPurged: deleted,
        };
      });

      return run();
    },

    findCompactionCandidates(cutoffIso: string, limit: number): CompactionCandidate[] {
      const rows = candidatesStmt.all({
        cutoff: cutoffIso,
        excluded_task_id: SYSTEM_TASK_ID,
        limit,
      }) as Array<{
        task_id: string;
        last_occurred_at: string;
        last_event_type: string | null;
        event_count: number;
      }>;
      return rows.map((row) => ({
        taskId: row.task_id,
        lastOccurredAt: row.last_occurred_at,
        lastEventType: row.last_event_type ?? "",
        eventCount: row.event_count,
      }));
    },

    listArchivedByTask(taskId: string): StoredEvent[] {
      return (listArchivedStmt.all(taskId) as ArchivedRow[]).map(rowToArchivedEvent);
    },

    listSummaryByTask(taskId: string): TaskEventSummary[] {
      return (listSummaryStmt.all(taskId) as SummaryRow[]).map(rowToSummary);
    },

    countLiveEvents(): number {
      return (countLiveStmt.get() as CountRow).n;
    },

    countArchivedEvents(): number {
      return (countAllArchivedStmt.get() as CountRow).n;
    },
  };
}

/**
 * Whether a candidate's last event marks the task as finished.
 *
 * A task is only compacted when its highest-`task_seq` event is a terminal
 * event type.  This is required because `task_id` and the task row live in
 * different databases, so the event stream is the only local witness that the
 * task actually ran to completion rather than merely having a terminal status
 * set by some other code path.
 */
export function hasTerminalLastEvent(lastEventType: string): boolean {
  return (TERMINAL_EVENT_TYPES as readonly string[]).includes(lastEventType);
}
