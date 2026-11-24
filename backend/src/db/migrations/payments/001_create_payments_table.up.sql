CREATE TABLE IF NOT EXISTS payments (
  taskId        TEXT NOT NULL,
  nodeId        TEXT NOT NULL,
  balanceId     TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'locked',
  amountStroops TEXT NOT NULL,
  txHash        TEXT,
  PRIMARY KEY (taskId, nodeId)
);
