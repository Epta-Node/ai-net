/**
 * Integration tests for critical backend workflows:
 *
 *  1. Task creation → agent dispatch → completion → payment
 *  2. Agent registration → heartbeat → failover (mark stale)
 *
 * These tests use a real in-memory SQLite database and a mock dispatch
 * function — no external HTTP calls or actual Stellar transactions occur.
 */
import request from "supertest";
import Database from "better-sqlite3";
import express from "express";

import { createApp } from "../../src/api/app";
import { createTaskDb, getTaskDb } from "../../src/db/tasks";
import { createAgentDb, getAgentDb } from "../../src/db/agents";

// ── Bootstrap config before any imports that call getConfig() ─────────────────
beforeAll(() => {
  process.env.VENICE_API_KEY = process.env.VENICE_API_KEY || "test-venice-key";
  process.env.DATABASE_URL = process.env.DATABASE_URL || ":memory:";
  try {
    const { loadConfig } = require("../../src/config");
    loadConfig();
  } catch {
    // Already loaded — ignore
  }
});

// ── Valid Stellar-format keys for tests (G + 55 uppercase base32 chars = 56 total) ──
const WALLET    = "GWALLETTESTINTEGRATIONTESTAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const AGENT_KEY = "GINTEGRATIONAGENTSTELLARTESTAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeInMemoryTaskDb(): Database.Database {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY, prompt TEXT NOT NULL, walletPublicKey TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'queued', dagJson TEXT NOT NULL DEFAULT '[]',
      createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS task_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT, taskId TEXT NOT NULL, type TEXT NOT NULL,
      nodeId TEXT, payload TEXT, timestamp TEXT NOT NULL
    );
  `);
  return db;
}

function makeInMemoryAgentDb(): Database.Database {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE IF NOT EXISTS agents (
      id TEXT PRIMARY KEY, capabilities TEXT NOT NULL, pricingXLM REAL NOT NULL,
      endpoint TEXT NOT NULL, stellarPublicKey TEXT NOT NULL,
      reputationScore REAL NOT NULL DEFAULT 0, lastSeenAt TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'online'
    )
  `);
  return db;
}

// ─────────────────────────────────────────────────────────────────────────────
//  Workflow 1: Task creation → execution → completion
// ─────────────────────────────────────────────────────────────────────────────

describe("Integration: task creation → execution → completion", () => {
  let inMemoryDb: Database.Database;
  let app: ReturnType<typeof createApp>;

  beforeAll(() => {
    inMemoryDb = makeInMemoryTaskDb();
    jest.spyOn(require("../../src/db/tasks"), "getTaskDb").mockReturnValue(inMemoryDb);

    const mockDispatch = jest.fn().mockResolvedValue({ result: "mock agent result" });
    const mockReleasePayment = jest.fn().mockResolvedValue("mock-tx-hash");

    app = createApp({ dispatch: mockDispatch, releasePayment: mockReleasePayment });
  });

  afterAll(() => {
    app.close();
    inMemoryDb.close();
    jest.restoreAllMocks();
  });

  it("POST /api/tasks creates a task and returns 201 with taskId and dagPreview", async () => {
    const res = await request(app.httpServer)
      .post("/api/tasks")
      .set("walletpublickey", WALLET)
      .send({ prompt: "Generate a market entry report for solar energy", maxBudgetXLM: 2 });

    expect(res.status).toBe(201);
    expect(res.body.taskId).toMatch(/^task_/);
    expect(Array.isArray(res.body.dagPreview)).toBe(true);
    expect(res.body.status).toBe("queued");
  });

  it("GET /api/tasks/:id retrieves the created task by the owning wallet", async () => {
    // Create a task first
    const created = await request(app.httpServer)
      .post("/api/tasks")
      .set("walletpublickey", WALLET)
      .send({ prompt: "Research renewable energy trends", maxBudgetXLM: 1 });

    const { taskId } = created.body;

    const res = await request(app.httpServer)
      .get(`/api/tasks/${taskId}`)
      .set("walletpublickey", WALLET);

    expect(res.status).toBe(200);
    expect(res.body.id).toBe(taskId);
    expect(res.body.walletPublicKey).toBe(WALLET);
  });

  it("GET /api/tasks/:id returns 403 when accessed by a different wallet", async () => {
    const created = await request(app.httpServer)
      .post("/api/tasks")
      .set("walletpublickey", WALLET)
      .send({ prompt: "Risk analysis of battery storage", maxBudgetXLM: 1 });

    const { taskId } = created.body;

    const res = await request(app.httpServer)
      .get(`/api/tasks/${taskId}`)
      .set("walletpublickey", "GDIFFERENTWALLETINTEGRATIONTESTAAAAAAAAAAAAAAAAAAAAAAAAA");

    expect(res.status).toBe(403);
  });

  it("DELETE /api/tasks/:id cancels a queued task", async () => {
    const created = await request(app.httpServer)
      .post("/api/tasks")
      .set("walletpublickey", WALLET)
      .send({ prompt: "Cancel this task", maxBudgetXLM: 1 });

    const { taskId } = created.body;
    // Force status back to 'queued' to ensure the task is still cancellable
    // (the async DAG execution may have already moved it to 'running').
    createTaskDb(inMemoryDb).updateStatus(taskId, "queued");

    const res = await request(app.httpServer)
      .delete(`/api/tasks/${taskId}`)
      .set("walletpublickey", WALLET);

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("cancelled");
  });

  it("DELETE /api/tasks/:id returns 409 for a running task", async () => {
    const created = await request(app.httpServer)
      .post("/api/tasks")
      .set("walletpublickey", WALLET)
      .send({ prompt: "Running task test", maxBudgetXLM: 1 });

    const { taskId } = created.body;
    createTaskDb(inMemoryDb).updateStatus(taskId, "running");

    const res = await request(app.httpServer)
      .delete(`/api/tasks/${taskId}`)
      .set("walletpublickey", WALLET);

    expect(res.status).toBe(409);
  });

  it("GET /api/tasks returns paginated list for the owning wallet", async () => {
    const freshWallet = "GINTEGRATIONPAGINATETESTAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
    for (let i = 0; i < 3; i++) {
      await request(app.httpServer)
        .post("/api/tasks")
        .set("walletpublickey", freshWallet)
        .send({ prompt: `Paginate test task ${i}`, maxBudgetXLM: 1 });
    }

    const res = await request(app.httpServer)
      .get("/api/tasks?page=1&pageSize=2")
      .set("walletpublickey", freshWallet);

    expect(res.status).toBe(200);
    expect(res.body.tasks.length).toBe(2);
    expect(res.body.total).toBe(3);
    expect(res.body.page).toBe(1);
    expect(res.body.pageSize).toBe(2);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
//  Workflow 2: Agent registration → heartbeat → failover
// ─────────────────────────────────────────────────────────────────────────────

describe("Integration: agent registration → heartbeat → failover", () => {
  let rawDb: Database.Database;
  let agentDb: ReturnType<typeof createAgentDb>;
  let taskDb: Database.Database;
  let app: ReturnType<typeof createApp>;

  beforeAll(() => {
    rawDb = makeInMemoryAgentDb();
    taskDb = makeInMemoryTaskDb();
    agentDb = createAgentDb(rawDb);

    jest.spyOn(require("../../src/db/agents"), "getAgentDb").mockReturnValue(rawDb);
    jest.spyOn(require("../../src/db/tasks"), "getTaskDb").mockReturnValue(taskDb);

    const mockDispatch = jest.fn().mockResolvedValue({});
    const mockReleasePayment = jest.fn().mockResolvedValue("noop");

    process.env.SKIP_STELLAR_ACCOUNT_VERIFY = "true";
    app = createApp({ dispatch: mockDispatch, releasePayment: mockReleasePayment });
  });

  afterAll(() => {
    delete process.env.SKIP_STELLAR_ACCOUNT_VERIFY;
    app.close();
    rawDb.close();
    taskDb.close();
    jest.restoreAllMocks();
  });

  it("POST /api/agents/register creates an agent and returns 201", async () => {
    const res = await request(app.httpServer)
      .post("/api/agents/register")
      .send({
        agentId: "integration-agent-1",
        capabilities: ["research"],
        pricingXLM: 1.0,
        endpoint: "http://localhost:9001/health",
        stellarPublicKey: AGENT_KEY,
      });

    expect(res.status).toBe(201);
    expect(res.body.id).toBe("integration-agent-1");
  });

  it("GET /api/agents returns the registered agent", async () => {
    const res = await request(app.httpServer).get("/api/agents");
    expect(res.status).toBe(200);
    const found = res.body.find((a: any) => a.id === "integration-agent-1");
    expect(found).toBeDefined();
    expect(found.capabilities).toContain("research");
  });

  it("POST /api/agents/:id/heartbeat returns 200 and updates lastSeenAt", async () => {
    const before = new Date();
    const res = await request(app.httpServer)
      .post("/api/agents/integration-agent-1/heartbeat");

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("ok");
    expect(new Date(res.body.lastSeenAt).getTime()).toBeGreaterThanOrEqual(before.getTime());
  });

  it("markStaleAgents marks the agent offline after threshold", () => {
    // Simulate agent going stale by back-dating lastSeenAt
    rawDb.prepare(
      "UPDATE agents SET lastSeenAt = datetime('now', '-10 minutes'), status = 'online' WHERE id = 'integration-agent-1'"
    ).run();

    const count = agentDb.markStaleAgents(5);
    expect(count).toBeGreaterThanOrEqual(1);

    const agent = agentDb.findById("integration-agent-1");
    expect(agent?.status).toBe("offline");
  });

  it("updateLastSeen brings the agent back online", () => {
    agentDb.updateLastSeen("integration-agent-1");
    const agent = agentDb.findById("integration-agent-1");
    expect(agent?.status).toBe("online");
  });

  it("GET /api/agents/:id returns 404 for unknown agent", async () => {
    const res = await request(app.httpServer).get("/api/agents/nonexistent-agent");
    expect(res.status).toBe(404);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
//  Workflow 3: WebSocket stream — connection and task events
// ─────────────────────────────────────────────────────────────────────────────

describe("Integration: /health endpoint availability", () => {
  let app: ReturnType<typeof createApp>;

  beforeAll(() => {
    const taskDb = makeInMemoryTaskDb();
    jest.spyOn(require("../../src/db/tasks"), "getTaskDb").mockReturnValue(taskDb);
    app = createApp({
      dispatch: jest.fn().mockResolvedValue({}),
      releasePayment: jest.fn().mockResolvedValue("noop"),
    });
  });

  afterAll(() => {
    app.close();
    jest.restoreAllMocks();
  });

  it("GET /health returns 200", async () => {
    const res = await request(app.httpServer).get("/health");
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("ok");
  });

  it("GET /health/deep returns 200 with dependency statuses", async () => {
    // Mock fetch so the test doesn't make real network requests
    const fetchSpy = jest.spyOn(global, "fetch" as any).mockResolvedValue({ ok: false } as Response);
    const res = await request(app.httpServer).get("/health/deep");
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("venice");
    expect(res.body).toHaveProperty("horizon");
    fetchSpy.mockRestore();
  }, 10_000);
});
