/**
 * Version tracking for the versioned SQLite migrations.
 *
 * Applied state lives in one `schema_migrations` row per migration.  That
 * bookkeeping table is bootstrapped by this module rather than by a migration
 * file on purpose: the runner has to be able to record a migration before any
 * migration has ever run, so the table cannot itself be the product of a
 * migration.  Its DDL is `IF NOT EXISTS`, so several entry points may call in
 * without coordinating.
 *
 * Keeping this separate from `runner.ts` keeps the two responsibilities apart —
 * the execution engine decides *what* to run, the tracker decides *how applied
 * state is written and read back*.
 */

import type Database from "better-sqlite3";
import type { Migration } from "./loader";

/** Row shape of the `schema_migrations` bookkeeping table. */
export interface AppliedMigration {
  id: string;
  filename: string;
  sql: string;
  appliedAt: string;
}

/** Full bookkeeping row, including the fields used for drift detection. */
export interface MigrationRecord extends AppliedMigration {
  name: string;
  checksum: string;
  downSql: string | null;
}

/** DDL for the bookkeeping table. Bootstrapped by the tracker, not by a migration. */
export const SCHEMA_MIGRATIONS_DDL = `
  CREATE TABLE IF NOT EXISTS schema_migrations (
    id         TEXT PRIMARY KEY,
    filename   TEXT NOT NULL UNIQUE,
    name       TEXT NOT NULL,
    checksum   TEXT NOT NULL,
    sql        TEXT NOT NULL,
    down_sql   TEXT,
    applied_at TEXT NOT NULL
  )
`;

interface MigrationRow {
  id: string;
  filename: string;
  name: string;
  checksum: string;
  sql: string;
  down_sql: string | null;
  applied_at: string;
}

const SELECT_COLUMNS = "id, filename, name, checksum, sql, down_sql, applied_at";

function toRecord(row: MigrationRow): MigrationRecord {
  return {
    id: row.id,
    filename: row.filename,
    name: row.name,
    checksum: row.checksum,
    sql: row.sql,
    downSql: row.down_sql,
    appliedAt: row.applied_at,
  };
}

/** Reads and writes applied-migration state in `schema_migrations`. */
export class MigrationTracker {
  private readonly db: Database.Database;

  constructor(db: Database.Database) {
    this.db = db;
  }

  /** Create `schema_migrations` if it does not exist. Safe to call repeatedly. */
  ensureTable(): void {
    this.db.exec(SCHEMA_MIGRATIONS_DDL);
  }

  /** Every applied migration, ordered by version. */
  list(): MigrationRecord[] {
    this.ensureTable();
    const rows = this.db
      .prepare(`SELECT ${SELECT_COLUMNS} FROM schema_migrations ORDER BY id ASC`)
      .all() as MigrationRow[];
    return rows.map(toRecord);
  }

  /** Applied rows keyed by migration id, for O(1) lookups. */
  map(): Map<string, MigrationRecord> {
    return new Map(this.list().map((record): [string, MigrationRecord] => [record.id, record]));
  }

  /** Whether a migration id has already been applied. */
  isApplied(id: string): boolean {
    this.ensureTable();
    const row = this.db
      .prepare("SELECT 1 AS present FROM schema_migrations WHERE id = ?")
      .get(id) as { present: number } | undefined;
    return row !== undefined;
  }

  /** Highest applied version, or `null` for a database that has never migrated. */
  latestVersion(): string | null {
    const records = this.list();
    return records.length === 0 ? null : records[records.length - 1].id;
  }

  /**
   * Record a migration as applied.
   *
   * Deliberately not transactional on its own: the runner wraps this in the
   * same transaction as the migration SQL so schema and bookkeeping row commit
   * or roll back together.
   */
  record(migration: Migration, appliedAt: string = new Date().toISOString()): void {
    this.ensureTable();
    this.db
      .prepare(
        `INSERT INTO schema_migrations (id, filename, name, checksum, sql, down_sql, applied_at)
         VALUES (@id, @filename, @name, @checksum, @sql, @downSql, @appliedAt)`,
      )
      .run({
        id: migration.id,
        filename: migration.filename,
        name: migration.name,
        checksum: migration.checksum,
        sql: migration.upSql,
        downSql: migration.downSql,
        appliedAt,
      });
  }

  /** Drop the bookkeeping row for a reverted migration. Runs in the caller's transaction. */
  forget(id: string): void {
    this.db.prepare("DELETE FROM schema_migrations WHERE id = ?").run(id);
  }
}

/** One migration as reported by the status endpoint. */
export interface MigrationStatusEntry {
  id: string;
  filename: string;
  name: string;
  /** Whether the migration is recorded in `schema_migrations`. */
  state: "applied" | "pending";
  /** SHA-256 of the migration file as it exists on disk. */
  checksum: string;
  /** ISO-8601 commit time, or `null` while the migration is pending. */
  appliedAt: string | null;
  /** `true` when the file defines a `-- migrate:down` section. */
  reversible: boolean;
  /** Recorded checksum differs from the file on disk — an applied file was edited. */
  drifted: boolean;
}

/** Applied state joined against the migration files on disk. */
export interface MigrationStatusReport {
  migrations: MigrationStatusEntry[];
  /** Highest applied version, or `null` when nothing has been applied. */
  currentVersion: string | null;
  /** Highest version present on disk, or `null` when there are no migration files. */
  latestVersion: string | null;
  appliedCount: number;
  pendingCount: number;
  /** `true` when nothing is pending and no applied migration has drifted. */
  upToDate: boolean;
  /** Applied migrations that were edited after being applied, or are missing from disk. */
  drift: string[];
}

/**
 * Join recorded applied state against the migration files on disk.
 *
 * Read-only apart from the idempotent `CREATE TABLE IF NOT EXISTS`, so it is
 * safe to call against a connection opened only for reporting.
 *
 * @param tracker Version tracker to read applied state from.
 * @param migrations Migration files discovered on disk, in version order.
 */
export function describeMigrationStatus(
  tracker: MigrationTracker,
  migrations: Migration[],
): MigrationStatusReport {
  const applied = tracker.map();
  const files = new Map(migrations.map((migration): [string, Migration] => [migration.id, migration]));

  const entries: MigrationStatusEntry[] = migrations.map((migration) => {
    const record = applied.get(migration.id);
    return {
      id: migration.id,
      filename: migration.filename,
      name: migration.name,
      state: record ? "applied" : "pending",
      checksum: migration.checksum,
      appliedAt: record?.appliedAt ?? null,
      reversible: migration.downSql !== null && migration.downSql.trim() !== "",
      drifted: record !== undefined && record.checksum !== migration.checksum,
    };
  });

  // A row recorded as applied whose file was edited or removed is drift: the
  // runner refuses to run in that state, so surface it rather than dropping it.
  const drift = [...applied.values()]
    .filter((record) => {
      const file = files.get(record.id);
      return file === undefined || file.checksum !== record.checksum;
    })
    .map((record) => record.id)
    .sort();

  const pendingCount = entries.filter((entry) => entry.state === "pending").length;

  return {
    migrations: entries,
    currentVersion: tracker.latestVersion(),
    latestVersion: migrations.length === 0 ? null : migrations[migrations.length - 1].id,
    appliedCount: applied.size,
    pendingCount,
    upToDate: pendingCount === 0 && drift.length === 0,
    drift,
  };
}