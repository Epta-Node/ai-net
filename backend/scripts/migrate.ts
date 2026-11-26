#!/usr/bin/env ts-node
/**
 * CLI migration script.
 *
 *   npx ts-node backend/scripts/migrate.ts --db tasks --direction up
 *   npx ts-node backend/scripts/migrate.ts --db all --direction up
 *   npx ts-node backend/scripts/migrate.ts --db tasks --direction down --steps 1
 *
 * Issue #1000
 */

import Database from "better-sqlite3";
import path from "path";
import { runMigrations, type DbName } from "../src/db/migrations/runner";

const args = process.argv.slice(2);

function getArg(flag: string): string | undefined {
  const idx = args.indexOf(flag);
  return idx !== -1 ? args[idx + 1] : undefined;
}

const dbArg = (getArg("--db") ?? "all") as DbName | "all";
const direction = (getArg("--direction") ?? "up") as "up" | "down";
const stepsArg = getArg("--steps");
const steps = stepsArg ? parseInt(stepsArg, 10) : Infinity;

const DB_PATHS: Record<DbName, string> = {
  agents: path.join(process.cwd(), "agents.db"),
  tasks: path.join(process.cwd(), "tasks.db"),
  payments: path.join(process.cwd(), "payments.db"),
};

const targetDbs: DbName[] =
  dbArg === "all" ? ["agents", "tasks", "payments"] : [dbArg];

(async () => {
  for (const dbName of targetDbs) {
    const db = new Database(DB_PATHS[dbName]);
    db.pragma("journal_mode = WAL");
    try {
      const result = await runMigrations(db, dbName, direction, steps);
      if (result.applied.length === 0) {
        console.log(`[${dbName}] No migrations to ${direction}.`);
      } else {
        result.applied.forEach((m) =>
          console.log(`[${dbName}] ✓ ${direction === "up" ? "Applied" : "Rolled back"}: ${m}`),
        );
      }
    } finally {
      db.close();
    }
  }
  console.log("Done.");
})().catch((err) => {
  console.error("Migration failed:", err);
  process.exit(1);
});
