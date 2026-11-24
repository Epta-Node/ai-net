-- 0001_init: base schema for the consolidated ai-net SQLite database.
--
-- This is the authoritative schema for the database resolved by
-- `resolveDatabasePath()` (DATABASE_URL, default ./data/ai-net.db).  Every
-- statement is written with IF NOT EXISTS so the file is safe to replay
-- against a database that was created by the legacy per-module DDL in
-- db/index.ts, db/tasks.ts and db/agents.ts — that is what makes re-running
-- the migration tool a no-op instead of a data-loss event.
--
-- `schema_migrations` is NOT created here: the runner bootstraps that
-- bookkeeping table itself.
--
-- Note on task_events: the append-only event-store shape below (global_seq /
-- task_seq / task_id / occurred_at) is the one defined in events.sql and used
-- by src/events/eventStore.ts, and it supersedes the older
-- `id / taskId / timestamp` shape that db/tasks.ts still declares inside its
-- own tasks.db.

-- ---------------------------------------------------------------------------
-- tasks — task registry, one row per submitted task
-- Source of truth: backend/src/db/tasks.ts
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS tasks (
  id              TEXT PRIMARY KEY,
  prompt          TEXT NOT NULL,
  walletPublicKey TEXT NOT NULL DEFAULT '',
  status          TEXT NOT NULL DEFAULT 'queued',
  dagJson         TEXT NOT NULL DEFAULT '[]',
  createdAt       TEXT NOT NULL,
  updatedAt       TEXT NOT NULL
);

-- ---------------------------------------------------------------------------
-- task_events — append-only lifecycle log
-- Source of truth: backend/src/db/events.sql, src/events/eventStore.ts
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS task_events (
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

-- ---------------------------------------------------------------------------
-- quality_scores — per-node quality output from the scorer
-- Source of truth: backend/src/db/tasks.ts (createTaskDb.insertQualityScore)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS quality_scores (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  taskId       TEXT    NOT NULL,
  nodeId       TEXT    NOT NULL,
  agentId      TEXT,
  agentType    TEXT    NOT NULL,
  score        REAL    NOT NULL,
  completeness REAL    NOT NULL,
  relevance    REAL    NOT NULL,
  format       REAL    NOT NULL,
  needsReview  INTEGER NOT NULL DEFAULT 0,
  timestamp    TEXT    NOT NULL
);

-- ---------------------------------------------------------------------------
-- agents — agent registry
-- Source of truth: backend/src/db/agents.ts
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS agents (
  id               TEXT PRIMARY KEY,
  capabilities     TEXT NOT NULL,
  pricingXLM       REAL NOT NULL,
  endpoint         TEXT NOT NULL,
  stellarPublicKey TEXT NOT NULL,
  reputationScore  REAL NOT NULL DEFAULT 0,
  lastSeenAt       TEXT NOT NULL,
  status           TEXT NOT NULL DEFAULT 'online'
);

-- ---------------------------------------------------------------------------
-- payments — escrowed payment state, one row per (task, node) pair
-- Source of truth: backend/src/db/index.ts
--
-- `createdAt` is stored as an ISO-8601 UTC string (the format the rest of the
-- schema uses) and defaults to "now" so the existing insert path — which names
-- only the seven original columns — keeps working unchanged.
--
-- `amount` is a generated mirror of `amountStroops`, kept because the
-- dashboard queries in db/stats.ts aggregate on `amount` and then divide by
-- 1e7 to render XLM.  Deriving it keeps the two columns from drifting apart
-- and makes the aggregate query indexable-free but correct.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS payments (
  taskId        TEXT NOT NULL,
  nodeId        TEXT NOT NULL,
  balanceId     TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'locked',
  amountStroops TEXT NOT NULL,
  txHash        TEXT,
  createdAt     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  amount        REAL GENERATED ALWAYS AS (CAST(amountStroops AS REAL)) VIRTUAL,
  PRIMARY KEY (taskId, nodeId)
);

-- ---------------------------------------------------------------------------
-- jobs — durable job queue
-- Source of truth: backend/src/queue/jobStore.ts
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS jobs (
  id           TEXT PRIMARY KEY,
  taskId       TEXT NOT NULL,
  type         TEXT NOT NULL,
  payloadJson  TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'pending',
  priority     TEXT NOT NULL DEFAULT 'normal',
  priorityNum  INTEGER NOT NULL DEFAULT 2,
  progress     INTEGER NOT NULL DEFAULT 0,
  attempts     INTEGER NOT NULL DEFAULT 0,
  maxAttempts  INTEGER NOT NULL DEFAULT 3,
  lastError    TEXT,
  nextRunAt    TEXT NOT NULL,
  createdAt    TEXT NOT NULL,
  updatedAt    TEXT NOT NULL,
  completedAt  TEXT,
  failedAt     TEXT
);

-- migrate:down
DROP TABLE IF EXISTS jobs;
DROP TABLE IF EXISTS payments;
DROP TABLE IF EXISTS agents;
DROP TABLE IF EXISTS quality_scores;
DROP TABLE IF EXISTS task_events;
DROP TABLE IF EXISTS tasks;
