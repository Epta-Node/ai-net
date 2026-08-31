/**
 * `npm run db:migrate` / `db:rollback` / `db:seed` entry point.
 *
 * Operates on all three SQLite databases the backend owns (payments,
 * agents, tasks) — each has its own migrations directory, applied
 * independently, so "migrate" always brings every database to its own
 * latest version in one command.
 */

import path from "path";
import Database from "better-sqlite3";
import { migrateToLatest, rollback } from "./migrator";
import { seed } from "./seed";

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
    default:
      console.error(`Unknown command: ${command ?? "(none)"}. Expected one of: migrate, rollback, seed`);
      process.exit(1);
  }
}

main();
