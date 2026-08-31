/**
 * Unit tests for the AgentCleanupService and HeartbeatService.
 *
 * Both services run periodic background tasks. We use jest fake timers
 * to drive intervals without waiting real time.
 */
import Database from "better-sqlite3";
import { createAgentDb, type AgentRecord } from "../db/agents";
import { AgentCleanupService } from "./agentCleanup";
import {
  createHeartbeatService,
  startHeartbeatService,
  stopHeartbeatService,
} from "./heartbeat";

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeInMemoryDb(): Database.Database {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE IF NOT EXISTS agents (
      id               TEXT PRIMARY KEY,
      capabilities     TEXT NOT NULL,
      pricingXLM       REAL NOT NULL,
      endpoint         TEXT NOT NULL,
      stellarPublicKey TEXT NOT NULL,
      reputationScore  REAL NOT NULL DEFAULT 0,
      lastSeenAt       TEXT NOT NULL,
      status           TEXT NOT NULL DEFAULT 'online'
    )
  `);
  return db;
}

function insertAgent(db: Database.Database, id: string, status: "online" | "offline", lastSeenMinsAgo: number): void {
  const lastSeenAt = new Date(Date.now() - lastSeenMinsAgo * 60_000).toISOString();
  db.prepare(
    `INSERT INTO agents (id, capabilities, pricingXLM, endpoint, stellarPublicKey, reputationScore, lastSeenAt, status)
     VALUES (?, '["test"]', 1.0, 'http://localhost', 'GTEST', 0, ?, ?)`
  ).run(id, lastSeenAt, status);
}

// ─────────────────────────────────────────────────────────────────────────────
//  AgentCleanupService
// ─────────────────────────────────────────────────────────────────────────────

describe("AgentCleanupService", () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it("does not run until start() is called", () => {
    const svc = new AgentCleanupService({ intervalMs: 1_000, ttlMs: 5_000 });
    const tick = jest.spyOn(svc as any, "tick");
    // Do not call start()
    jest.advanceTimersByTime(5_000);
    expect(tick).not.toHaveBeenCalled();
  });

  it("runs tick immediately on start()", () => {
    const svc = new AgentCleanupService({ intervalMs: 1_000, ttlMs: 5_000 });
    const tick = jest.spyOn(svc as any, "tick");
    svc.start();
    expect(tick).toHaveBeenCalledTimes(1);
  });

  it("runs tick on each interval after start()", () => {
    const svc = new AgentCleanupService({ intervalMs: 1_000, ttlMs: 5_000 });
    const tick = jest.spyOn(svc as any, "tick");
    svc.start();
    jest.advanceTimersByTime(3_000);
    // 1 immediate + 3 interval ticks
    expect(tick).toHaveBeenCalledTimes(4);
  });

  it("stops running after stop()", () => {
    const svc = new AgentCleanupService({ intervalMs: 1_000, ttlMs: 5_000 });
    const tick = jest.spyOn(svc as any, "tick");
    svc.start();
    svc.stop();
    jest.advanceTimersByTime(5_000);
    // Only the immediate tick, no further ticks
    expect(tick).toHaveBeenCalledTimes(1);
  });

  it("calling start() twice does not create duplicate intervals", () => {
    const svc = new AgentCleanupService({ intervalMs: 1_000, ttlMs: 5_000 });
    const tick = jest.spyOn(svc as any, "tick");
    svc.start();
    svc.start(); // should be a no-op
    jest.advanceTimersByTime(2_000);
    // 1 immediate + 2 interval ticks (not doubled)
    expect(tick).toHaveBeenCalledTimes(3);
  });

  it("calling stop() is idempotent (safe to call when not running)", () => {
    const svc = new AgentCleanupService({ intervalMs: 1_000, ttlMs: 5_000 });
    expect(() => {
      svc.stop();
      svc.stop();
    }).not.toThrow();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
//  HeartbeatService
// ─────────────────────────────────────────────────────────────────────────────

describe("createHeartbeatService", () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it("marks stale online agents offline on each cleanup run", () => {
    const rawDb = makeInMemoryDb();
    const db = createAgentDb(rawDb);

    // Agent whose last heartbeat was 10 minutes ago (stale with 5-min threshold)
    insertAgent(rawDb, "stale-agent", "online", 10);

    const svc = createHeartbeatService({
      intervalMs: 1_000,
      staleThresholdMinutes: 5,
      offlineThresholdHours: 24,
      db,
    });

    svc.start();
    jest.advanceTimersByTime(1_000);
    svc.stop();

    const agent = db.findById("stale-agent");
    expect(agent?.status).toBe("offline");
  });

  it("does not mark fresh online agents offline", () => {
    const rawDb = makeInMemoryDb();
    const db = createAgentDb(rawDb);

    // Agent whose last heartbeat was 1 minute ago (fresh with 5-min threshold)
    insertAgent(rawDb, "fresh-agent", "online", 1);

    const svc = createHeartbeatService({
      intervalMs: 1_000,
      staleThresholdMinutes: 5,
      offlineThresholdHours: 24,
      db,
    });

    svc.start();
    jest.advanceTimersByTime(1_000);
    svc.stop();

    const agent = db.findById("fresh-agent");
    expect(agent?.status).toBe("online");
  });

  it("deletes old offline agents after the offline threshold", () => {
    const rawDb = makeInMemoryDb();
    const db = createAgentDb(rawDb);

    // Agent that has been offline for 26 hours — should be deleted
    const oldTime = new Date(Date.now() - 26 * 60 * 60 * 1000).toISOString();
    rawDb.prepare(
      `INSERT INTO agents (id, capabilities, pricingXLM, endpoint, stellarPublicKey, reputationScore, lastSeenAt, status)
       VALUES (?, '["test"]', 1.0, 'http://localhost', 'GTEST', 0, ?, 'offline')`
    ).run("old-offline-agent", oldTime);

    const svc = createHeartbeatService({
      intervalMs: 1_000,
      staleThresholdMinutes: 5,
      offlineThresholdHours: 24,
      db,
    });

    svc.start();
    jest.advanceTimersByTime(1_000);
    svc.stop();

    const agent = db.findById("old-offline-agent");
    expect(agent).toBeUndefined();
  });

  it("stop() clears the interval and prevents further cleanup runs", () => {
    const rawDb = makeInMemoryDb();
    const db = createAgentDb(rawDb);
    const markSpy = jest.spyOn(db, "markStaleAgents");

    const svc = createHeartbeatService({ intervalMs: 1_000, db });
    svc.start();
    svc.stop();
    jest.advanceTimersByTime(5_000);

    // markStaleAgents should not have been called (interval fired 0 times after stop)
    expect(markSpy).not.toHaveBeenCalled();
  });

  it("calling stop() twice does not throw", () => {
    const rawDb = makeInMemoryDb();
    const db = createAgentDb(rawDb);
    const svc = createHeartbeatService({ intervalMs: 1_000, db });
    svc.start();
    expect(() => {
      svc.stop();
      svc.stop();
    }).not.toThrow();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
//  startHeartbeatService / stopHeartbeatService (singleton helpers)
// ─────────────────────────────────────────────────────────────────────────────

describe("startHeartbeatService / stopHeartbeatService (singleton)", () => {
  afterEach(() => {
    // Always clean up singleton state
    stopHeartbeatService();
    jest.useRealTimers();
    jest.resetModules();
  });

  beforeEach(() => {
    jest.useFakeTimers();
  });

  it("startHeartbeatService returns a service and can be stopped", () => {
    const rawDb = makeInMemoryDb();
    const db = createAgentDb(rawDb);

    const svc = startHeartbeatService({ intervalMs: 500, db });
    expect(svc).toBeDefined();
    expect(typeof svc.start).toBe("function");
    expect(typeof svc.stop).toBe("function");

    stopHeartbeatService();
  });

  it("calling startHeartbeatService twice returns the same singleton", () => {
    const rawDb = makeInMemoryDb();
    const db = createAgentDb(rawDb);

    const svc1 = startHeartbeatService({ intervalMs: 500, db });
    const svc2 = startHeartbeatService({ intervalMs: 500, db });
    expect(svc1).toBe(svc2);

    stopHeartbeatService();
  });

  it("stopHeartbeatService clears the singleton so next start creates fresh", () => {
    const rawDb = makeInMemoryDb();
    const db = createAgentDb(rawDb);

    const svc1 = startHeartbeatService({ intervalMs: 500, db });
    stopHeartbeatService();
    const svc2 = startHeartbeatService({ intervalMs: 500, db });
    expect(svc1).not.toBe(svc2);

    stopHeartbeatService();
  });
});
