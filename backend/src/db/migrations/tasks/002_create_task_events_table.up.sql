CREATE TABLE IF NOT EXISTS task_events (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  taskId    TEXT    NOT NULL,
  type      TEXT    NOT NULL,
  nodeId    TEXT,
  payload   TEXT,
  timestamp TEXT    NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_task_events_taskId ON task_events (taskId);
