-- Drops the alert table and its indexes.
--
-- The `staleSince` column on `agents` is intentionally left in place: SQLite
-- only gained `ALTER TABLE ... DROP COLUMN` in 3.35, and dropping it would
-- rewrite the agents table on older runtimes. Leaving one nullable column is
-- harmless; dropping the table would lose the alert history, which is the part
-- that matters.
DROP INDEX IF EXISTS idx_agents_staleSince;
DROP INDEX IF EXISTS idx_agent_alerts_agentId;
DROP INDEX IF EXISTS idx_agent_alerts_detectedAt;
DROP TABLE IF EXISTS agent_alerts;
