-- Per-task / per-agent LLM token accounting and cost snapshots (Issue #390).
--
-- Two tables, because they answer different questions and have different
-- lifecycles:
--   * task_costs      — one row per task, the billing snapshot. Written once
--                       when the task settles (completed / failed / cancelled).
--   * task_token_usage— one row per node within a task, the breakdown an
--                       operator reads to find *which* step overran.
--
-- Token columns are stored alongside the USD cost on purpose: cost depends on
-- the pricing table at the time of the call, tokens do not. Keeping both lets
-- us reprice historical runs without re-deriving what was spent.

CREATE TABLE IF NOT EXISTS task_costs (
  taskId           TEXT    PRIMARY KEY,
  walletPublicKey  TEXT    NOT NULL DEFAULT '',
  budgetTokens     INTEGER NOT NULL,
  usedTokens       INTEGER NOT NULL DEFAULT 0,
  costUsd          REAL    NOT NULL DEFAULT 0,
  currency         TEXT    NOT NULL DEFAULT 'USD',
  exceeded         INTEGER NOT NULL DEFAULT 0,
  calls            INTEGER NOT NULL DEFAULT 0,
  createdAt        TEXT    NOT NULL,
  settledAt        TEXT    NOT NULL
);

CREATE TABLE IF NOT EXISTS task_token_usage (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  taskId            TEXT    NOT NULL,
  nodeId            TEXT    NOT NULL,
  agentId           TEXT    NOT NULL DEFAULT '',
  agentType         TEXT    NOT NULL DEFAULT '',
  model             TEXT    NOT NULL DEFAULT '',
  calls             INTEGER NOT NULL DEFAULT 0,
  promptTokens      INTEGER NOT NULL DEFAULT 0,
  completionTokens  INTEGER NOT NULL DEFAULT 0,
  totalTokens       INTEGER NOT NULL DEFAULT 0,
  costUsd           REAL    NOT NULL DEFAULT 0,
  trimmed           INTEGER NOT NULL DEFAULT 0,
  budgetExhausted   INTEGER NOT NULL DEFAULT 0,
  updatedAt         TEXT    NOT NULL
);

-- One row per (task, node): a node may be retried across attempts, and each
-- attempt must fold into the same row rather than append a duplicate.
CREATE UNIQUE INDEX IF NOT EXISTS idx_task_token_usage_task_node
  ON task_token_usage (taskId, nodeId);

-- Supports the per-agent cost rollup without scanning every task.
CREATE INDEX IF NOT EXISTS idx_task_token_usage_agentId
  ON task_token_usage (agentId);

CREATE INDEX IF NOT EXISTS idx_task_token_usage_taskId
  ON task_token_usage (taskId);

CREATE INDEX IF NOT EXISTS idx_task_costs_wallet
  ON task_costs (walletPublicKey);
