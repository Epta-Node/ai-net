#!/usr/bin/env ts-node
/**
 * Seed script — runs all pending migrations first, then inserts sample data.
 *
 *   npx ts-node backend/scripts/seed.ts
 *
 * Issue #1000
 */

import Database from "better-sqlite3";
import path from "path";
import { runMigrations, type DbName } from "../src/db/migrations/runner";

const DB_PATHS: Record<DbName, string> = {
  agents: path.join(process.cwd(), "agents.db"),
  tasks: path.join(process.cwd(), "tasks.db"),
  payments: path.join(process.cwd(), "payments.db"),
};

(async () => {
  // 1. Run all pending migrations first.
  for (const dbName of ["agents", "tasks", "payments"] as DbName[]) {
    const db = new Database(DB_PATHS[dbName]);
    db.pragma("journal_mode = WAL");
    const result = await runMigrations(db, dbName, "up");
    result.applied.forEach((m) => console.log(`[migrate][${dbName}] ✓ ${m}`));
    db.close();
  }

  // 2. Insert sample agents.
  const agentsDb = new Database(DB_PATHS.agents);
  agentsDb.pragma("journal_mode = WAL");
  const insertAgent = agentsDb.prepare(`
    INSERT OR IGNORE INTO agents (id, capabilities, pricingXLM, endpoint, stellarPublicKey, reputationScore)
    VALUES (@id, @capabilities, @pricingXLM, @endpoint, @stellarPublicKey, @reputationScore)
  `);
  [
    { id: "agent-research-001", capabilities: JSON.stringify(["research"]), pricingXLM: 0.5, endpoint: "http://localhost:4001", stellarPublicKey: "GABC1RESEARCHAGENTPUBLICKEY000000000000000000000000000", reputationScore: 4.5 },
    { id: "agent-risk-001",     capabilities: JSON.stringify(["risk"]),     pricingXLM: 0.3, endpoint: "http://localhost:4002", stellarPublicKey: "GABC2RISKAGENTPUBLICKEY0000000000000000000000000000000", reputationScore: 4.2 },
    { id: "agent-coding-001",   capabilities: JSON.stringify(["coding"]),   pricingXLM: 0.8, endpoint: "http://localhost:4003", stellarPublicKey: "GABC3CODINGAGENTPUBLICKEY00000000000000000000000000000", reputationScore: 4.7 },
  ].forEach((a) => insertAgent.run(a));
  agentsDb.close();
  console.log("[seed] 3 sample agents inserted.");

  // 3. Insert sample tasks.
  const tasksDb = new Database(DB_PATHS.tasks);
  tasksDb.pragma("journal_mode = WAL");
  const insertTask = tasksDb.prepare(`
    INSERT OR IGNORE INTO tasks (id, prompt, walletPublicKey, status)
    VALUES (@id, @prompt, @walletPublicKey, @status)
  `);
  [
    { id: "task_seed001", prompt: "Generate a market-entry report for solar energy in Southeast Asia", walletPublicKey: "GSEED_WALLET_1", status: "completed" },
    { id: "task_seed002", prompt: "Analyse regulatory risk for fintech in Nigeria", walletPublicKey: "GSEED_WALLET_1", status: "queued" },
  ].forEach((t) => insertTask.run(t));
  tasksDb.close();
  console.log("[seed] 2 sample tasks inserted.");

  console.log("Seed complete.");
})().catch((err) => {
  console.error("Seed failed:", err);
  process.exit(1);
});
