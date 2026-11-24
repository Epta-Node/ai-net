-- Rollback for 005_replace_task_events_schema
--
-- Restores the legacy schema B (id, taskId, type, nodeId, payload, timestamp)
-- that migration 002 originally created.  Rows stored in schema A are copied
-- back with a best-effort column mapping; task_seq is used as the surrogate
-- integer primary key.

-- Recreate the legacy table.
CREATE TABLE IF NOT EXISTS task_events_legacy (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  taskId    TEXT    NOT NULL,
  type      TEXT    NOT NULL,
  nodeId    TEXT,
  payload   TEXT,
  timestamp TEXT    NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_task_events_taskId_legacy
  ON task_events_legacy (taskId);

-- Copy what we can from the current (schema A) table.
INSERT INTO task_events_legacy (taskId, type, nodeId, payload, timestamp)
SELECT task_id, type, node_id, payload, occurred_at
FROM task_events;

-- Drop the schema A table and its indexes.
DROP INDEX IF EXISTS idx_events_task_seq;
DROP INDEX IF EXISTS idx_events_occurred_at;
DROP INDEX IF EXISTS idx_events_type;
DROP TABLE IF EXISTS task_events;

-- Rename the legacy table back to the canonical name.
ALTER TABLE task_events_legacy RENAME TO task_events;

-- Restore the original index name.
DROP INDEX IF EXISTS idx_task_events_taskId_legacy;
CREATE INDEX IF NOT EXISTS idx_task_events_taskId ON task_events (taskId);
