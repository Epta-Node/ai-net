/**
 * Agent ownership proof on the agent-mutating routes (#557, #558).
 *
 * Every negative case here drives *real* Ed25519 verification: the test signs
 * with a keypair from the (deterministic) stellar-sdk mock and the server
 * verifies with `Keypair.fromPublicKey()`. Nothing about `verify()` is stubbed,
 * so a test passing here is evidence the signature check actually works.
 */
import express from "express";
import request from "supertest";
import { Keypair } from "@stellar/stellar-sdk";
import type { AgentDb, AgentRecord } from "../../db/agents";
import { createAgentsRouter } from "./agents";
import { errorHandler } from "../middleware/errorHandler";
import {
  resetAgentChallenges,
  buildAgentAuthMessage,
  hashAgentPayload,
} from "../agentSignature";
import { resetAuthFailures } from "../middleware/rateLimit";
import { resetConfigForTests } from "../../config";
import {
  setFlag,
  clearRuntimeOverrides,
  getAllFlags,
  isEnabled,
} from "../../services/featureFlags";

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Map-backed AgentDb.
 *
 * The default jest project stubs `better-sqlite3` (no Windows prebuild), so the
 * real store would silently persist nothing and every "lastSeenAt must not
 * move" assertion would pass vacuously. Only the surface the agents router
 * touches is implemented.
 */
function makeDb(): AgentDb {
  const rows = new Map<string, AgentRecord>();
  return {
    upsert(agent) {
      rows.set(agent.id, { ...rows.get(agent.id), ...agent });
    },
    findById(id) {
      return rows.get(id);
    },
    list() {
      return [...rows.values()];
    },
    listCursor() {
      const items = [...rows.values()];
      return { items, nextCursor: undefined };
    },
    delete(id) {
      rows.delete(id);
    },
    updateReputation() {},
    updateReputationWithStats() {},
    countByStellarKey(key) {
      return [...rows.values()].filter((r) => r.stellarPublicKey === key)
        .length;
    },
    markAllOffline() {},
    updateLastSeen() {},
    markStaleAgents() {
      return 0;
    },
    deleteOfflineAgents() {
      return 0;
    },

    // ── Heartbeat watchdog (Issue #379) ──────────────────────────────────────
    // The ownership tests never exercise the watchdog, so these only need to
    // satisfy the interface without side effects.
    markStale() {},
    clearStale() {},
    getStaleSince() {
      return null;
    },
    listStaleAgents() {
      return [];
    },
    recordAlert() {
      return "alert-1";
    },
    listAlerts() {
      return [];
    },
  };
}

function buildApp(db: AgentDb) {
  const app = express();
  app.use(express.json());
  app.use("/api/agents", createAgentsRouter({ db }));
  app.use(errorHandler);
  return app;
}

function seedAgent(db: AgentDb, id: string, stellarPublicKey: string): void {
  db.upsert({
    id,
    capabilities: ["research"],
    pricingXLM: 1,
    endpoint: "http://localhost:9001",
    stellarPublicKey,
    reputationScore: 2.5,
    lastSeenAt: new Date().toISOString(),
    status: "online",
  });
}

// ── Fixtures ─────────────────────────────────────────────────────────────────

const OWNER_SECRET = "SAGENT_OWNER_SECRET_FIXTURE_0001";
const ATTACKER_SECRET = "SATTACKER_SECRET_FIXTURE_00002";
const OWNER = Keypair.fromSecret(OWNER_SECRET);
const ATTACKER = Keypair.fromSecret(ATTACKER_SECRET);
const OWNER_KEY = OWNER.publicKey();
const ATTACKER_KEY = ATTACKER.publicKey();

const REGISTER_BODY = {
  agentId: "auth-agent-1",
  capabilities: ["research"],
  pricingXLM: 0.5,
  endpoint: "http://localhost:9001",
  stellarPublicKey: OWNER_KEY,
};

function sign(
  payload: unknown,
  purpose: "register" | "heartbeat" | "delete",
  challenge: string,
) {
  const message = buildAgentAuthMessage({
    purpose,
    publicKey: OWNER_KEY,
    challenge,
    payloadHash: hashAgentPayload(payload),
  });
  return OWNER.sign(Buffer.from(message, "utf8")).toString("base64");
}

/** Request a challenge over HTTP so the tests exercise the real issuance path. */
async function challenge(
  app: ReturnType<typeof buildApp>,
  body: Record<string, unknown>,
): Promise<{ status: number; challenge?: string; message?: string }> {
  const res = await request(app).post("/api/agents/challenge").send(body);
  return {
    status: res.status,
    challenge: res.body.challenge,
    message: res.body.message,
  };
}

function errorCode(res: { body: Record<string, unknown> }): string | undefined {
  const error = res.body.error;
  if (error && typeof error === "object")
    return (error as { code?: string }).code;
  return undefined;
}

// ─────────────────────────────────────────────────────────────────────────────

beforeAll(() => {
  process.env.SKIP_STELLAR_ACCOUNT_VERIFY = "true";
});

beforeEach(() => {
  // The expiry test narrows the TTL; clear it so a 1 ms window does not leak
  // into every later test in this file.
  delete process.env.AGENT_CHALLENGE_TTL_MS;
  delete process.env.AGENT_AUTH_FAILURE_LIMIT_MAX;
  delete process.env.AGENT_AUTH_SUNSET_DATE;
  resetAgentChallenges();
  resetAuthFailures();
  clearRuntimeOverrides();
  resetConfigForTests();
});

afterAll(() => {
  delete process.env.SKIP_STELLAR_ACCOUNT_VERIFY;
  delete process.env.AGENT_CHALLENGE_TTL_MS;
  resetConfigForTests();
  clearRuntimeOverrides();
});

// ─────────────────────────────────────────────────────────────────────────────
//  POST /api/agents/challenge
// ─────────────────────────────────────────────────────────────────────────────

describe("POST /api/agents/challenge", () => {
  it("returns a message the agent can sign", async () => {
    const app = buildApp(makeDb());
    const res = await request(app)
      .post("/api/agents/challenge")
      .send({
        purpose: "register",
        publicKey: OWNER_KEY,
        payload: REGISTER_BODY,
      });

    expect(res.status).toBe(200);
    expect(typeof res.body.challenge).toBe("string");
    expect(typeof res.body.message).toBe("string");
    expect(res.body.message).toContain("register");
    expect(new Date(res.body.expiresAt).getTime()).toBeGreaterThan(Date.now());
  });

  it("rejects a malformed public key", async () => {
    const app = buildApp(makeDb());
    const res = await request(app)
      .post("/api/agents/challenge")
      .send({
        purpose: "register",
        publicKey: "not-a-stellar-key",
        payload: REGISTER_BODY,
      });

    expect(res.status).toBe(400);
  });

  it("requires an agentId for the heartbeat and delete purposes", async () => {
    const app = buildApp(makeDb());
    const res = await request(app)
      .post("/api/agents/challenge")
      .send({
        purpose: "heartbeat",
        publicKey: OWNER_KEY,
        payload: { agentId: "x" },
      });

    // agentId missing from the request body entirely.
    expect(res.status).toBe(400);

    const noAgentId = await request(app)
      .post("/api/agents/challenge")
      .send({ purpose: "heartbeat", publicKey: OWNER_KEY, payload: {} });
    expect(noAgentId.status).toBe(400);
  });

  it("rejects an unknown purpose", async () => {
    const app = buildApp(makeDb());
    const res = await request(app)
      .post("/api/agents/challenge")
      .send({ purpose: "drain-wallet", publicKey: OWNER_KEY, payload: {} });

    expect(res.status).toBe(400);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
//  POST /api/agents/register — Issue #557
// ─────────────────────────────────────────────────────────────────────────────

describe("POST /api/agents/register — ownership proof (#557)", () => {
  it("accepts a registration signed by the claimed key", async () => {
    const db = makeDb();
    const app = buildApp(db);

    const issued = await challenge(app, {
      purpose: "register",
      publicKey: OWNER_KEY,
      payload: REGISTER_BODY,
    });
    const signature = sign(REGISTER_BODY, "register", issued.challenge!);

    const res = await request(app)
      .post("/api/agents/register")
      .set("x-challenge", issued.challenge!)
      .set("x-signature", signature)
      .send(REGISTER_BODY);

    expect(res.status).toBe(201);
    expect(res.body.stellarPublicKey).toBe(OWNER_KEY);
    expect(db.findById("auth-agent-1")).toBeDefined();
  });

  it("rejects an unsigned registration", async () => {
    const db = makeDb();
    const app = buildApp(db);

    const res = await request(app)
      .post("/api/agents/register")
      .send(REGISTER_BODY);

    expect(res.status).toBe(401);
    expect(errorCode(res)).toBe("AGENT_CHALLENGE_INVALID");
    expect(db.findById("auth-agent-1")).toBeUndefined();
  });

  it("rejects a signature made with a different key (#557 payment redirection)", async () => {
    const db = makeDb();
    const app = buildApp(db);

    // Attacker knows the victim's public key, requests a challenge for it, and
    // signs with their own key. The agent must not be created.
    const issued = await challenge(app, {
      purpose: "register",
      publicKey: OWNER_KEY,
      payload: REGISTER_BODY,
    });
    const attackerMessage = buildAgentAuthMessage({
      purpose: "register",
      publicKey: OWNER_KEY,
      challenge: issued.challenge!,
      payloadHash: hashAgentPayload(REGISTER_BODY),
    });
    const forged = ATTACKER.sign(Buffer.from(attackerMessage, "utf8")).toString(
      "base64",
    );

    const res = await request(app)
      .post("/api/agents/register")
      .set("x-challenge", issued.challenge!)
      .set("x-signature", forged)
      .send(REGISTER_BODY);

    expect(res.status).toBe(401);
    expect(errorCode(res)).toBe("AGENT_SIGNATURE_INVALID");
    expect(db.findById("auth-agent-1")).toBeUndefined();
  });

  it("rejects a signature over a different registration payload", async () => {
    const db = makeDb();
    const app = buildApp(db);

    // The challenge — and therefore the signature — covers a cheaper price
    // than the body the agent actually submits.
    const tampered = { ...REGISTER_BODY, pricingXLM: 0.01 };
    const issued = await challenge(app, {
      purpose: "register",
      publicKey: OWNER_KEY,
      payload: tampered,
    });
    const signature = sign(tampered, "register", issued.challenge!);

    const res = await request(app)
      .post("/api/agents/register")
      .set("x-challenge", issued.challenge!)
      .set("x-signature", signature)
      .send(REGISTER_BODY);

    expect(res.status).toBe(401);
    expect(errorCode(res)).toBe("AGENT_CHALLENGE_INVALID");
    expect(db.findById("auth-agent-1")).toBeUndefined();
  });

  it("rejects a replayed challenge", async () => {
    const db = makeDb();
    const app = buildApp(db);

    const issued = await challenge(app, {
      purpose: "register",
      publicKey: OWNER_KEY,
      payload: REGISTER_BODY,
    });
    const signature = sign(REGISTER_BODY, "register", issued.challenge!);

    const first = await request(app)
      .post("/api/agents/register")
      .set("x-challenge", issued.challenge!)
      .set("x-signature", signature)
      .send(REGISTER_BODY);
    expect(first.status).toBe(201);

    const replay = await request(app)
      .post("/api/agents/register")
      .set("x-challenge", issued.challenge!)
      .set("x-signature", signature)
      .send(REGISTER_BODY);
    expect(replay.status).toBe(401);
    expect(errorCode(replay)).toBe("AGENT_CHALLENGE_INVALID");
  });

  it("rejects an expired challenge", async () => {
    process.env.AGENT_CHALLENGE_TTL_MS = "1";
    resetConfigForTests();

    const db = makeDb();
    const app = buildApp(db);

    const issued = await challenge(app, {
      purpose: "register",
      publicKey: OWNER_KEY,
      payload: REGISTER_BODY,
    });
    const signature = sign(REGISTER_BODY, "register", issued.challenge!);

    await new Promise((resolve) => setTimeout(resolve, 20));

    const res = await request(app)
      .post("/api/agents/register")
      .set("x-challenge", issued.challenge!)
      .set("x-signature", signature)
      .send(REGISTER_BODY);

    expect(res.status).toBe(401);
    expect(errorCode(res)).toBe("AGENT_CHALLENGE_INVALID");
    expect(db.findById("auth-agent-1")).toBeUndefined();
  });

  it("rejects a challenge that was never issued by the server", async () => {
    const db = makeDb();
    const app = buildApp(db);

    const res = await request(app)
      .post("/api/agents/register")
      .set("x-challenge", "client-invented-nonce")
      .set(
        "x-signature",
        sign(REGISTER_BODY, "register", "client-invented-nonce"),
      )
      .send(REGISTER_BODY);

    expect(res.status).toBe(401);
    expect(errorCode(res)).toBe("AGENT_CHALLENGE_INVALID");
  });

  it("rejects a malformed signature encoding", async () => {
    const db = makeDb();
    const app = buildApp(db);

    const issued = await challenge(app, {
      purpose: "register",
      publicKey: OWNER_KEY,
      payload: REGISTER_BODY,
    });

    const res = await request(app)
      .post("/api/agents/register")
      .set("x-challenge", issued.challenge!)
      .set("x-signature", "!!!not base64!!!")
      .send(REGISTER_BODY);

    expect(res.status).toBe(401);
    expect(errorCode(res)).toBe("AGENT_SIGNATURE_INVALID");
  });

  it("refuses a register challenge replayed against the heartbeat route", async () => {
    const db = makeDb();
    seedAgent(db, "auth-agent-1", OWNER_KEY);
    const app = buildApp(db);

    const issued = await challenge(app, {
      purpose: "register",
      publicKey: OWNER_KEY,
      payload: REGISTER_BODY,
    });
    const signature = sign(REGISTER_BODY, "register", issued.challenge!);

    const res = await request(app)
      .post("/api/agents/auth-agent-1/heartbeat")
      .set("x-challenge", issued.challenge!)
      .set("x-signature", signature)
      .send();

    expect(res.status).toBe(401);
    expect(errorCode(res)).toBe("AGENT_CHALLENGE_INVALID");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
//  POST /api/agents/:id/heartbeat — Issue #558
// ─────────────────────────────────────────────────────────────────────────────

describe("POST /api/agents/:id/heartbeat — ownership proof (#558)", () => {
  async function signedHeartbeat(
    app: ReturnType<typeof buildApp>,
    agentId: string,
    opts: {
      keypair?: { publicKey: () => string; sign: (d: Buffer) => Buffer };
      claimKey?: string;
    } = {},
  ) {
    const signer = opts.keypair ?? OWNER;
    const claimKey = opts.claimKey ?? OWNER_KEY;
    const issued = await challenge(app, {
      purpose: "heartbeat",
      publicKey: claimKey,
      agentId,
      payload: { agentId },
    });
    const message = buildAgentAuthMessage({
      purpose: "heartbeat",
      publicKey: claimKey,
      challenge: issued.challenge!,
      payloadHash: hashAgentPayload({ agentId }),
    });
    return {
      challenge: issued.challenge!,
      signature: signer.sign(Buffer.from(message, "utf8")).toString("base64"),
    };
  }

  it("accepts a heartbeat signed by the agent's own key", async () => {
    const db = makeDb();
    seedAgent(db, "hb-agent", OWNER_KEY);
    const app = buildApp(db);

    const { challenge: nonce, signature } = await signedHeartbeat(
      app,
      "hb-agent",
    );
    const res = await request(app)
      .post("/api/agents/hb-agent/heartbeat")
      .set("x-challenge", nonce)
      .set("x-signature", signature)
      .send();

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("ok");
    expect(db.findById("hb-agent")?.status).toBe("online");
  });

  it("rejects an unsigned heartbeat and does not update lastSeenAt (#558)", async () => {
    const db = makeDb();
    seedAgent(db, "hb-agent", OWNER_KEY);
    const staleSeenAt = "2020-01-01T00:00:00.000Z";
    db.upsert({
      ...db.findById("hb-agent")!,
      lastSeenAt: staleSeenAt,
      status: "offline",
    });
    const app = buildApp(db);

    const res = await request(app)
      .post("/api/agents/hb-agent/heartbeat")
      .send();

    expect(res.status).toBe(401);
    expect(errorCode(res)).toBe("AGENT_CHALLENGE_INVALID");
    const stored = db.findById("hb-agent");
    expect(stored?.lastSeenAt).toBe(staleSeenAt);
    expect(stored?.status).toBe("offline");
  });

  it("rejects a heartbeat signed by a different key and leaves the agent stale", async () => {
    const db = makeDb();
    seedAgent(db, "hb-agent", OWNER_KEY);
    const staleSeenAt = "2020-01-01T00:00:00.000Z";
    db.upsert({ ...db.findById("hb-agent")!, lastSeenAt: staleSeenAt });
    const app = buildApp(db);

    const { challenge: nonce, signature } = await signedHeartbeat(
      app,
      "hb-agent",
      {
        keypair: ATTACKER,
      },
    );
    const res = await request(app)
      .post("/api/agents/hb-agent/heartbeat")
      .set("x-challenge", nonce)
      .set("x-signature", signature)
      .send();

    expect(res.status).toBe(401);
    expect(errorCode(res)).toBe("AGENT_SIGNATURE_INVALID");
    expect(db.findById("hb-agent")?.lastSeenAt).toBe(staleSeenAt);
  });

  it("rejects a missing signature when a challenge is presented", async () => {
    const db = makeDb();
    seedAgent(db, "hb-agent", OWNER_KEY);
    const app = buildApp(db);

    const issued = await challenge(app, {
      purpose: "heartbeat",
      publicKey: OWNER_KEY,
      agentId: "hb-agent",
      payload: { agentId: "hb-agent" },
    });

    const res = await request(app)
      .post("/api/agents/hb-agent/heartbeat")
      .set("x-challenge", issued.challenge!)
      .send();

    expect(res.status).toBe(401);
    expect(errorCode(res)).toBe("AGENT_SIGNATURE_INVALID");
  });

  it("rejects a replayed heartbeat challenge", async () => {
    const db = makeDb();
    seedAgent(db, "hb-agent", OWNER_KEY);
    const app = buildApp(db);

    const { challenge: nonce, signature } = await signedHeartbeat(
      app,
      "hb-agent",
    );

    const first = await request(app)
      .post("/api/agents/hb-agent/heartbeat")
      .set("x-challenge", nonce)
      .set("x-signature", signature)
      .send();
    expect(first.status).toBe(200);

    const replay = await request(app)
      .post("/api/agents/hb-agent/heartbeat")
      .set("x-challenge", nonce)
      .set("x-signature", signature)
      .send();
    expect(replay.status).toBe(401);
    expect(errorCode(replay)).toBe("AGENT_CHALLENGE_INVALID");
  });

  it("returns 404 for a heartbeat against a nonexistent agent", async () => {
    const db = makeDb();
    const app = buildApp(db);

    const issued = await challenge(app, {
      purpose: "heartbeat",
      publicKey: OWNER_KEY,
      agentId: "ghost-agent",
      payload: { agentId: "ghost-agent" },
    });
    const message = buildAgentAuthMessage({
      purpose: "heartbeat",
      publicKey: OWNER_KEY,
      challenge: issued.challenge!,
      payloadHash: hashAgentPayload({ agentId: "ghost-agent" }),
    });
    const signature = OWNER.sign(Buffer.from(message, "utf8")).toString(
      "base64",
    );

    const res = await request(app)
      .post("/api/agents/ghost-agent/heartbeat")
      .set("x-challenge", issued.challenge!)
      .set("x-signature", signature)
      .send();

    expect(res.status).toBe(404);
  });

  it("rejects a heartbeat whose challenge was issued for another agent id", async () => {
    const db = makeDb();
    seedAgent(db, "hb-agent", OWNER_KEY);
    seedAgent(db, "other-agent", OWNER_KEY);
    const app = buildApp(db);

    const { challenge: nonce, signature } = await signedHeartbeat(
      app,
      "other-agent",
    );
    const res = await request(app)
      .post("/api/agents/hb-agent/heartbeat")
      .set("x-challenge", nonce)
      .set("x-signature", signature)
      .send();

    expect(res.status).toBe(401);
    expect(errorCode(res)).toBe("AGENT_CHALLENGE_INVALID");
  });

  it("rate-limits the failure path separately from the success path", async () => {
    process.env.AGENT_AUTH_FAILURE_LIMIT_MAX = "2";
    resetConfigForTests();

    const db = makeDb();
    seedAgent(db, "hb-agent", OWNER_KEY);
    const app = buildApp(db);

    // Two rejected attempts are served normally...
    for (let i = 0; i < 2; i++) {
      const attempt = await request(app)
        .post("/api/agents/hb-agent/heartbeat")
        .send();
      expect(attempt.status).toBe(401);
    }

    // ...the third is throttled before the agent is even consulted.
    const throttled = await request(app)
      .post("/api/agents/hb-agent/heartbeat")
      .send();
    expect(throttled.status).toBe(429);
    expect(throttled.headers["retry-after"]).toBeDefined();

    // A correctly signed heartbeat is not blocked by its own earlier failures.
    const { challenge: nonce, signature } = await signedHeartbeat(
      app,
      "hb-agent",
    );
    const signed = await request(app)
      .post("/api/agents/hb-agent/heartbeat")
      .set("x-challenge", nonce)
      .set("x-signature", signature)
      .send();
    expect(signed.status).toBe(200);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
//  DELETE /api/agents/:id — shared helper
// ─────────────────────────────────────────────────────────────────────────────

describe("DELETE /api/agents/:id — shares the register/heartbeat helper", () => {
  it("accepts a delete signed by the agent's own key", async () => {
    const db = makeDb();
    seedAgent(db, "del-agent", OWNER_KEY);
    const app = buildApp(db);

    const issued = await challenge(app, {
      purpose: "delete",
      publicKey: OWNER_KEY,
      agentId: "del-agent",
      payload: { agentId: "del-agent" },
    });
    const signature = sign(
      { agentId: "del-agent" },
      "delete",
      issued.challenge!,
    );

    const res = await request(app)
      .delete("/api/agents/del-agent")
      .set("x-challenge", issued.challenge!)
      .set("x-signature", signature);

    expect(res.status).toBe(200);
    expect(db.findById("del-agent")).toBeUndefined();
  });

  it("rejects a delete signed by a different key", async () => {
    const db = makeDb();
    seedAgent(db, "del-agent", OWNER_KEY);
    const app = buildApp(db);

    const issued = await challenge(app, {
      purpose: "delete",
      publicKey: OWNER_KEY,
      agentId: "del-agent",
      payload: { agentId: "del-agent" },
    });
    const message = buildAgentAuthMessage({
      purpose: "delete",
      publicKey: OWNER_KEY,
      challenge: issued.challenge!,
      payloadHash: hashAgentPayload({ agentId: "del-agent" }),
    });
    const forged = ATTACKER.sign(Buffer.from(message, "utf8")).toString(
      "base64",
    );

    const res = await request(app)
      .delete("/api/agents/del-agent")
      .set("x-challenge", issued.challenge!)
      .set("x-signature", forged);

    expect(res.status).toBe(401);
    expect(errorCode(res)).toBe("AGENT_SIGNATURE_INVALID");
    expect(db.findById("del-agent")).toBeDefined();
  });

  it("refuses an unsigned delete even under the migration flag (#557 payment redirection)", async () => {
    setFlag("agent_ownership_proof", false);
    const db = makeDb();
    seedAgent(db, "del-agent", OWNER_KEY);
    const app = buildApp(db);

    const res = await request(app).delete("/api/agents/del-agent");

    expect(res.status).toBe(401);
    expect(db.findById("del-agent")).toBeDefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
//  Migration window
// ─────────────────────────────────────────────────────────────────────────────

describe("Unsigned agent path during the migration window", () => {
  beforeEach(() => {
    setFlag("agent_ownership_proof", false);
    process.env.AGENT_AUTH_SUNSET_DATE = "2026-12-01";
    resetConfigForTests();
  });

  afterEach(() => {
    delete process.env.AGENT_AUTH_SUNSET_DATE;
  });

  it("accepts an unsigned heartbeat and advertises the sunset date", async () => {
    const db = makeDb();
    seedAgent(db, "hb-agent", OWNER_KEY);
    const app = buildApp(db);

    const res = await request(app)
      .post("/api/agents/hb-agent/heartbeat")
      .send();

    expect(res.status).toBe(200);
    expect(res.headers.deprecation).toBe("true");
    expect(res.headers.sunset).toBe("2026-12-01");
    expect(res.headers.warning).toContain("2026-12-01");
  });

  it("accepts an unsigned registration during the window", async () => {
    const db = makeDb();
    const app = buildApp(db);

    const res = await request(app)
      .post("/api/agents/register")
      .send(REGISTER_BODY);

    expect(res.status).toBe(201);
    expect(res.headers.deprecation).toBe("true");
  });

  it("still rejects a bad signature when the flag is off", async () => {
    const db = makeDb();
    seedAgent(db, "hb-agent", OWNER_KEY);
    const app = buildApp(db);

    const res = await request(app)
      .post("/api/agents/hb-agent/heartbeat")
      .set("x-challenge", "invented")
      .set("x-signature", "AAAA")
      .send();

    expect(res.status).toBe(401);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
//  Attacker cannot register under a key they do not control
// ─────────────────────────────────────────────────────────────────────────────

describe("Cross-key registration attempts", () => {
  it("does not let a signature transfer between keys", async () => {
    const db = makeDb();
    const app = buildApp(db);

    // Challenge legitimately issued for the attacker's own account...
    const issued = await challenge(app, {
      purpose: "register",
      publicKey: ATTACKER_KEY,
      payload: REGISTER_BODY,
    });

    // ...then the body claims the victim's key while the signature covers the
    // attacker's. Binding the challenge to the claimed key must reject it.
    const res = await request(app)
      .post("/api/agents/register")
      .set("x-challenge", issued.challenge!)
      .set(
        "x-signature",
        ATTACKER.sign(
          Buffer.from(
            buildAgentAuthMessage({
              purpose: "register",
              publicKey: ATTACKER_KEY,
              challenge: issued.challenge!,
              payloadHash: hashAgentPayload(REGISTER_BODY),
            }),
            "utf8",
          ),
        ).toString("base64"),
      )
      .send(REGISTER_BODY);

    expect(res.status).toBe(401);
    expect(db.findById("auth-agent-1")).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
//  The flag must fail closed
// ─────────────────────────────────────────────────────────────────────────────

describe("agent_ownership_proof flag", () => {
  afterEach(() => {
    clearRuntimeOverrides();
    delete process.env.FEATURE_AGENT_OWNERSHIP_PROOF;
  });

  it("is enabled by default, so a fresh deploy enforces the proof", () => {
    expect(isEnabled("agent_ownership_proof")).toBe(true);
  });

  it("is only disabled when explicitly opted out via env", () => {
    process.env.FEATURE_AGENT_OWNERSHIP_PROOF = "false";

    expect(isEnabled("agent_ownership_proof")).toBe(false);
  });

  it("reports the flag through the admin surface", () => {
    expect(getAllFlags().agent_ownership_proof).toEqual({
      enabled: true,
      source: "default",
    });
  });
});
