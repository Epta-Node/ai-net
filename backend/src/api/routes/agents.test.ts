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
import * as agentsDb from "../../db/agents";
import { createAgentsRouter } from "./agents";
import { errorHandler } from "../middleware/errorHandler";

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
      reputationScore  REAL NOT NULL DEFAULT 2.5,
      lastSeenAt       TEXT NOT NULL,
      status           TEXT NOT NULL DEFAULT 'online',
      bondAmountXLM    REAL NOT NULL DEFAULT 0,
      tasksCompleted   INTEGER NOT NULL DEFAULT 0,
      tasksFailed      INTEGER NOT NULL DEFAULT 0,
      lastActiveAt     TEXT
    )
  `);
  return db;
}

function buildApp(db: AgentDb, healthTimeoutMs = 500) {
  const app = express();
  app.use(express.json());
  app.use("/api/agents", createAgentsRouter({ db, healthTimeoutMs }));
  app.use(errorHandler);
  return app;
}

const VALID_KEY = "GTESTAGENTSTELLARKEYAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

// ─────────────────────────────────────────────────────────────────────────────
//  GET /api/agents — list error branch
// ─────────────────────────────────────────────────────────────────────────────

describe("GET /api/agents — db error returns 500", () => {
  it("returns 500 when db.listCursor() throws", async () => {
    const raw = makeDb();
    const db = createAgentDb(raw);
    const failingDb: AgentDb = {
      ...db,
      listCursor: () => { throw new Error("DB exploded"); },
    };

    const app = buildApp(failingDb);
    const res = await request(app).get("/api/agents?limit=20");
    expect(res.status).toBe(500);
    expect(res.body.error).toBeDefined();
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
    // The shared challenge–response helper used by register/heartbeat/delete
    // reports the missing challenge first and tags it AGENT_CHALLENGE_INVALID
    // (#557/#558), replacing the legacy "Missing challenge or signature" text.
    const msg = typeof res.body.error === "string" ? res.body.error : res.body.error?.message;
    expect(msg).toMatch(/Missing agent challenge/i);
    const code = (res.body.error as { code?: string } | undefined)?.code;
    expect(code).toBe("AGENT_CHALLENGE_INVALID");
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

// ─────────────────────────────────────────────────────────────────────────────
//  Reputation Breakdown & Sybil Resistance (Issue #497)
// ─────────────────────────────────────────────────────────────────────────────

describe("GET /api/agents/:id — Reputation Breakdown (Issue #497)", () => {
  it("returns agent details including reputation breakdown", async () => {
    const raw = makeDb();
    const db = createAgentDb(raw);
    db.upsert({
      id: "agent-rep-1",
      capabilities: ["research", "coding"],
      pricingXLM: 0.5,
      endpoint: "http://localhost:9002",
      stellarPublicKey: VALID_KEY,
      reputationScore: 4.2,
      lastSeenAt: new Date().toISOString(),
      status: "online",
      bondAmountXLM: 150,
      tasksCompleted: 10,
      tasksFailed: 1,
    });

    const app = buildApp(db);
    const res = await request(app).get("/api/agents/agent-rep-1");

    expect(res.status).toBe(200);
    expect(res.body.id).toBe("agent-rep-1");
    expect(res.body.reputationScore).toBe(4.2);
    expect(res.body.reputation).toBeDefined();
    expect(res.body.reputation.overallScore).toBe(4.2);
    expect(res.body.reputation.tasksCompleted).toBe(10);
    expect(res.body.reputation.tasksFailed).toBe(1);
    expect(res.body.reputation.bondAmountXLM).toBe(150);
    expect(res.body.reputation.bondWeightMultiplier).toBe(1.15);
  });
});

describe("POST /api/agents/:id/task-result — Reputation Update (Issue #497)", () => {
  it("updates agent reputation on task success with quality and latency", async () => {
    const raw = makeDb();
    const db = createAgentDb(raw);
    db.upsert({
      id: "agent-task-1",
      capabilities: ["research"],
      pricingXLM: 0.25,
      endpoint: "http://localhost:9003",
      stellarPublicKey: VALID_KEY,
      reputationScore: 2.5,
      lastSeenAt: new Date().toISOString(),
      status: "online",
      bondAmountXLM: 100,
      tasksCompleted: 0,
      tasksFailed: 0,
    });

    const app = buildApp(db);
    const res = await request(app)
      .post("/api/agents/agent-task-1/task-result")
      .send({ outcome: "success", qualityScore: 90, latencyMs: 200 });

    expect(res.status).toBe(200);
    expect(res.body.agentId).toBe("agent-task-1");
    expect(res.body.reputationDelta).toBeGreaterThan(0);
    expect(res.body.reputationScore).toBeGreaterThan(2.5);
    expect(res.body.reputation.tasksCompleted).toBe(1);
  });

  it("decreases agent reputation on task failure", async () => {
    const raw = makeDb();
    const db = createAgentDb(raw);
    db.upsert({
      id: "agent-task-2",
      capabilities: ["research"],
      pricingXLM: 0.25,
      endpoint: "http://localhost:9004",
      stellarPublicKey: VALID_KEY,
      reputationScore: 3.0,
      lastSeenAt: new Date().toISOString(),
      status: "online",
    });

    const app = buildApp(db);
    const res = await request(app)
      .post("/api/agents/agent-task-2/task-result")
      .send({ outcome: "failure" });

    expect(res.status).toBe(200);
    expect(res.body.reputationDelta).toBeLessThan(0);
    expect(res.body.reputationScore).toBe(2.8);
    expect(res.body.reputation.tasksFailed).toBe(1);
  });
});

describe("POST /api/agents/register — Sybil Resistance (Issue #497)", () => {
  beforeAll(() => {
    process.env.SKIP_STELLAR_ACCOUNT_VERIFY = "true";
  });

  it("enforces max agents per Stellar account limit", async () => {
    const raw = makeDb();
    const db = createAgentDb(raw);
    process.env.MAX_AGENTS_PER_ACCOUNT = "2";

    // Register 2 agents under the same key
    db.upsert({
      id: "sybil-1",
      capabilities: ["research"],
      pricingXLM: 1,
      endpoint: "http://localhost:9010",
      stellarPublicKey: VALID_KEY,
      reputationScore: 2.5,
      lastSeenAt: new Date().toISOString(),
      status: "online",
    });
    db.upsert({
      id: "sybil-2",
      capabilities: ["coding"],
      pricingXLM: 1,
      endpoint: "http://localhost:9011",
      stellarPublicKey: VALID_KEY,
      reputationScore: 2.5,
      lastSeenAt: new Date().toISOString(),
      status: "online",
    });

    const app = buildApp(db);
    const res = await request(app)
      .post("/api/agents/register")
      .send({
        agentId: "sybil-3",
        capabilities: ["design"],
        pricingXLM: 1.5,
        endpoint: "http://localhost:9012",
        stellarPublicKey: VALID_KEY,
        bondAmountXLM: 50,
      });

    expect(res.status).toBe(400);
    const msg = typeof res.body.error === "string" ? res.body.error : res.body.error?.message;
    expect(msg).toMatch(/Agent limit per Stellar account reached/i);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
//  Issue #646 — the schema DDL must not run on the request path
// ─────────────────────────────────────────────────────────────────────────────

describe("GET /api/agents — schema DDL (issue #646)", () => {
  it("issues zero DDL across a loop of requests and reuses one wrapper", async () => {
    const raw = makeDb();
    const execSpy = jest.spyOn(raw, "exec");
    const prepareSpy = jest.spyOn(raw, "prepare");
    const getAgentDbSpy = jest.spyOn(agentsDb, "getAgentDb").mockReturnValue(raw);

    // No `options.db` here: this exercises the real per-request
    // `getDb()` path, which is the one the issue is about.
    const app = express();
    app.use(express.json());
    app.use("/api/agents", createAgentsRouter());
    app.use(errorHandler);

    const wrapper = agentsDb.createAgentDb(raw);

    try {
      for (let i = 0; i < 5; i += 1) {
        // `limit` is mandatory on the bounded list contract; the DDL guarantee
        // this test covers is about the request path, not about query parsing.
        const res = await request(app).get("/api/agents?limit=50");
        expect(res.status).toBe(200);
      }

      // Every request reached the database ...
      expect(prepareSpy).toHaveBeenCalled();
      // ... and none of them ran schema DDL.
      expect(execSpy).not.toHaveBeenCalled();
      const ddl = prepareSpy.mock.calls
        .map(([sql]) => String(sql))
        .filter((sql) => /^\s*(CREATE|ALTER|DROP)\b/i.test(sql));
      expect(ddl).toEqual([]);

      // The wrapper the loop reused is the same object callers get.
      expect(agentsDb.createAgentDb(raw)).toBe(wrapper);
    } finally {
      getAgentDbSpy.mockRestore();
    }
  });
});

// Cursor validation is exercised independently of the SQLite stub.
describe('GET /api/agents — bounded contract', () => {
  // Query strings the bounded contract must reject before touching the store.
  const invalidLimitQueries = [
    '',
    '?limit=0',
    '?limit=-1',
    '?limit=101',
    '?limit=1.5',
    '?limit=NaN',
    '?limit=Infinity',
  ];

  it.each(invalidLimitQueries)('rejects an unbounded or invalid request: %s', async (query) => {
      const db = createAgentDb(makeDb());
      const list = jest.spyOn(db, 'listCursor');
      const response = await request(buildApp(db)).get(`/api/agents${query}`);
      expect(response.status).toBe(400);
      expect(list).not.toHaveBeenCalled();
    });

  it('returns pagination metadata and preserves filters in next links', async () => {
    const db = createAgentDb(makeDb());
    const list = jest.spyOn(db, 'listCursor').mockReturnValue({ items: [], nextCursor: 'next-token' });
    const response = await request(buildApp(db)).get('/api/agents?limit=2&capability=research&status=online');
    expect(response.status).toBe(200);
    expect(list).toHaveBeenCalledWith({ limit: 2, capability: 'research', status: 'online' });
    expect(response.body.data.pagination).toEqual({ limit: 2, nextCursor: 'next-token', hasNextPage: true });
    const next = new URL(response.body._links.next, 'https://example.test');
    expect(next.searchParams.get('capability')).toBe('research');
    expect(next.searchParams.get('status')).toBe('online');
    expect(next.searchParams.get('cursor')).toBe('next-token');
  });

  it('rejects malformed cursors instead of silently restarting', async () => {
    const response = await request(buildApp(createAgentDb(makeDb())))
      .get('/api/agents?limit=20&cursor=invalid');
    expect(response.status).toBe(400);
  });
});

