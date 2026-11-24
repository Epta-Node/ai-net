-- Migration 005: Replace legacy task_events schema (schema B) with the
-- canonical event-sourcing schema (schema A).
--
-- Context
-- ───────
-- This migration always runs after 002_create_task_events_table (which
-- creates task_events with schema B).  The migrator applies migrations in
-- version order, so task_events is guaranteed to exist when this runs.
--
-- What this does
-- ──────────────
-- 1. Create task_events_new with schema A (the event-sourcing shape).
-- 2. Copy any existing schema B rows into the new table with a best-effort
--    column mapping (taskId → task_id, timestamp → occurred_at, etc.).
--    The WHERE guard ensures the copy only runs when schema B columns are
--    present (detected via pragma_table_info), so re-running this migration
--    on a database that already has schema A is a safe no-op.
-- 3. Drop the old task_events table.
-- 4. Rename task_events_new → task_events.
-- 5. Create supporting indexes.

-- Step 1: New table with schema A.
CREATE TABLE IF NOT EXISTS task_events_new (
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

-- Step 2: Copy rows from schema B into schema A.
-- The WHERE clause makes the whole INSERT a no-op when task_events no longer
-- has a "taskId" column (i.e. after a previous run of this migration the
-- table was already replaced with schema A, so this INSERT selects 0 rows).
INSERT OR IGNORE INTO task_events_new
  (task_seq, version, type, task_id, node_id, occurred_at, payload)
SELECT
  rowid,
  1,
  type,
  taskId,
  nodeId,
  COALESCE(timestamp, datetime('now')),
  payload
FROM task_events
WHERE (SELECT COUNT(*) FROM pragma_table_info('task_events') WHERE name = 'taskId') > 0;

-- Step 3: Drop the old table.
DROP TABLE IF EXISTS task_events;

-- Step 4: Rename new table to canonical name.
ALTER TABLE task_events_new RENAME TO task_events;

-- Step 5: Create supporting indexes.
CREATE INDEX IF NOT EXISTS idx_events_task_seq
  ON task_events (task_id, task_seq ASC);

CREATE INDEX IF NOT EXISTS idx_events_occurred_at
  ON task_events (occurred_at ASC);

CREATE INDEX IF NOT EXISTS idx_events_type
  ON task_events (type, occurred_at ASC);
