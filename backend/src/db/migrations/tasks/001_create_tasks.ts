/**
 * Migration 001 — create tasks table.
 * Issue #1000
 */

import type Database from "better-sqlite3";
import type { Migration } from "../runner";

const migration: Migration = {
  up(db: Database.Database): void {
    db.exec(`
      CREATE TABLE IF NOT EXISTS tasks (
        id              TEXT    PRIMARY KEY,
        prompt          TEXT    NOT NULL,
        walletPublicKey TEXT    NOT NULL DEFAULT '',
        status          TEXT    NOT NULL DEFAULT 'queued',
        dagJson         TEXT,
        result          TEXT,
        createdAt       TEXT    NOT NULL DEFAULT (datetime('now')),
        updatedAt       TEXT    NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_tasks_wallet
        ON tasks (walletPublicKey);
      CREATE INDEX IF NOT EXISTS idx_tasks_status
        ON tasks (status);
      CREATE INDEX IF NOT EXISTS idx_tasks_created_at
        ON tasks (createdAt);
    `);
  },

  down(db: Database.Database): void {
    db.exec(`
      DROP INDEX IF EXISTS idx_tasks_created_at;
      DROP INDEX IF EXISTS idx_tasks_status;
      DROP INDEX IF EXISTS idx_tasks_wallet;
      DROP TABLE IF EXISTS tasks;
    `);
  },
};

module.exports = migration;
