/**
 * Migration 001 — create payments table.
 * Issue #1000
 */

import type Database from "better-sqlite3";
import type { Migration } from "../runner";

const migration: Migration = {
  up(db: Database.Database): void {
    db.exec(`
      CREATE TABLE IF NOT EXISTS payments (
        taskId        TEXT NOT NULL,
        nodeId        TEXT NOT NULL,
        balanceId     TEXT NOT NULL,
        status        TEXT NOT NULL DEFAULT 'locked',
        amountStroops TEXT NOT NULL,
        txHash        TEXT,
        PRIMARY KEY (taskId, nodeId)
      );
      CREATE INDEX IF NOT EXISTS idx_payments_status
        ON payments (status);
      CREATE INDEX IF NOT EXISTS idx_payments_task
        ON payments (taskId);
    `);
  },

  down(db: Database.Database): void {
    db.exec(`
      DROP INDEX IF EXISTS idx_payments_task;
      DROP INDEX IF EXISTS idx_payments_status;
      DROP TABLE IF EXISTS payments;
    `);
  },
};

module.exports = migration;
