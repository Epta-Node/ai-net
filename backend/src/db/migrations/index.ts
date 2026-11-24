/**
 * Versioned SQLite schema migrations.
 *
 * The migration set in this directory is the authoritative schema for the
 * consolidated database pointed at by `DATABASE_URL` (`db:migrate`).
 *
 * @example
 * ```bash
 * npm run db:migrate                                  # apply pending migrations
 * npm run db:migrate -- --status                      # show applied / pending
 * npm run db:migrate -- --dry-run                     # show what would run
 * npm run db:migrate -- --include-down-migrations --down --to=0001
 * ```
 */

export {
  DOWN_MARKER,
  MigrationLoadError,
  loadMigrations,
  parseMigrationFile,
  resolveMigrationsDir,
  type Migration,
} from "./loader";

export {
  MigrationTracker,
  SCHEMA_MIGRATIONS_DDL,
  describeMigrationStatus,
  type AppliedMigration,
  type MigrationRecord,
  type MigrationStatusEntry,
  type MigrationStatusReport,
} from "./tracker";

export {
  MigrationChecksumError,
  MigrationError,
  MigrationFailedError,
  MigrationRunner,
  type MigrationDirection,
  type MigrationResult,
  type MigrationRunnerOptions,
  type MigrationStatus,
  type DownOptions,
  type UpOptions,
} from "./runner";

export {
  runStartupMigrations,
  type StartupMigrationOptions,
  type StartupMigrationSummary,
} from "./startup";

export {
  readMigrationStatus,
  type MigrationStatusOptions,
  type MigrationStatusResult,
} from "./status";

export { runMigrateCli } from "./cli";
