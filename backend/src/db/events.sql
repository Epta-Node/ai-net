-- Event store schema for append-only event sourcing log.
--
-- This table is the single source of truth for all task lifecycle events.
-- Rows are never updated or deleted — only appended. The `global_seq` column
-- (AUTOINCREMENT) provides a globally-ordered cursor across all tasks, while
-- `task_seq` provides a per-task cursor for stream resume (?lastEventId).
--
-- NOTE: This DDL uses SQLite syntax (AUTOINCREMENT, TEXT for ISO-8601 dates).
-- It is not compatible with PostgreSQL or other databases without adaptation.
--
-- Apply with:
--   better-sqlite3: db.exec(fs.readFileSync('backend/src/db/events.sql', 'utf8'))

CREATE TABLE IF NOT EXISTS task_events (
  -- Globally unique, monotonically-increasing row identifier.
  -- Used for cross-task ordering and change-data-capture.
  global_seq   INTEGER PRIMARY KEY AUTOINCREMENT,

  -- Per-task monotonic cursor starting at 0. Assigned by the EventBus before
  -- the event is stored so WebSocket clients can resume from ?lastEventId.
  task_seq     INTEGER NOT NULL,

  -- Schema version for this event record. Increment when the payload shape
  -- changes; readers can branch on version for backward compatibility.
  version      INTEGER NOT NULL DEFAULT 1,

  -- Discriminator — one of the EventType literals defined in eventTypes.ts.
  type         TEXT    NOT NULL,

  -- The task this event belongs to.
  task_id      TEXT    NOT NULL,

  -- The DAG node this event relates to (NULL for task-level events).
  node_id      TEXT,

  -- ISO-8601 wall-clock time when the event was created by the emitter.
  occurred_at  TEXT    NOT NULL,

  -- JSON-serialised event-specific payload (may be NULL for simple signals).
  payload      TEXT,

  -- Enforce uniqueness of (task_id, task_seq) so duplicate appends are
  -- detected immediately rather than silently creating duplicate rows.
  UNIQUE (task_id, task_seq)
);

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
