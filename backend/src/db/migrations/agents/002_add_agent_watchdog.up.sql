-- Agent heartbeat watchdog: stale tracking + alert history (Issue #379).
--
-- `staleSince` is the grace-period clock: it is stamped the first tick an
-- agent is seen missing and cleared when it heartbeats again, so eviction is
-- measured from the *first* miss rather than being re-armed every tick.
--
-- `agent_alerts` is the audit trail. Keeping it in the database (rather than
-- only in the log) is what lets the dashboard show why an agent vanished and
-- lets an operator confirm an on-chain reconciliation actually happened.

ALTER TABLE agents ADD COLUMN staleSince TEXT;

CREATE TABLE IF NOT EXISTS agent_alerts (
  id         TEXT PRIMARY KEY,
  agentId    TEXT NOT NULL,
  type       TEXT NOT NULL,
  severity   TEXT NOT NULL,
  message    TEXT NOT NULL,
  lastSeenAt TEXT,
  detectedAt TEXT NOT NULL,
  resolvedAt TEXT,
  metadata   TEXT NOT NULL DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS idx_agent_alerts_detectedAt
  ON agent_alerts (detectedAt DESC);

CREATE INDEX IF NOT EXISTS idx_agent_alerts_agentId
  ON agent_alerts (agentId, detectedAt DESC);

-- Drives the "quarantined right now" panel without scanning the whole fleet.
CREATE INDEX IF NOT EXISTS idx_agents_staleSince
  ON agents (staleSince);
