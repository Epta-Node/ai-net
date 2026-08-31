/**
 * A minimal, dependency-free migration runner for better-sqlite3 databases.
 *
 * Each database (payments.db, agents.db, tasks.db) has its own migrations
 * directory containing numbered `NNN_name.up.sql` / `NNN_name.down.sql`
 * pairs. Applied migrations are recorded in a `schema_migrations` table
 * inside that same database, keyed by version, with a checksum of the up
 * migration's contents so drift between the ledger and the file on disk
 * (e.g. someone editing an already-applied migration) is caught instead of
 * silently ignored.
 */

import crypto from "crypto";
import fs from "fs";
import path from "path";
import Database from "better-sqlite3";

export interface Migration {
  version: number;
  name: string;
  upSql: string;
  downSql: string;
  checksum: string;
}

interface AppliedMigrationRow {
  version: number;
  name: string;
  checksum: string;
  applied_at: string;
}

const FILE_PATTERN = /^(\d+)_(.+)\.(up|down)\.sql$/;

function checksumOf(sql: string): string {
  return crypto.createHash("sha256").update(sql, "utf8").digest("hex");
}

/**
 * Load and pair up every `NNN_name.up.sql` / `NNN_name.down.sql` file in
 * `dir`, sorted by version ascending. Throws if a migration is missing its
 * counterpart, or if two files share a version number.
 */
export function loadMigrations(dir: string): Migration[] {
  if (!fs.existsSync(dir)) return [];

  const ups = new Map<number, { name: string; sql: string }>();
  const downs = new Map<number, string>();

  for (const filename of fs.readdirSync(dir)) {
    const match = FILE_PATTERN.exec(filename);
    if (!match) continue;
    const [, versionStr, name, direction] = match;
    const version = Number(versionStr);
    const sql = fs.readFileSync(path.join(dir, filename), "utf8");

    if (direction === "up") {
      if (ups.has(version)) {
        throw new Error(
          `Duplicate migration version ${version} in ${dir} (${filename} conflicts with an existing up migration)`,
        );
      }
      ups.set(version, { name, sql });
    } else {
      downs.set(version, sql);
    }
  }

  const migrations: Migration[] = [];
  for (const [version, { name, sql: upSql }] of ups) {
    const downSql = downs.get(version);
    if (downSql === undefined) {
      throw new Error(
        `Migration ${version}_${name} in ${dir} has no matching .down.sql file`,
      );
    }
    migrations.push({ version, name, upSql, downSql, checksum: checksumOf(upSql) });
  }

  return migrations.sort((a, b) => a.version - b.version);
}

function ensureLedger(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version    INTEGER PRIMARY KEY,
      name       TEXT NOT NULL,
      checksum   TEXT NOT NULL,
      applied_at TEXT NOT NULL
    )
  `);
}

export function getAppliedMigrations(db: Database.Database): AppliedMigrationRow[] {
  ensureLedger(db);
  return db
    .prepare("SELECT version, name, checksum, applied_at FROM schema_migrations ORDER BY version ASC")
    .all() as AppliedMigrationRow[];
}

/** Migrations present on disk that have not yet been recorded as applied. */
export function getPendingMigrations(db: Database.Database, dir: string): Migration[] {
  const applied = new Set(getAppliedMigrations(db).map((m) => m.version));
  return loadMigrations(dir).filter((m) => !applied.has(m.version));
}

/**
 * Verify every already-applied migration's on-disk checksum still matches
 * what was recorded when it ran. Guards against silently running with a
 * schema that no longer matches its own migration history.
 */
function assertNoChecksumDrift(db: Database.Database, migrations: Migration[]): void {
  const byVersion = new Map(migrations.map((m) => [m.version, m]));
  for (const applied of getAppliedMigrations(db)) {
    const onDisk = byVersion.get(applied.version);
    if (onDisk && onDisk.checksum !== applied.checksum) {
      throw new Error(
        `Checksum mismatch for migration ${applied.version}_${applied.name}: ` +
          `the applied migration's contents no longer match the file on disk. ` +
          `Never edit an already-applied migration — add a new one instead.`,
      );
    }
  }
}

/**
 * Apply every pending migration in `dir`, in version order, each inside its
 * own transaction. Returns the list of "NNN_name" identifiers that were
 * newly applied (empty if the database was already at the latest version).
 */
export function migrateToLatest(db: Database.Database, dir: string): { applied: string[] } {
  ensureLedger(db);
  const migrations = loadMigrations(dir);
  assertNoChecksumDrift(db, migrations);

  const pending = getPendingMigrations(db, dir);
  const applied: string[] = [];

  for (const migration of pending) {
    const run = db.transaction(() => {
      db.exec(migration.upSql);
      db.prepare(
        "INSERT INTO schema_migrations (version, name, checksum, applied_at) VALUES (?, ?, ?, ?)",
      ).run(migration.version, migration.name, migration.checksum, new Date().toISOString());
    });
    run();
    applied.push(`${migration.version}_${migration.name}`);
  }

  return { applied };
}

/**
 * Roll back the `steps` most-recently-applied migrations (default 1), in
 * reverse (newest-first) order, each inside its own transaction. Returns
 * the list of "NNN_name" identifiers that were rolled back.
 */
export function rollback(db: Database.Database, dir: string, steps = 1): { rolledBack: string[] } {
  ensureLedger(db);
  const migrationsByVersion = new Map(loadMigrations(dir).map((m) => [m.version, m]));
  const applied = getAppliedMigrations(db);
  const toRollBack = applied.slice(-steps).reverse();

  const rolledBack: string[] = [];
  for (const record of toRollBack) {
    const migration = migrationsByVersion.get(record.version);
    if (!migration) {
      throw new Error(
        `Cannot roll back migration ${record.version}_${record.name}: its files are no longer present in ${dir}`,
      );
    }
    const run = db.transaction(() => {
      db.exec(migration.downSql);
      db.prepare("DELETE FROM schema_migrations WHERE version = ?").run(record.version);
    });
    run();
    rolledBack.push(`${record.version}_${record.name}`);
  }

  return { rolledBack };
}
