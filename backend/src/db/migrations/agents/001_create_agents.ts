/**
 * Migration 001 — create agents table.
 * Issue #1000
 */

import type Database from "better-sqlite3";
import type { Migration } from "../runner";

const migration: Migration = {
  up(db: Database.Database): void {
    db.exec(`
      CREATE TABLE IF NOT EXISTS agents (
        id              TEXT    PRIMARY KEY,
        capabilities    TEXT    NOT NULL DEFAULT '[]',
        pricingXLM      REAL    NOT NULL DEFAULT 0,
        endpoint        TEXT    NOT NULL DEFAULT '',
        stellarPublicKey TEXT   NOT NULL DEFAULT '',
        reputationScore REAL    NOT NULL DEFAULT 0,
        lastSeenAt      TEXT    NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_agents_stellar
        ON agents (stellarPublicKey);
    `);
  },

  down(db: Database.Database): void {
    db.exec(`
      DROP INDEX IF EXISTS idx_agents_stellar;
      DROP TABLE IF EXISTS agents;
    `);
  },
};

module.exports = migration;
