/**
 * Registration payload validation at the API boundary (#754).
 *
 * Invalid payloads must be rejected with a 400 before anything reaches the
 * registry, so every negative case also asserts the store was never written.
 */
import express from "express";
import request from "supertest";
import type { AgentDb } from "../../db/agents";
import { createAgentsRouter } from "./agents";
import { errorHandler } from "../middleware/errorHandler";

const VALID_KEY = "GTESTAGENTSTELLARKEYAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

function validBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    agentId: "agent-1",
    capabilities: ["research", "coding"],
    pricingXLM: 1.5,
    endpoint: "https://agent.example/run",
    stellarPublicKey: VALID_KEY,
    ...overrides,
  };
}

function buildApp() {
  const upsert = jest.fn();
  const db = { upsert } as unknown as AgentDb;
  const app = express();
  app.use(express.json({ limit: "1mb" }));
  app.use("/api/agents", createAgentsRouter({ db }));
  app.use(errorHandler);
  return { app, upsert };
}

async function expectRejected(body: unknown) {
  const { app, upsert } = buildApp();
  const res = await request(app).post("/api/agents/register").send(body as object);
  expect(res.status).toBe(400);
  expect(res.body.error.code).toBe("VALIDATION_ERROR");
  expect(upsert).not.toHaveBeenCalled();
}

describe("POST /api/agents/register — payload validation (#754)", () => {
  beforeAll(() => {
    process.env.SKIP_STELLAR_ACCOUNT_VERIFY = "true";
  });

  it("lets a well-formed payload through validation to the ownership check", async () => {
    const { app, upsert } = buildApp();
    const res = await request(app).post("/api/agents/register").send(validBody());
    // Valid input is not a validation failure; it stops at the unsigned-request 401.
    expect(res.status).toBe(401);
    expect(upsert).not.toHaveBeenCalled();
  });

  describe("wrong types", () => {
    it.each([
      ["agentId is a number", { agentId: 42 }],
      ["capabilities is a string", { capabilities: "research" }],
      ["capabilities contains a non-string", { capabilities: ["research", 7] }],
      ["capabilities contains an object", { capabilities: [{ name: "research" }] }],
      ["pricingXLM is a string", { pricingXLM: "1.5" }],
      ["endpoint is not a string", { endpoint: { url: "https://agent.example" } }],
    ])("rejects when %s", async (_name, overrides) => {
      await expectRejected(validBody(overrides));
    });
  });

  describe("malformed values", () => {
    it.each([
      ["empty capabilities", { capabilities: [] }],
      ["empty capability string", { capabilities: [""] }],
      ["capability with spaces", { capabilities: ["deep research"] }],
      ["capability with markup", { capabilities: ["<script>"] }],
      ["duplicate capabilities", { capabilities: ["research", "research"] }],
      ["agent id with spaces", { agentId: "my agent" }],
      ["agent id with path characters", { agentId: "../agent" }],
      ["empty agent id", { agentId: "" }],
      ["non-url endpoint", { endpoint: "not-a-url" }],
      ["non-http endpoint", { endpoint: "javascript:alert(1)" }],
      ["file endpoint", { endpoint: "file:///etc/passwd" }],
      ["price below minimum", { pricingXLM: 0 }],
      ["malformed stellar key", { stellarPublicKey: "GSHORT" }],
    ])("rejects %s", async (_name, overrides) => {
      await expectRejected(validBody(overrides));
    });
  });

  describe("oversized payloads", () => {
    it("rejects an agent id over 64 characters", async () => {
      await expectRejected(validBody({ agentId: "a".repeat(65) }));
    });

    it("rejects a capability over 64 characters", async () => {
      await expectRejected(validBody({ capabilities: ["c".repeat(65)] }));
    });

    it("rejects more than 32 capabilities", async () => {
      const capabilities = Array.from({ length: 33 }, (_v, i) => `cap-${i}`);
      await expectRejected(validBody({ capabilities }));
    });

    it("rejects an endpoint over 2048 characters", async () => {
      await expectRejected(validBody({ endpoint: `https://agent.example/${"p".repeat(2048)}` }));
    });
  });

  describe("unknown fields", () => {
    it("rejects an unexpected top-level field", async () => {
      await expectRejected(validBody({ isAdmin: true }));
    });
  });

  it("reports the offending fields in the error details", async () => {
    const { app } = buildApp();
    const res = await request(app)
      .post("/api/agents/register")
      .send(validBody({ capabilities: ["bad cap"], extra: true }));
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body.error.details)).toContain("capabilities");
  });
});
