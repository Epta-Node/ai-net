-- Migration 003: create schema_migrations table
CREATE TABLE IF NOT EXISTS schema_migrations (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  version     TEXT NOT NULL UNIQUE,
  name        TEXT NOT NULL,
  applied_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- DOWN
DROP TABLE IF EXISTS schema_migrations;
