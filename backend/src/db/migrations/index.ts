import type Database from "better-sqlite3";
import {
  runUp,
  runDown,
  getStatus,
  loadMigrations,
  parseMigrationSql,
  type Migration,
  type MigrationStatus,
  type MigrationResult,
  type MigrationOptions,
  type RollbackOptions,
} from "./runner";
import {
  getAppliedMigrations,
  recordMigration,
  removeMigration,
  isApplied,
  ensureMigrationsTable,
  type AppliedMigration,
} from "./tracker";

/**
 * Runs all pending migrations (UP) on the database.
 */
export function runMigrations(
  db: Database.Database,
  options: MigrationOptions = {},
): MigrationResult {
  return runUp(db, options);
}

/**
 * Rolls back applied migrations (DOWN) on the database.
 */
export function rollbackMigrations(
  db: Database.Database,
  options: RollbackOptions = {},
): MigrationResult {
  return runDown(db, options);
}

/**
 * Gets the current status of all migrations on the database.
 */
export function getMigrationStatus(
  db: Database.Database,
  options: { migrationsDir?: string } = {},
): MigrationStatus[] {
  return getStatus(db, options.migrationsDir);
}

export {
  runUp,
  runDown,
  getStatus,
  loadMigrations,
  parseMigrationSql,
  getAppliedMigrations,
  recordMigration,
  removeMigration,
  isApplied,
  ensureMigrationsTable,
};

export type {
  Migration,
  MigrationStatus,
  MigrationResult,
  MigrationOptions,
  RollbackOptions,
  AppliedMigration,
};
