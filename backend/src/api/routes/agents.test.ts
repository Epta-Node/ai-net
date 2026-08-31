/**
 * Additional unit tests for the agents router.
 * Targets uncovered lines: list error branch (line 80), agent health check
 * (lines 290-299), and DELETE agent with signature verification (lines 374-402).
 *
 * Uses an in-memory AgentDb injected via router options.
 */
import express from "express";
import request from "supertest";
import Database from "better-sqlite3";
import { createAgentDb, type AgentDb } from "../../db/agents";
import { createAgentsRouter } from "./agents";

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeDb(): Database.Database {
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

function buildApp(db: AgentDb, healthTimeoutMs = 500) {
  const app = express();
  app.use(express.json());
  app.use("/api/agents", createAgentsRouter({ db, healthTimeoutMs }));
  return app;
}

const VALID_KEY = "GTESTAGENTSTELLARKEYAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

// ─────────────────────────────────────────────────────────────────────────────
//  GET /api/agents — list error branch
// ─────────────────────────────────────────────────────────────────────────────

describe("GET /api/agents — db error returns 500", () => {
  it("returns 500 when db.list() throws", async () => {
    const raw = makeDb();
    const db = createAgentDb(raw);
    const failingDb: AgentDb = {
      ...db,
      list: () => { throw new Error("DB exploded"); },
    };

    const app = buildApp(failingDb);
    const res = await request(app).get("/api/agents");
    expect(res.status).toBe(500);
    expect(res.body.error).toBe("Internal Server Error");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
//  GET /api/agents/:id/health
// ─────────────────────────────────────────────────────────────────────────────

describe("GET /api/agents/:id/health", () => {
  let fetchSpy: jest.SpyInstance;

  beforeEach(() => {
    fetchSpy = jest.spyOn(global, "fetch" as any);
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it("returns 404 for unknown agent", async () => {
    const db = createAgentDb(makeDb());
    const app = buildApp(db);
    const res = await request(app).get("/api/agents/nonexistent/health");
    expect(res.status).toBe(404);
  });

  it("returns healthy when agent endpoint responds ok", async () => {
    fetchSpy.mockResolvedValue({ ok: true } as Response);
    const db = createAgentDb(makeDb());
    db.upsert({
      id: "health-agent",
      capabilities: ["research"],
      pricingXLM: 1,
      endpoint: "http://localhost:9001/health",
      stellarPublicKey: VALID_KEY,
      reputationScore: 0,
      lastSeenAt: new Date().toISOString(),
      status: "online",
    });

    const app = buildApp(db);
    const res = await request(app).get("/api/agents/health-agent/health");
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("healthy");
    expect(typeof res.body.latencyMs).toBe("number");
  });

  it("returns unreachable when agent endpoint returns non-ok", async () => {
    fetchSpy.mockResolvedValue({ ok: false, status: 503 } as Response);
    const db = createAgentDb(makeDb());
    db.upsert({
      id: "unhealthy-agent",
      capabilities: ["research"],
      pricingXLM: 1,
      endpoint: "http://localhost:9001/health",
      stellarPublicKey: VALID_KEY,
      reputationScore: 0,
      lastSeenAt: new Date().toISOString(),
      status: "online",
    });

    const app = buildApp(db);
    const res = await request(app).get("/api/agents/unhealthy-agent/health");
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("unreachable");
  });

  it("returns unreachable when fetch throws (network error)", async () => {
    fetchSpy.mockRejectedValue(new Error("ECONNREFUSED"));
    const db = createAgentDb(makeDb());
    db.upsert({
      id: "down-agent",
      capabilities: ["research"],
      pricingXLM: 1,
      endpoint: "http://localhost:9001/health",
      stellarPublicKey: VALID_KEY,
      reputationScore: 0,
      lastSeenAt: new Date().toISOString(),
      status: "online",
    });

    const app = buildApp(db);
    const res = await request(app).get("/api/agents/down-agent/health");
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("unreachable");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
//  DELETE /api/agents/:id
// ─────────────────────────────────────────────────────────────────────────────

describe("DELETE /api/agents/:id", () => {
  it("returns 404 for unknown agent", async () => {
    const db = createAgentDb(makeDb());
    const app = buildApp(db);
    const res = await request(app)
      .delete("/api/agents/nonexistent")
      .set("x-signature", "sig")
      .set("x-challenge", "chal");
    expect(res.status).toBe(404);
  });

  it("returns 401 when signature headers are missing", async () => {
    const db = createAgentDb(makeDb());
    db.upsert({
      id: "del-agent",
      capabilities: ["research"],
      pricingXLM: 1,
      endpoint: "http://localhost:9001",
      stellarPublicKey: VALID_KEY,
      reputationScore: 0,
      lastSeenAt: new Date().toISOString(),
      status: "online",
    });
    const app = buildApp(db);
    const res = await request(app).delete("/api/agents/del-agent");
    expect(res.status).toBe(401);
    expect(res.body.error).toMatch(/Missing challenge or signature/i);
  });

  it("returns 401 when signature is invalid", async () => {
    const db = createAgentDb(makeDb());
    db.upsert({
      id: "del-agent",
      capabilities: ["research"],
      pricingXLM: 1,
      endpoint: "http://localhost:9001",
      stellarPublicKey: VALID_KEY,
      reputationScore: 0,
      lastSeenAt: new Date().toISOString(),
      status: "online",
    });
    const app = buildApp(db);
    const res = await request(app)
      .delete("/api/agents/del-agent")
      .set("x-signature", "badsignature==")
      .set("x-challenge", "mychallenge");
    // Invalid signature format or fails verification
    expect([401]).toContain(res.status);
  });
});
