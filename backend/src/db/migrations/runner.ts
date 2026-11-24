/**
 * SQLite migration runner.
 *
 * Reads TypeScript migration files from
 *   backend/src/db/migrations/<dbname>/NNN_description.ts
 * Each file must export `{ up(db): void, down(db): void }`.
 *
 * Applied migrations are recorded in a `_migrations` meta-table inside each
 * database so the runner is fully idempotent.
 *
 * Issue #1000
 */

import Database from "better-sqlite3";
import fs from "fs";
import path from "path";
import { createLogger } from "../../utils/logger";

const logger = createLogger({ component: "migration-runner" });

export type DbName = "agents" | "tasks" | "payments";

export interface Migration {
  up(db: Database.Database): void;
  down(db: Database.Database): void;
}

const MIGRATIONS_BASE = path.join(__dirname, "migrations");

// ── Meta-table ───────────────────────────────────────────────────────────────

function ensureMetaTable(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS _migrations (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      name        TEXT    NOT NULL UNIQUE,
      applied_at  TEXT    NOT NULL DEFAULT (datetime('now'))
    )
  `);
}

function appliedMigrations(db: Database.Database): Set<string> {
  const rows = db
    .prepare("SELECT name FROM _migrations ORDER BY id ASC")
    .all() as Array<{ name: string }>;
  return new Set(rows.map((r) => r.name));
}

// ── File discovery ───────────────────────────────────────────────────────────

function migrationFiles(dbName: DbName): string[] {
  const dir = path.join(MIGRATIONS_BASE, dbName);
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => /^\d{3}_.+\.(ts|js)$/.test(f))
    .sort();
}

// ── Runner ───────────────────────────────────────────────────────────────────

export interface RunnerResult {
  dbName: DbName;
  applied: string[];
  skipped: string[];
}

export async function runMigrations(
  db: Database.Database,
  dbName: DbName,
  direction: "up" | "down" = "up",
  steps = Infinity,
): Promise<RunnerResult> {
  ensureMetaTable(db);

  const files = migrationFiles(dbName);
  const applied = appliedMigrations(db);

  const result: RunnerResult = { dbName, applied: [], skipped: [] };

  if (direction === "up") {
    let count = 0;
    for (const file of files) {
      if (count >= steps) break;
      const name = file.replace(/\.(ts|js)$/, "");
      if (applied.has(name)) {
        result.skipped.push(name);
        continue;
      }

      logger.info({ dbName, migration: name }, "applying migration");
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const mod: Migration = require(path.join(MIGRATIONS_BASE, dbName, file));
      const runUp = db.transaction(() => {
        mod.up(db);
        db.prepare(
          "INSERT INTO _migrations (name) VALUES (?)",
        ).run(name);
      });
      runUp();
      result.applied.push(name);
      count++;
      logger.info({ dbName, migration: name }, "migration applied");
    }
  } else {
    // DOWN: reverse order, only roll back applied migrations.
    const appliedFiles = files
      .filter((f) => applied.has(f.replace(/\.(ts|js)$/, "")))
      .reverse();

    let count = 0;
    for (const file of appliedFiles) {
      if (count >= steps) break;
      const name = file.replace(/\.(ts|js)$/, "");

      logger.info({ dbName, migration: name }, "rolling back migration");
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const mod: Migration = require(path.join(MIGRATIONS_BASE, dbName, file));
      const runDown = db.transaction(() => {
        mod.down(db);
        db.prepare("DELETE FROM _migrations WHERE name = ?").run(name);
      });
      runDown();
      result.applied.push(name);
      count++;
      logger.info({ dbName, migration: name }, "migration rolled back");
    }
  }

  return result;
}

/**
 * Run all pending `up` migrations across all three databases.
 * Called automatically by `getDb()` before the first query.
 */
export async function runAllMigrations(
  dbs: Record<DbName, Database.Database>,
): Promise<void> {
  for (const dbName of ["agents", "tasks", "payments"] as DbName[]) {
    const result = await runMigrations(dbs[dbName], dbName, "up");
    if (result.applied.length > 0) {
      logger.info(
        { dbName, applied: result.applied },
        "migrations applied",
      );
    }
  }
}
