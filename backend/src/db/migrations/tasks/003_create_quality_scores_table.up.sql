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

CREATE INDEX IF NOT EXISTS idx_quality_scores_agentId ON quality_scores (agentId);
