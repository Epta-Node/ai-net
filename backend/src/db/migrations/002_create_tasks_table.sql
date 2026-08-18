-- Migration 002: create tasks and task_events tables
CREATE TABLE IF NOT EXISTS tasks (
  id              TEXT PRIMARY KEY,
  prompt          TEXT NOT NULL,
  walletPublicKey TEXT NOT NULL DEFAULT '',
  status          TEXT NOT NULL DEFAULT 'queued',
  dagJson         TEXT NOT NULL DEFAULT '[]',
  createdAt       TEXT NOT NULL,
  updatedAt       TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS task_events (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  taskId    TEXT    NOT NULL,
  type      TEXT    NOT NULL,
  nodeId    TEXT,
  payload   TEXT,
  timestamp TEXT    NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_task_events_taskId ON task_events (taskId);
