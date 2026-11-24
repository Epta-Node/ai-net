/**
 * Migration status reporting.
 *
 * Joins the `schema_migrations` bookkeeping table against the migration files on
 * disk and returns the result for the `GET /migrations` endpoint.
 *
 * SQL bodies are deliberately left out of the report — only filenames, checksums
 * and timestamps are returned — so the endpoint cannot be used to read the schema
 * of an arbitrary database.
 */

import type Database from "better-sqlite3";
import { openDatabase, resolveDatabasePath } from "../index";
import { loadMigrations, resolveMigrationsDir } from "./loader";
import { MigrationTracker, describeMigrationStatus, type MigrationStatusReport } from "./tracker";

export interface MigrationStatusOptions {
  /** Override the consolidated database path (defaults to `DATABASE_URL`). */
  dbPath?: string;
  /** Override the migrations directory (defaults to `DB_MIGRATIONS_DIR`). */
  migrationsDir?: string;
}

export interface MigrationStatusResult extends MigrationStatusReport {
  /** Resolved path of the database that was inspected. */
  database: string;
  /** Directory the migration files were read from. */
  migrationsDir: string;
  /** Number of migration files found on disk. */
  migrationCount: number;
}

/**
 * Read the migration status of the consolidated database.
 *
 * The connection is scoped to the call, so the reporting path adds no long-lived
 * database handle for graceful shutdown to close. Never mutates the schema: the
 * only write it can issue is the idempotent `CREATE TABLE IF NOT EXISTS` that
 * backs the bookkeeping table.
 *
 * @throws {MigrationLoadError} when the migrations directory is missing or a
 *   filename is malformed.
 * @throws {Error} when the configured database path cannot be resolved or opened.
 */
export function readMigrationStatus(options: MigrationStatusOptions = {}): MigrationStatusResult {
  const dbPath = resolveDatabasePath(options.dbPath);
  const migrationsDir = resolveMigrationsDir(options.migrationsDir);
  const migrations = loadMigrations(migrationsDir);

  let db: Database.Database | null = null;
  try {
    db = openDatabase(dbPath);
    const report = describeMigrationStatus(new MigrationTracker(db), migrations);
    return {
      ...report,
      database: dbPath,
      migrationsDir,
      migrationCount: migrations.length,
    };
  } finally {
    db?.close();
  }
}