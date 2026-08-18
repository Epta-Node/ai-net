/**
 * Integration test for GET /api/stats
 *
 * Verifies that the stats router is correctly mounted in the Express app at
 * /api/stats and returns a valid JSON payload instead of a 404.
 *
 * Uses a lightweight Express app (mirroring the agents.test.ts pattern) so
 * each test case gets a fresh StatsCache instance and a clean database state.
 *
 * Note: db/stats.ts uses SQLite (better-sqlite3) syntax throughout, so these
 * tests work against an in-memory SQLite database. Full end-to-end correctness
 * depends on issue #164 (SQL dialect fix).
 */

import express from "express";
import request from "supertest";
import Database from "better-sqlite3";
import { createStatsRouter } from "../src/api/routes/stats";

/** Create an isolated in-memory database with all tables the stats queries need. */
function createTestDb(): Database.Database {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE IF NOT EXISTS agents (
      id TEXT PRIMARY KEY
    );

    CREATE TABLE IF NOT EXISTS tasks (
      id        TEXT PRIMARY KEY,
      status    TEXT NOT NULL,
      "createdAt" TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS payments (
      id        TEXT PRIMARY KEY,
      amount    REAL NOT NULL,
      status    TEXT NOT NULL,
      "createdAt" TEXT NOT NULL
    );
  `);
  return db;
}

/** Minimal Express app that mounts createStatsRouter at /api/stats. */
function createTestApp(db: Database.Database) {
  const app = express();
  app.use(express.json());
  app.use("/api/stats", createStatsRouter(db));
  return app;
}

describe("GET /api/stats", () => {
  it("returns 200 with the expected stats shape on an empty database", async () => {
    const db = createTestDb();
    const app = createTestApp(db);

    const res = await request(app).get("/api/stats");

    expect(res.status).toBe(200);

    // All fields must be present.
    expect(typeof res.body.totalAgents).toBe("number");
    expect(typeof res.body.totalTasks).toBe("number");
    expect(typeof res.body.uptimePercent).toBe("number");
    expect(typeof res.body.totalXLMTransacted).toBe("number");
    expect(Array.isArray(res.body.tasksLast24h)).toBe(true);
    expect(Array.isArray(res.body.xlmLast24h)).toBe(true);

    // 24 hourly buckets for each time-series.
    expect(res.body.tasksLast24h).toHaveLength(24);
    expect(res.body.xlmLast24h).toHaveLength(24);

    // Empty database → zeroed totals and 100 % uptime (no tasks to fail).
    expect(res.body.totalAgents).toBe(0);
    expect(res.body.totalTasks).toBe(0);
    expect(res.body.uptimePercent).toBe(100);
    expect(res.body.totalXLMTransacted).toBe(0);

    db.close();
  });

  it("reflects inserted data correctly", async () => {
    const db = createTestDb();

    db.exec(`
      INSERT INTO agents (id) VALUES ('agent-1'), ('agent-2');

      INSERT INTO tasks (id, status, "createdAt") VALUES
        ('t1', 'completed', datetime('now', '-1 hour')),
        ('t2', 'completed', datetime('now', '-1 hour')),
        ('t3', 'failed',    datetime('now', '-1 hour'));

      INSERT INTO payments (id, amount, status, "createdAt") VALUES
        ('p1', 50000000, 'released', datetime('now', '-1 hour'));
    `);

    const app = createTestApp(db);
    const res = await request(app).get("/api/stats");

    expect(res.status).toBe(200);
    expect(res.body.totalAgents).toBe(2);
    expect(res.body.totalTasks).toBe(3);
    // 2 out of 3 tasks completed → ~66.66667 %
    expect(res.body.uptimePercent).toBeCloseTo(66.6667, 3);
    // 50_000_000 stroops / 1e7 = 5 XLM
    expect(res.body.totalXLMTransacted).toBe(5);

    db.close();
  });

  it("returns 500 when the database throws", async () => {
    const db = createTestDb();
    // Close the db to force an error on any subsequent query.
    db.close();

    const app = createTestApp(db);
    const res = await request(app).get("/api/stats");

    expect(res.status).toBe(500);
    expect(res.body).toHaveProperty("error");
  });

  it("is wired in the full Express app at /api/stats (not a 404)", async () => {
    // Verify the router is correctly mounted inside createApp by importing the
    // factory and checking the stats path directly.
    const Database = require("better-sqlite3");
    const { createApp } = require("../src/api");

    const inMemoryDb = new Database(":memory:");
    inMemoryDb.exec(`
      CREATE TABLE IF NOT EXISTS agents (id TEXT PRIMARY KEY);
      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY, status TEXT NOT NULL, "createdAt" TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS payments (
        id TEXT PRIMARY KEY, amount REAL NOT NULL,
        status TEXT NOT NULL, "createdAt" TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS task_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        taskId TEXT NOT NULL,
        type TEXT NOT NULL,
        nodeId TEXT,
        payload TEXT,
        timestamp TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS tasks_main (
        id TEXT PRIMARY KEY,
        prompt TEXT NOT NULL,
        walletPublicKey TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'queued',
        dagJson TEXT NOT NULL DEFAULT '[]',
        createdAt TEXT NOT NULL,
        updatedAt TEXT NOT NULL
      );
    `);

    const getTaskDbSpy = jest
      .spyOn(require("../src/db/tasks"), "getTaskDb")
      .mockReturnValue(inMemoryDb);

    const app = createApp();

    const res = await request(app.httpServer).get("/api/stats");

    expect(res.status).toBe(200);
    expect(typeof res.body.totalAgents).toBe("number");

    app.close();
    inMemoryDb.close();
    getTaskDbSpy.mockRestore();
  });
});
