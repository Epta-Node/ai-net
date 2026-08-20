-- Add indexes to speed up dashboard and analytics queries
CREATE TABLE IF NOT EXISTS tasks (
  id              TEXT PRIMARY KEY,
  prompt          TEXT NOT NULL,
  walletPublicKey TEXT NOT NULL DEFAULT '',
  status          TEXT NOT NULL DEFAULT 'queued',
  dagJson         TEXT NOT NULL DEFAULT '[]',
  createdAt       TEXT NOT NULL,
  updatedAt       TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS payments (
  taskId        TEXT NOT NULL,
  nodeId        TEXT NOT NULL,
  balanceId     TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'locked',
  amountStroops TEXT NOT NULL,
  txHash        TEXT,
  PRIMARY KEY (taskId, nodeId)
);

CREATE INDEX IF NOT EXISTS idx_tasks_created_at ON tasks ("createdAt");
CREATE INDEX IF NOT EXISTS idx_payments_status ON payments (status);


-- DOWN
DROP INDEX IF EXISTS idx_tasks_created_at;
DROP INDEX IF EXISTS idx_payments_status;

