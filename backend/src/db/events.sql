-- Event store schema for append-only event sourcing log.
--
-- DOCUMENTATION ONLY — this file is not executable and must never be applied.
-- The authoritative DDL lives in the migration pair, which is the single place
-- that creates the schema:
--   002_create_task_events_table.up.sql    → creates the table (schema B)
--   005_replace_task_events_schema.up.sql  → transforms it to schema A below
-- Keeping a second executable copy here is exactly the drift that #560 fixed:
-- the two shapes disagreed, and whichever ran last won.
--
-- The commented reference below records the intended shape (schema A) so the
-- event-store contract is readable next to the code that reads it.
--
-- NOTE: This DDL uses SQLite syntax (AUTOINCREMENT, TEXT for ISO-8601 dates).
-- It is not compatible with PostgreSQL or other databases without adaptation.

-- CREATE TABLE IF NOT EXISTS task_events (
--   -- Globally unique, monotonically-increasing row identifier.
--   -- Used for cross-task ordering and change-data-capture.
--   global_seq   INTEGER PRIMARY KEY AUTOINCREMENT,
-- 
--   -- Per-task monotonic cursor starting at 0. Assigned by the EventBus before
--   -- the event is stored so WebSocket clients can resume from ?lastEventId.
--   task_seq     INTEGER NOT NULL,
-- 
--   -- Schema version for this event record. Increment when the payload shape
--   -- changes; readers can branch on version for backward compatibility.
--   version      INTEGER NOT NULL DEFAULT 1,
-- 
--   -- Discriminator — one of the EventType literals defined in eventTypes.ts.
--   type         TEXT    NOT NULL,
-- 
--   -- The task this event belongs to.
--   task_id      TEXT    NOT NULL,
-- 
--   -- The DAG node this event relates to (NULL for task-level events).
--   node_id      TEXT,
-- 
--   -- ISO-8601 wall-clock time when the event was created by the emitter.
--   occurred_at  TEXT    NOT NULL,
-- 
--   -- JSON-serialised event-specific payload (may be NULL for simple signals).
--   payload      TEXT,
-- 
--   -- Enforce uniqueness of (task_id, task_seq) so duplicate appends are
--   -- detected immediately rather than silently creating duplicate rows.
--   UNIQUE (task_id, task_seq)
-- );

-- Primary query: fetch all events for a task in order (full replay).
CREATE INDEX IF NOT EXISTS idx_events_task_seq
  ON task_events (task_id, task_seq ASC);

-- Time-range queries: find events within a wall-clock window.
CREATE INDEX IF NOT EXISTS idx_events_occurred_at
  ON task_events (occurred_at ASC);

-- Type filter: project a specific event type across all tasks (e.g. all
-- PaymentLocked events for billing reconciliation).
CREATE INDEX IF NOT EXISTS idx_events_type
  ON task_events (type, occurred_at ASC);

-- Retention candidate scan: lets `GROUP BY task_id` with `MAX(occurred_at)`
-- stream instead of building a temp b-tree, so the compaction pass does not
-- degrade as the live table grows.
CREATE INDEX IF NOT EXISTS idx_events_task_occurred
  ON task_events (task_id, occurred_at ASC);


-- ═══════════════════════════════════════════════════════════════════════════
-- Retention archive (issue #383)
--
-- These two tables deliberately live in the SAME database file as
-- `task_events` above. better-sqlite3 provides real ACID transactions within
-- one file and none across files, so sharing the file is what lets the
-- retention job archive and purge in a single all-or-nothing transaction
-- rather than leaving a data-loss window between two writes.
-- ═══════════════════════════════════════════════════════════════════════════

-- Full-fidelity copies of purged events. UNIQUE (task_id, task_seq) makes a
-- repeated compaction pass a no-op instead of a constraint violation, and
-- means a finished task's complete timeline stays queryable after the live
-- rows are removed. node_id is '' for task-level events (COALESCE'd on
-- insert) rather than NULL.
-- CREATE TABLE IF NOT EXISTS task_event_archive (
--   global_seq  INTEGER NOT NULL,
--   task_seq    INTEGER NOT NULL,
--   version     INTEGER NOT NULL DEFAULT 1,
--   type        TEXT    NOT NULL,
--   task_id     TEXT    NOT NULL,
--   node_id     TEXT    NOT NULL DEFAULT '',
--   occurred_at TEXT    NOT NULL,
--   payload     TEXT,
--   archived_at TEXT    NOT NULL,
--   UNIQUE (task_id, task_seq)
-- );

CREATE INDEX IF NOT EXISTS idx_archive_task
  ON task_event_archive (task_id, task_seq ASC);

CREATE INDEX IF NOT EXISTS idx_archive_occurred_at
  ON task_event_archive (occurred_at ASC);

-- The materialized/compacted projection: one row per (task, DAG node) with
-- per-type counters and timing. This is the shape that keeps the live table
-- able to plateau.
--
-- node_id is '' rather than NULL for task-level rows because SQLite treats
-- NULLs as distinct in a rowid-table PRIMARY KEY, which would break
-- deduplication and ON CONFLICT DO UPDATE for those rows.
-- CREATE TABLE IF NOT EXISTS task_event_summary (
--   task_id              TEXT    NOT NULL,
--   node_id              TEXT    NOT NULL DEFAULT '',
--   event_count          INTEGER NOT NULL,
--   cnt_task_created     INTEGER NOT NULL DEFAULT 0,
--   cnt_node_started     INTEGER NOT NULL DEFAULT 0,
--   cnt_node_completed   INTEGER NOT NULL DEFAULT 0,
--   cnt_node_failed      INTEGER NOT NULL DEFAULT 0,
--   cnt_payment_locked   INTEGER NOT NULL DEFAULT 0,
--   cnt_payment_released INTEGER NOT NULL DEFAULT 0,
--   cnt_task_completed   INTEGER NOT NULL DEFAULT 0,
--   cnt_task_failed      INTEGER NOT NULL DEFAULT 0,
--   first_occurred_at    TEXT    NOT NULL,
--   last_occurred_at     TEXT    NOT NULL,
--   duration_ms          INTEGER NOT NULL DEFAULT 0,
--   final_task_seq       INTEGER NOT NULL,
--   terminal_status      TEXT,
--   compacted_at         TEXT    NOT NULL,
--   PRIMARY KEY (task_id, node_id)
-- );

CREATE INDEX IF NOT EXISTS idx_summary_compacted_at
  ON task_event_summary (compacted_at ASC);
