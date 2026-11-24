import express, { Request, Response, NextFunction } from "express";
import type { AddressInfo } from "net";
import request from "supertest";
import { Keypair } from "@stellar/stellar-sdk";
import { createAgentsRouter } from "../src/api/routes/agents";
import { createTasksRouter } from "../src/api/routes/tasks";
import { AgentRecord, createAgentDb, ensureAgentTable } from "../src/db/agents";
import Database from "better-sqlite3";
import { AppError } from "../src/errors";
import {
  AGENT_CHALLENGE_HEADER,
  AGENT_SIGNATURE_HEADER,
  AgentAuthPurpose,
  buildAgentAuthMessage,
  hashAgentPayload,
  issueAgentChallenge,
} from "../src/api/agentSignature";

/**
 * Complete the challenge/response handshake the way a real agent would, so a
 * test that is not about auth still exercises an authenticated request.
 */
function signedAuthHeaders(
  payload: unknown,
  publicKey: string,
  secret: string,
  purpose: AgentAuthPurpose,
  agentId?: string
): Record<string, string> {
  const challenge = issueAgentChallenge({ purpose, publicKey, payload, agentId });
  const message = buildAgentAuthMessage({
    purpose,
    publicKey,
    challenge: challenge.challenge,
    payloadHash: hashAgentPayload(payload),
  });

  return {
    [AGENT_CHALLENGE_HEADER]: challenge.challenge,
    [AGENT_SIGNATURE_HEADER]: Keypair.fromSecret(secret).sign(Buffer.from(message, "utf8")).toString("base64"),
  };
}

// Synthetic secret: the stellar-sdk mock derives a deterministic Ed25519 key
// from any string, so this is never real key material.
const AGENT_SECRET = "SYNTHETIC_TEST_SECRET_DO_NOT_USE_000001";
const agentKeypair = Keypair.fromSecret(AGENT_SECRET);

const codingAgent: AgentRecord = {
  id: "coding-1",
  capabilities: ["coding"],
  pricingXLM: 2.5,
  endpoint: "http://127.0.0.1:3001/health",
  stellarPublicKey: agentKeypair.publicKey(),
  reputationScore: 0,
  lastSeenAt: new Date().toISOString(),
  status: "online"
};

function testErrorHandler(err: Error, _req: Request, res: Response, _next: NextFunction): void {
  if (err instanceof AppError) {
    const body: Record<string, unknown> = {
      error: { code: err.code, message: err.message },
    };
    if (err.details !== undefined) {
      (body.error as Record<string, unknown>).details = err.details;
    }
    res.status(err.statusCode).json(body);
    return;
  }
  res.status(500).json({ error: { code: "INTERNAL_ERROR", message: err.message } });
}

function createTestApp(initialAgents: AgentRecord[] = [], healthTimeoutMs = 500) {
  const rawDb = new Database(":memory:");
  ensureAgentTable(rawDb);
  const db = createAgentDb(rawDb);
  for (const agent of initialAgents) {
    db.upsert(agent);
  }
  const app = express();
  app.use(express.json());
  app.use("/api/agents", createAgentsRouter({ db, healthTimeoutMs }));
  app.use(testErrorHandler);
  return app;
}

function listen(app: express.Express) {
  const server = app.listen(0);
  const address = server.address() as AddressInfo;

  return {
    server,
    url: `http://127.0.0.1:${address.port}`,
  };
}

describe("Agents API route", () => {
  it("returns 200 with an empty array when no agents are registered", async () => {
    const response = await request(createTestApp()).get("/api/agents?limit=100");

    expect(response.status).toBe(200);
    expect(response.body.data.items).toEqual([]);
  });

  it("returns a bounded page from the local registry cache", async () => {
    const response = await request(createTestApp([codingAgent])).get("/api/agents?limit=100");

    expect(response.status).toBe(200);
    expect(response.body.data.items).toEqual([expect.objectContaining(codingAgent)]);
  });

  it("returns a single agent by id", async () => {
    const response = await request(createTestApp([codingAgent])).get("/api/agents/coding-1");

    expect(response.status).toBe(200);
    expect(response.body).toEqual(expect.objectContaining({ ...codingAgent, reputation: expect.any(Object) }));
  });

  it("returns 404 for an unknown agent id", async () => {
    const response = await request(createTestApp()).get("/api/agents/missing");

    expect(response.status).toBe(404);
    expect(response.body).toEqual({ error: { code: "NOT_FOUND", message: "Agent not found" } });
  });

  it("returns healthy status and latency for a reachable agent endpoint", async () => {
    const healthApp = express();
    healthApp.get("/health", (_req, res) => res.status(200).json({ ok: true }));
    const healthServer = listen(healthApp);

    try {
      const response = await request(createTestApp([{
        ...codingAgent,
        endpoint: `${healthServer.url}/health`,
      }])).get("/api/agents/coding-1/health");

      expect(response.status).toBe(200);
      expect(response.body.status).toBe("healthy");
      expect(response.body.latencyMs).toEqual(expect.any(Number));
    } finally {
      healthServer.server.close();
    }
  });

  it("returns unreachable status when an agent endpoint times out", async () => {
    const slowApp = express();
    slowApp.get("/health", (_req, res) => {
      setTimeout(() => res.status(200).json({ ok: true }), 100);
    });
    const slowServer = listen(slowApp);

    try {
      const response = await request(createTestApp([{
        ...codingAgent,
        endpoint: `${slowServer.url}/health`,
      }], 10)).get("/api/agents/coding-1/health");

      expect(response.status).toBe(200);
      expect(response.body.status).toBe("unreachable");
      expect(response.body.latencyMs).toEqual(expect.any(Number));
    } finally {
      slowServer.server.close();
    }
  });

  it("returns 404 when checking health for an unknown agent", async () => {
    const response = await request(createTestApp()).get("/api/agents/missing/health");

    expect(response.status).toBe(404);
    expect(response.body).toEqual({ error: { code: "NOT_FOUND", message: "Agent not found" } });
  });

  it("returns 200 and updates lastSeenAt on heartbeat", async () => {
    const app = createTestApp([codingAgent]);
    // SQLite's datetime('now') has second precision, so floor the baseline.
    const before = new Date(Math.floor(Date.now() / 1000) * 1000);
    const auth = signedAuthHeaders(undefined, agentKeypair.publicKey(), AGENT_SECRET, "heartbeat", "coding-1");

    const response = await request(app)
      .post("/api/agents/coding-1/heartbeat")
      .set(auth);

    expect(response.status).toBe(200);
    expect(response.body.status).toBe("ok");
    expect(new Date(response.body.lastSeenAt).getTime()).toBeGreaterThanOrEqual(before.getTime());
    const updated = await request(app).get("/api/agents/coding-1");
    expect(new Date(updated.body.lastSeenAt).getTime()).toBeGreaterThanOrEqual(before.getTime());
    expect(updated.body.status).toBe("online");
  });

  it("returns 404 when sending heartbeat to an unknown agent", async () => {
    const auth = signedAuthHeaders(undefined, agentKeypair.publicKey(), AGENT_SECRET, "heartbeat", "missing");

    const response = await request(createTestApp())
      .post("/api/agents/missing/heartbeat")
      .set(auth);

    expect(response.status).toBe(404);
    expect(response.body).toEqual({ error: { code: "NOT_FOUND", message: "Agent not found" } });
  });
});

describe("Stellar public key validation", () => {
  const VALID_KEY = "GB3W5IYBKWGAZ277DJEEG5H635MUUGBTFPUTF7R2N5IJYP36AY2H2CUZ";
  const VALID_SECRET = "SYNTHETIC_TEST_SECRET_DO_NOT_USE_000002";

  beforeAll(() => {
    process.env.SKIP_STELLAR_ACCOUNT_VERIFY = "true";
  });

  afterAll(() => {
    delete process.env.SKIP_STELLAR_ACCOUNT_VERIFY;
  });

  describe("Agent registration", () => {
    it("returns 400 for key missing the G prefix", async () => {
      const response = await request(createTestApp()).post("/api/agents/register").send({
        agentId: "test-agent",
        capabilities: ["coding"],
        pricingXLM: 1,
        endpoint: "http://localhost:3001/health",
        stellarPublicKey: "AAXXWKCA5VLDNRLN3RPRJMRZOX3Z6G5CHCGDG6NXGPTVMLHK4HZ7HHN",
      });

      expect(response.status).toBe(400);
    });

    it("returns 400 for key shorter than 56 characters", async () => {
      const response = await request(createTestApp()).post("/api/agents/register").send({
        agentId: "test-agent",
        capabilities: ["coding"],
        pricingXLM: 1,
        endpoint: "http://localhost:3001/health",
        stellarPublicKey: "GCEZWKCA5VLDNRLN3RPRJMRZOX3Z6G5CHCG",
      });

      expect(response.status).toBe(400);
    });

    it("returns 400 for negative pricingXLM", async () => {
      const response = await request(createTestApp()).post("/api/agents/register").send({
        agentId: "test-agent",
        capabilities: ["coding"],
        pricingXLM: -1,
        endpoint: "http://localhost:3001/health",
        stellarPublicKey: VALID_KEY,
      });

      expect(response.status).toBe(400);
    });

    it("returns 400 for zero pricingXLM", async () => {
      const response = await request(createTestApp()).post("/api/agents/register").send({
        agentId: "test-agent",
        capabilities: ["coding"],
        pricingXLM: 0,
        endpoint: "http://localhost:3001/health",
        stellarPublicKey: VALID_KEY,
      });

      expect(response.status).toBe(400);
    });

    it("returns 201 for valid Stellar public key", async () => {
      const keypair = Keypair.fromSecret(VALID_SECRET);
      const body = {
        agentId: "test-agent",
        capabilities: ["coding"],
        pricingXLM: 1,
        endpoint: "http://localhost:3001/health",
        stellarPublicKey: keypair.publicKey(),
      };
      const auth = await signedAuthHeaders(body, keypair.publicKey(), VALID_SECRET, "register");

      const response = await request(createTestApp())
        .post("/api/agents/register")
        .set(auth)
        .send(body);

      expect(response.status).toBe(201);
      expect(response.body.stellarPublicKey).toBe(keypair.publicKey());
    });
  });

  describe("Task creation", () => {
    function createTaskTestApp() {
      const app = express();
      app.use(express.json());
      const mockDispatch = jest.fn().mockResolvedValue({});
      const mockReleasePayment = jest.fn().mockResolvedValue(undefined);
      app.use("/api/tasks", createTasksRouter(mockDispatch, mockReleasePayment));
      return app;
    }

    it("creates the task with an unvalidated walletpublickey header value", async () => {
      const response = await request(createTaskTestApp())
        .post("/api/tasks")
        .set("walletpublickey", "INVALID-KEY-123")
        .send({ prompt: "Do something", maxBudgetXLM: 1 });

      expect(response.status).toBe(201);
      expect(response.body.status).toBe("queued");
      expect(response.body.taskId).toBeDefined();
    });

    it("creates the task with an anonymous wallet when the header is missing", async () => {
      const response = await request(createTaskTestApp())
        .post("/api/tasks")
        .send({ prompt: "Do something", maxBudgetXLM: 1 });

      expect(response.status).toBe(201);
      expect(response.body.status).toBe("queued");
      expect(response.body.taskId).toBeDefined();
    });
  });
});