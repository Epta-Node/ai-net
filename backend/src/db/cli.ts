/**
 * `npm run db:migrate` / `db:rollback` / `db:seed` entry point.
 *
 * Also hosts the operator CLI from Issue #739:
 *   db:cli dlq list|replay|purge
 *   db:cli backup list|verify|restore
 *
 * Operates on all three SQLite databases the backend owns (payments,
 * agents, tasks) — each has its own migrations directory, applied
 * independently, so "migrate" always brings every database to its own
 * latest version in one command.
 *
 * This file is the only `process`-touching layer of the CLI: argv parsing
 * and the readline confirmation live here, while every operation that
 * mutates the store, the backup directory or the audit log is delegated to
 * the testable command bodies in `db/cliOps.ts`.
 */

import path from "path";
import readline from "readline/promises";
import Database from "better-sqlite3";
import { migrateToLatest, rollback } from "./migrator";
import { seed } from "./seed";
import {
  consoleIo,
  listBackups,
  listDeadLetters,
  purgeDeadLetters,
  replayDeadLetter,
  restoreBackup,
  verifyBackup,
} from "./cliOps";

interface DbTarget {
  name: string;
  dbPath: string;
  migrationsDir: string;
}

function targets(): DbTarget[] {
  const cwd = process.cwd();
  const migrationsRoot = path.join(__dirname, "migrations");
  return [
    { name: "payments", dbPath: path.join(cwd, "payments.db"), migrationsDir: path.join(migrationsRoot, "payments") },
    { name: "agents", dbPath: path.join(cwd, "agents.db"), migrationsDir: path.join(migrationsRoot, "agents") },
    { name: "tasks", dbPath: path.join(cwd, "tasks.db"), migrationsDir: path.join(migrationsRoot, "tasks") },
  ];
}

/** Readline-backed confirmation; `--yes` callers never construct one. */
function readlineConfirm(question: string): Promise<boolean> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return rl
    .question(question)
    .then((answer) => /^y(es)?$/i.test(answer.trim()))
    .finally(() => rl.close());
}

function flagValue(rest: string[], name: string): string | undefined {
  const index = rest.indexOf(name);
  return index >= 0 ? rest[index + 1] : undefined;
}

function hasFlag(rest: string[], name: string): boolean {
  return rest.includes(name);
}

function numberFlag(rest: string[], name: string, fallback: number): number {
  const raw = flagValue(rest, name);
  const parsed = raw === undefined ? Number.NaN : Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

const DLQ_USAGE = `Usage:
  dlq list [--page N] [--pageSize N]
  dlq replay <jobId> [--actor <name>]
  dlq purge [--days N] [--yes] [--actor <name>]

  --days 0 (default) purges every dead-letter entry.`;

const BACKUP_USAGE = `Usage:
  backup list [--dir <path>]
  backup verify <file>
  backup restore <file> [--to <path>] [--dry-run] [--force] [--yes] [--actor <name>]`;

async function runDlqCli(rest: string[]): Promise<void> {
  const [subcommand, ...args] = rest;
  switch (subcommand) {
    case "list":
      listDeadLetters({
        page: numberFlag(args, "--page", 1),
        pageSize: numberFlag(args, "--pageSize", 50),
        io: consoleIo,
      });
      return;
    case "replay": {
      const jobId = args.find((arg) => !arg.startsWith("--"));
      if (!jobId) {
        console.error("dlq replay requires a job id\n" + DLQ_USAGE);
        process.exitCode = 1;
        return;
      }
      const result = replayDeadLetter({ jobId, actor: flagValue(args, "--actor") ?? "cli", io: consoleIo });
      if (!result.requeued) process.exitCode = 1;
      return;
    }
    case "purge": {
      const result = await purgeDeadLetters({
        olderThanDays: numberFlag(args, "--days", 0),
        actor: flagValue(args, "--actor") ?? "cli",
        confirm: hasFlag(args, "--yes") ? undefined : readlineConfirm,
        io: consoleIo,
      });
      if (result.aborted) process.exitCode = 1;
      return;
    }
    default:
      console.error(`Unknown dlq subcommand: ${subcommand ?? "(none)"}\n${DLQ_USAGE}`);
      process.exitCode = 1;
  }
}

async function runBackupCli(rest: string[]): Promise<void> {
  const [subcommand, ...args] = rest;
  switch (subcommand) {
    case "list":
      listBackups({ directory: flagValue(args, "--dir"), io: consoleIo });
      return;
    case "verify": {
      const file = args.find((arg) => !arg.startsWith("--"));
      if (!file) {
        console.error("backup verify requires a file path\n" + BACKUP_USAGE);
        process.exitCode = 1;
        return;
      }
      const result = verifyBackup({ file, io: consoleIo });
      if (!result.ok) process.exitCode = 1;
      return;
    }
    case "restore": {
      const file = args.find((arg) => !arg.startsWith("--"));
      if (!file) {
        console.error("backup restore requires a file path\n" + BACKUP_USAGE);
        process.exitCode = 1;
        return;
      }
      const dryRun = hasFlag(args, "--dry-run");
      const result = await restoreBackup({
        file,
        target: flagValue(args, "--to"),
        dryRun,
        force: hasFlag(args, "--force"),
        actor: flagValue(args, "--actor") ?? "cli",
        // A dry run changes nothing, so it never blocks on a prompt.
        confirm: dryRun || hasFlag(args, "--yes") ? undefined : readlineConfirm,
        io: consoleIo,
      });
      if (!result.ok || result.aborted) process.exitCode = 1;
      return;
    }
    default:
      console.error(`Unknown backup subcommand: ${subcommand ?? "(none)"}\n${BACKUP_USAGE}`);
      process.exitCode = 1;
  }
}

function runMigrate(): void {
  for (const target of targets()) {
    const db = new Database(target.dbPath);
    try {
      const { applied } = migrateToLatest(db, target.migrationsDir);
      if (applied.length === 0) {
        console.log(`[${target.name}] already at latest`);
      } else {
        console.log(`[${target.name}] applied: ${applied.join(", ")}`);
      }
    } finally {
      db.close();
    }
  }
}

function runRollback(steps: number): void {
  for (const target of targets()) {
    const db = new Database(target.dbPath);
    try {
      const { rolledBack } = rollback(db, target.migrationsDir, steps);
      if (rolledBack.length === 0) {
        console.log(`[${target.name}] nothing to roll back`);
      } else {
        console.log(`[${target.name}] rolled back: ${rolledBack.join(", ")}`);
      }
    } finally {
      db.close();
    }
  }
}

function runSeed(): void {
  runMigrate(); // seeding assumes an up-to-date schema
  seed();
}

function main(): void {
  const [, , command, ...rest] = process.argv;

  switch (command) {
    case "migrate":
      runMigrate();
      break;
    case "rollback": {
      const stepsFlagIndex = rest.indexOf("--steps");
      const steps = stepsFlagIndex >= 0 ? Number(rest[stepsFlagIndex + 1]) : 1;
      runRollback(Number.isFinite(steps) && steps > 0 ? steps : 1);
      break;
    }
    case "seed":
      runSeed();
      break;
    case "dlq":
      void runDlqCli(rest).catch((err) => {
        console.error(err instanceof Error ? err.message : String(err));
        process.exitCode = 1;
      });
      break;
    case "backup":
      void runBackupCli(rest).catch((err) => {
        console.error(err instanceof Error ? err.message : String(err));
        process.exitCode = 1;
      });
      break;
    default:
      console.error(
        `Unknown command: ${command ?? "(none)"}. Expected one of: migrate, rollback, seed, dlq, backup`,
      );
      process.exit(1);
  }
}

main();
