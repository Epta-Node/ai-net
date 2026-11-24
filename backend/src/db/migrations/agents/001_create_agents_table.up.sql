CREATE TABLE IF NOT EXISTS agents (
  id               TEXT PRIMARY KEY,
  capabilities     TEXT NOT NULL,
  pricingXLM       REAL NOT NULL,
  endpoint         TEXT NOT NULL,
  stellarPublicKey TEXT NOT NULL,
  reputationScore  REAL NOT NULL DEFAULT 0,
  lastSeenAt       TEXT NOT NULL,
  status           TEXT NOT NULL DEFAULT 'offline'
);
