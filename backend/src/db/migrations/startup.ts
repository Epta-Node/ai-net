/**
 * Automated migration on server startup.
 *
 * Applies every pending migration to the consolidated database *before* the HTTP
 * server starts listening, so a process never serves traffic against a schema it
 * is out of step with. Enabled by `AUTO_MIGRATE`; set it to `false` to leave the
 * schema to an explicit `npm run db:migrate` deploy step.
 *
 * Failures are not swallowed. The runner throws on a broken migration or on
 * drift, this function propagates it, and `main()` aborts startup — running on a
 * partially-migrated schema is worse than not starting at all.
 *
 * @example
 * ```ts
 * if (config.AUTO_MIGRATE) runStartupMigrations();
 * ```
 */

import type Database from "better-sqlite3";
import type { Logger } from "pino";
import { createLogger } from "../../utils/logger";
import { openDatabase, resolveDatabasePath } from "../index";
import { loadMigrations, resolveMigrationsDir } from "./loader";
import { MigrationRunner, type MigrationResult } from "./runner";

export interface StartupMigrationOptions {
  /** Override the consolidated database path (defaults to `DATABASE_URL`). */
  dbPath?: string;
  /** Override the migrations directory (defaults to `DB_MIGRATIONS_DIR`). */
  migrationsDir?: string;
  logger?: Logger;
}

export interface StartupMigrationSummary {
  database: string;
  migrationsDir: string;
  /** One entry per migration the run touched — empty when already up to date. */
  applied: MigrationResult[];
  /** Version the database sits at after the run. */
  currentVersion: string | null;
  /** `true` when the run applied at least one migration. */
  changed: boolean;
}

/**
 * Apply pending migrations to the consolidated database.
 *
 * Opens its own short-lived connection rather than borrowing a pooled one: the
 * consolidated migration database is separate from the per-module runtime
 * databases, so there is no shared handle to reuse and nothing to add to the
 * graceful-shutdown sequence.
 *
 * @throws {MigrationError} when an applied migration drifted or its file vanished.
 * @throws {MigrationFailedError} when a migration's SQL failed and was rolled back.
 */
export function runStartupMigrations(options: StartupMigrationOptions = {}): StartupMigrationSummary {
  const logger = options.logger ?? createLogger({ component: "db-migrate" });
  const dbPath = resolveDatabasePath(options.dbPath);
  const migrationsDir = resolveMigrationsDir(options.migrationsDir);
  const migrations = loadMigrations(migrationsDir);

  let db: Database.Database | null = null;
  try {
    db = openDatabase(dbPath);
    const runner = new MigrationRunner(db, migrations, { logger });
    const applied = runner.up();
    const currentVersion = runner.currentVersion();
    const changed = applied.some((result) => result.status === "applied");

    if (changed) {
      logger.info(
        {
          database: dbPath,
          applied: applied.filter((result) => result.status === "applied").map((r) => r.filename),
          currentVersion,
        },
        "applied pending database migrations",
      );
    } else {
      logger.debug({ database: dbPath, currentVersion }, "database schema already up to date");
    }

    return { database: dbPath, migrationsDir, applied, currentVersion, changed };
  } finally {
    db?.close();
  }
}