/**
 * `npm run db:migrate` entry point.
 *
 * Deliberately free of any import of `../config`: that module validates the
 * full server environment (including `VENICE_API_KEY`) and calls
 * `process.exit(1)` on failure, which would make schema management
 * impossible in CI and in a fresh checkout.
 *
 * @example
 * ```bash
 * npm run db:migrate                                           # apply pending
 * npm run db:migrate -- --status                               # inspect
 * npm run db:migrate -- --dry-run                              # preview
 * npm run db:migrate -- --include-down-migrations --status  # down availability
 * npm run db:migrate -- --include-down-migrations --down --to=0001
 * npm run db:rollback                                          # revert the newest migration
 * npm run db:rollback -- --steps 2                             # revert the newest two
 * ```
 */

import type Database from "better-sqlite3";
import { openDatabase, resolveDatabasePath } from "../index";
import { loadMigrations, resolveMigrationsDir } from "./loader";
import { MigrationFailedError, MigrationRunner, type MigrationResult } from "./runner";

const USAGE = `Usage: npm run db:migrate -- [options]

Options:
  --status                      List applied and pending migrations, then exit
  --dry-run                     Report what would run without writing to the DB
  --down                        Revert migrations (newest first)
  --rollback                    Revert the newest migration (or --steps <n>); implies
                                --down --include-down-migrations. Refuses, changing
                                nothing, if any targeted migration is irreversible
  --to=<version>                With --down: revert everything above <version>
  --steps=<n>                   With --down: revert at most <n> migrations
  --include-down-migrations     Allow down migrations to run (required by --down)
  --database=<path>             Target database file (default: DB_PATH /
                                DATABASE_URL, else ./data/ai-net.db)
  -h, --help                    Show this help

Example:
  npm run db:migrate -- --include-down-migrations --down --to=0001
  npm run db:rollback -- --steps 2
`;

interface CliOptions {
  status: boolean;
  dryRun: boolean;
  down: boolean;
  includeDownMigrations: boolean;
  to?: string;
  steps?: number;
  database?: string;
  help: boolean;
}

export function parseCliArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    status: false,
    dryRun: false,
    down: false,
    includeDownMigrations: false,
    help: false,
  };
  let rollback = false;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    // npm/ts-node forward a literal `--` separator; ignore it so both
    // `npm run db:migrate -- --down` and the double-`--` form work.
    if (arg === "--") continue;

    const separator = arg.indexOf("=");
    const flag = separator === -1 ? arg : arg.slice(0, separator);
    const inline = separator === -1 ? undefined : arg.slice(separator + 1);

    /** Accept both `--flag=value` and `--flag value`. */
    const valueOf = (): string => {
      if (inline !== undefined) return inline;
      const next = argv[i + 1];
      if (next === undefined) {
        throw new Error(`${flag} expects a value`);
      }
      i += 1;
      return next;
    };

    switch (flag) {
      case "-h":
      case "--help":
        options.help = true;
        break;
      case "-s":
      case "--status":
        options.status = true;
        break;
      case "--dry-run":
        options.dryRun = true;
        break;
      case "--down":
        options.down = true;
        break;
      case "--rollback":
        rollback = true;
        break;
      case "--include-down-migrations":
        options.includeDownMigrations = true;
        break;
      case "--to":
        options.to = valueOf();
        break;
      case "--steps": {
        const raw = valueOf();
        const parsed = Number(raw);
        if (!Number.isInteger(parsed) || parsed < 0) {
          throw new Error(`--steps expects a non-negative integer, received "${raw}"`);
        }
        options.steps = parsed;
        break;
      }
      case "--database":
        options.database = valueOf();
        break;
      default:
        if (!arg.startsWith("-") && options.database === undefined) {
          options.database = arg;
          break;
        }
        throw new Error(`Unknown option "${arg}". Run with --help for usage.`);
    }
  }

  if (rollback) {
    options.down = true;
    options.includeDownMigrations = true;
    // A rollback undoes one migration unless told otherwise; a bare `--down`
    // keeps reverting everything.
    if (options.steps === undefined && options.to === undefined) options.steps = 1;
  }

  return options;
}

function reportResults(results: MigrationResult[], dryRun: boolean): void {
  if (results.length === 0) {
    console.log("  no pending migrations — database is up to date");
    return;
  }

  for (const result of results) {
    const duration = result.durationMs > 0 ? ` (${result.durationMs}ms)` : "";
    if (result.error !== undefined) {
      console.error(`  ✗ ${result.filename} — ${result.error}`);
      continue;
    }
    if (result.status === "skipped") {
      continue;
    }
    const verb =
      result.status === "planned"
        ? dryRun
          ? "would apply"
          : "would revert"
        : result.status === "applied"
          ? "applied"
          : "reverted";
    console.log(`  ✓ ${verb} ${result.filename}${duration}`);
  }
}

function reportDownAvailability(runner: MigrationRunner): void {
  const reversible = runner
    .listApplied()
    .filter((record) => record.downSql !== null && record.downSql.trim() !== "")
    .map((record) => record.id);
  const irreversible = runner
    .listApplied()
    .filter((record) => record.downSql === null || record.downSql.trim() === "")
    .map((record) => record.id);

  console.log(
    reversible.length === 0
      ? "  down migrations enabled, but none of the applied migrations define a down section"
      : `  down migrations enabled — reversible: ${reversible.join(", ")}`,
  );
  if (irreversible.length > 0) {
    console.log(`  no down section (forward-only): ${irreversible.join(", ")}`);
  }
}

/**
 * Run the migration set, converting the runner's throwing contract back into
 * the full per-migration result list so the CLI can report every attempt.
 */
function collect(
  run: () => MigrationResult[],
): { results: MigrationResult[]; failed: boolean } {
  try {
    return { results: run(), failed: false };
  } catch (error) {
    if (error instanceof MigrationFailedError) {
      return { results: error.results, failed: true };
    }
    throw error;
  }
}

/**
 * Run the migration tool.
 *
 * @returns a process exit code — `0` on success, `1` on any failure.
 */
export function runMigrateCli(argv: string[] = process.argv.slice(2)): number {
  let options: CliOptions;
  try {
    options = parseCliArgs(argv);
  } catch (error) {
    console.error(`[db:migrate] ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }

  if (options.help) {
    console.log(USAGE);
    return 0;
  }

  let db: Database.Database | null = null;
  try {
    const dbPath = resolveDatabasePath(options.database);
    const migrationsDir = resolveMigrationsDir();
    const migrations = loadMigrations(migrationsDir);

    console.log(`[db:migrate] database:  ${dbPath}`);
    console.log(`[db:migrate] directory: ${migrationsDir}`);
    console.log(`[db:migrate] found ${migrations.length} migration file(s)`);
    if (options.dryRun) {
      console.log("[db:migrate] dry run — no changes will be written");
    }

    db = openDatabase(dbPath);
    const runner = new MigrationRunner(db, migrations, {
      includeDownMigrations: options.includeDownMigrations,
    });

    if (options.status) {
      const applied = runner.listApplied();
      const pending = runner.listPending();
      console.log(`[db:migrate] version:  ${runner.currentVersion() ?? "(none)"}`);
      console.log("[db:migrate] applied:");
      reportResults(
        applied.map((record) => ({
          id: record.id,
          filename: record.filename,
          direction: "up",
          status: "applied",
          durationMs: 0,
        })),
        false,
      );
      console.log("[db:migrate] pending:");
      reportResults(
        pending.map((migration) => ({
          id: migration.id,
          filename: migration.filename,
          direction: "up",
          status: "planned",
          durationMs: 0,
        })),
        true,
      );
      if (options.includeDownMigrations) {
        reportDownAvailability(runner);
      }
      return 0;
    }

    if (options.down) {
      if (!options.includeDownMigrations) {
        console.error(
          "[db:migrate] --down requires --include-down-migrations. " +
            "Down migrations are a development-only affordance and must be requested explicitly.",
        );
        return 1;
      }
      const { results, failed } = collect(() =>
        runner.down({ to: options.to, steps: options.steps, dryRun: options.dryRun }),
      );
      console.log("[db:migrate] down:");
      reportResults(results, options.dryRun);
      const reverted = results.filter((result) => result.status === "reverted").length;
      const planned = results.filter((result) => result.status === "planned").length;
      console.log(
        failed
          ? "[db:migrate] FAILED — the transaction was rolled back; no earlier migrations were touched"
          : `[db:migrate] done — ${options.dryRun ? `would revert ${planned}` : `reverted ${reverted}`} migration(s)`,
      );
      return failed ? 1 : 0;
    }

    if (options.includeDownMigrations) {
      reportDownAvailability(runner);
    }

    const { results, failed } = collect(() => runner.up({ dryRun: options.dryRun }));
    console.log("[db:migrate] up:");
    reportResults(results, options.dryRun);

    const applied = results.filter((result) => result.status === "applied").length;
    const planned = results.filter((result) => result.status === "planned").length;

    if (failed) {
      const remaining = runner.listPending().length;
      console.error(
        `[db:migrate] FAILED at ${results.find((result) => result.error !== undefined)?.filename} — ` +
          `the transaction was rolled back and ${remaining} migration(s) were not applied. ` +
          "Fix the migration and re-run.",
      );
      return 1;
    }

    if (applied === 0 && planned === 0) {
      console.log("[db:migrate] nothing to do — already up to date");
    } else {
      console.log(
        `[db:migrate] done — ${options.dryRun ? `would apply ${planned}` : `applied ${applied}`} migration(s); ` +
          `version is now ${runner.currentVersion() ?? "(none)"}`,
      );
    }
    return 0;
  } catch (error) {
    console.error(`[db:migrate] ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  } finally {
    db?.close();
  }
}

if (require.main === module) {
  process.exit(runMigrateCli());
}
