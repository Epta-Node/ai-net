-- Migration 007: Persist runtime feature-flag overrides (issue #814).
--
-- Runtime overrides set through the admin API used to live only in memory and
-- were lost on restart. Each row here is one override; flags with no row fall
-- back to the environment variable and then to the compiled-in default.
--
-- rollout_percent (0-100) buckets wallets deterministically by hashing the
-- flag key with the wallet key, so a wallet keeps the same answer across
-- requests and restarts. enabled_wallets is a JSON array of Stellar public
-- keys that always see the flag as enabled, regardless of rollout_percent.

CREATE TABLE IF NOT EXISTS feature_flags (
  key              TEXT    PRIMARY KEY,
  enabled          INTEGER NOT NULL CHECK (enabled IN (0, 1)),
  rollout_percent  INTEGER NOT NULL DEFAULT 100 CHECK (rollout_percent BETWEEN 0 AND 100),
  enabled_wallets  TEXT    NOT NULL DEFAULT '[]',
  updated_at       TEXT    NOT NULL,
  updated_by       TEXT    NOT NULL
);
