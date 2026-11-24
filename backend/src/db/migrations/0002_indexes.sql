-- 0002_indexes: query-path indexes for the base schema.
--
-- Split out from 0001 so index tuning stays independent of the table
-- definitions, and so a large existing database can adopt the new indexes
-- without re-running table DDL.
--
-- Indexes that the legacy inline DDL already created use their original names
-- so that running this file against an existing database is a no-op. The rest
-- are new: they back the access patterns in db/tasks.ts (`list`), db/stats.ts
-- (dashboard time buckets) and db/agents.ts (heartbeat / cleanup sweeps).

-- ── tasks ────────────────────────────────────────────────────────────────────
-- Dashboard/analytics time scan (previously 001_add_stats_indexes.sql).
CREATE INDEX IF NOT EXISTS idx_tasks_created_at ON tasks ("createdAt");

-- Paginated task list: WHERE walletPublicKey = ? [AND status = ?]
--                      ORDER BY "createdAt" DESC LIMIT ? OFFSET ?
CREATE INDEX IF NOT EXISTS idx_tasks_wallet_created_at
  ON tasks (walletPublicKey, "createdAt" DESC);

-- Status filters used by failRunningTasks() and the status-filtered list view.
CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks (status);

-- ── task_events ──────────────────────────────────────────────────────────────
-- Full replay for a task, and ?lastEventId resume (events.sql).
CREATE INDEX IF NOT EXISTS idx_events_task_seq
  ON task_events (task_id, task_seq ASC);

-- Wall-clock window queries.
CREATE INDEX IF NOT EXISTS idx_events_occurred_at
  ON task_events (occurred_at ASC);

-- Cross-task projections, e.g. every PaymentLocked for reconciliation.
CREATE INDEX IF NOT EXISTS idx_events_type
  ON task_events (type, occurred_at ASC);

-- ── quality_scores ───────────────────────────────────────────────────────────
-- Reputation lookups by agent (previously created by db/tasks.ts inline DDL).
CREATE INDEX IF NOT EXISTS idx_quality_scores_agentId ON quality_scores (agentId);

-- ── payments ─────────────────────────────────────────────────────────────────
-- Reconciliation sweep over a single status (001_add_stats_indexes.sql).
CREATE INDEX IF NOT EXISTS idx_payments_status ON payments (status);

-- Point lookup for a task's payment rows.
CREATE INDEX IF NOT EXISTS idx_payments_taskId ON payments (taskId);

-- ── agents ───────────────────────────────────────────────────────────────────
-- Heartbeat staleness sweep and offline cleanup (db/agents.ts).
CREATE INDEX IF NOT EXISTS idx_agents_status ON agents (status);
CREATE INDEX IF NOT EXISTS idx_agents_lastSeenAt ON agents (lastSeenAt);

-- ── jobs ─────────────────────────────────────────────────────────────────────
-- Worker dequeue: WHERE status = ? ORDER BY nextRunAt (queue/jobStore.ts).
CREATE INDEX IF NOT EXISTS idx_jobs_status_nextRun ON jobs (status, nextRunAt);
CREATE INDEX IF NOT EXISTS idx_jobs_taskId ON jobs (taskId);
CREATE INDEX IF NOT EXISTS idx_jobs_priority ON jobs (priorityNum DESC, createdAt ASC);

-- migrate:down
DROP INDEX IF EXISTS idx_jobs_priority;
DROP INDEX IF EXISTS idx_jobs_taskId;
DROP INDEX IF EXISTS idx_jobs_status_nextRun;
DROP INDEX IF EXISTS idx_agents_lastSeenAt;
DROP INDEX IF EXISTS idx_agents_status;
DROP INDEX IF EXISTS idx_payments_taskId;
DROP INDEX IF EXISTS idx_payments_status;
DROP INDEX IF EXISTS idx_quality_scores_agentId;
DROP INDEX IF EXISTS idx_events_type;
DROP INDEX IF EXISTS idx_events_occurred_at;
DROP INDEX IF EXISTS idx_events_task_seq;
DROP INDEX IF EXISTS idx_tasks_status;
DROP INDEX IF EXISTS idx_tasks_wallet_created_at;
DROP INDEX IF EXISTS idx_tasks_created_at;
