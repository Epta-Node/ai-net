/**
 * Unit tests for the AgentDb (createAgentDb) operations.
 *
 * Uses an in-memory SQLite database so no files are created on disk.
 */
import Database from "better-sqlite3";
import { createAgentDb, type AgentRecord } from "./agents";

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

function makeAgent(overrides: Partial<AgentRecord> = {}): AgentRecord {
  return {
    id: "agent-1",
    capabilities: ["research"],
    pricingXLM: 1.5,
    endpoint: "http://localhost:3001",
    stellarPublicKey: "GTEST",
    reputationScore: 0,
    lastSeenAt: new Date().toISOString(),
    status: "online",
    ...overrides,
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("createAgentDb — upsert / findById", () => {
  it("inserts and retrieves an agent by id", () => {
    const db = createAgentDb(makeDb());
    const agent = makeAgent();
    db.upsert(agent);
    const found = db.findById("agent-1");
    expect(found).toBeDefined();
    expect(found!.id).toBe("agent-1");
    expect(found!.capabilities).toEqual(["research"]);
    expect(found!.status).toBe("online");
  });

  it("updates an existing agent on upsert", () => {
    const db = createAgentDb(makeDb());
    db.upsert(makeAgent({ pricingXLM: 1.0 }));
    db.upsert(makeAgent({ pricingXLM: 2.5 }));
    const found = db.findById("agent-1");
    expect(found!.pricingXLM).toBe(2.5);
  });

  it("returns undefined for unknown id", () => {
    const db = createAgentDb(makeDb());
    expect(db.findById("nonexistent")).toBeUndefined();
  });

  it("serialises and deserialises capabilities array", () => {
    const db = createAgentDb(makeDb());
    db.upsert(makeAgent({ capabilities: ["coding", "design"] }));
    const found = db.findById("agent-1");
    expect(found!.capabilities).toEqual(["coding", "design"]);
  });
});

describe("createAgentDb — list with filters", () => {
  let db: ReturnType<typeof createAgentDb>;

  beforeEach(() => {
    const raw = makeDb();
    db = createAgentDb(raw);
    db.upsert(makeAgent({ id: "a1", capabilities: ["research"], pricingXLM: 1.0, reputationScore: 0.8, status: "online" }));
    db.upsert(makeAgent({ id: "a2", capabilities: ["coding"], pricingXLM: 3.0, reputationScore: 0.5, status: "online" }));
    db.upsert(makeAgent({ id: "a3", capabilities: ["design"], pricingXLM: 2.0, reputationScore: 0.9, status: "offline" }));
  });

  it("returns all agents when no filters given", () => {
    expect(db.list()).toHaveLength(3);
  });

  it("filters by capability", () => {
    const agents = db.list({ capability: "research" });
    expect(agents).toHaveLength(1);
    expect(agents[0].id).toBe("a1");
  });

  it("filters by minReputation", () => {
    const agents = db.list({ minReputation: 0.8 });
    expect(agents.map(a => a.id).sort()).toEqual(["a1", "a3"].sort());
  });

  it("filters by maxPriceXLM", () => {
    const agents = db.list({ maxPriceXLM: 2.0 });
    expect(agents.map(a => a.id).sort()).toEqual(["a1", "a3"].sort());
  });

  it("filters by status offline", () => {
    const agents = db.list({ status: "offline" });
    expect(agents).toHaveLength(1);
    expect(agents[0].id).toBe("a3");
  });

  it("combines multiple filters", () => {
    const agents = db.list({ maxPriceXLM: 2.0, minReputation: 0.85 });
    expect(agents).toHaveLength(1);
    expect(agents[0].id).toBe("a3");
  });

  it("returns empty array when no agents match", () => {
    expect(db.list({ capability: "nonexistent" })).toHaveLength(0);
  });
});

describe("createAgentDb — delete", () => {
  it("removes an agent by id", () => {
    const db = createAgentDb(makeDb());
    db.upsert(makeAgent());
    db.delete("agent-1");
    expect(db.findById("agent-1")).toBeUndefined();
  });

  it("is safe to call delete on a nonexistent id", () => {
    const db = createAgentDb(makeDb());
    expect(() => db.delete("does-not-exist")).not.toThrow();
  });
});

describe("createAgentDb — updateReputation", () => {
  it("increases reputation by delta", () => {
    const db = createAgentDb(makeDb());
    db.upsert(makeAgent({ reputationScore: 0.5 }));
    db.updateReputation("agent-1", 0.2);
    const agent = db.findById("agent-1");
    expect(agent!.reputationScore).toBeCloseTo(0.7);
  });

  it("decreases reputation with a negative delta", () => {
    const db = createAgentDb(makeDb());
    db.upsert(makeAgent({ reputationScore: 0.5 }));
    db.updateReputation("agent-1", -0.3);
    const agent = db.findById("agent-1");
    expect(agent!.reputationScore).toBeCloseTo(0.2);
  });
});

describe("createAgentDb — markAllOffline", () => {
  it("sets all online agents to offline", () => {
    const raw = makeDb();
    const db = createAgentDb(raw);
    db.upsert(makeAgent({ id: "a1", status: "online" }));
    db.upsert(makeAgent({ id: "a2", status: "online" }));
    db.markAllOffline();
    const agents = db.list();
    agents.forEach(a => expect(a.status).toBe("offline"));
  });

  it("leaves already-offline agents unchanged", () => {
    const raw = makeDb();
    const db = createAgentDb(raw);
    db.upsert(makeAgent({ id: "a1", status: "offline" }));
    expect(() => db.markAllOffline()).not.toThrow();
    expect(db.findById("a1")!.status).toBe("offline");
  });
});

describe("createAgentDb — updateLastSeen", () => {
  it("updates lastSeenAt and sets status to online", () => {
    const raw = makeDb();
    const db = createAgentDb(raw);
    db.upsert(makeAgent({ status: "offline" }));
    db.updateLastSeen("agent-1");
    const agent = db.findById("agent-1");
    expect(agent?.status).toBe("online");
    expect(agent?.lastSeenAt).toBeDefined();
  });
});

describe("createAgentDb — markStaleAgents", () => {
  it("returns count of agents marked offline", () => {
    const raw = makeDb();
    const db = createAgentDb(raw);

    // Insert agent with lastSeenAt 10 minutes ago (stale with 5-min threshold)
    const staleTime = new Date(Date.now() - 10 * 60_000).toISOString();
    raw.prepare(
      `INSERT INTO agents (id, capabilities, pricingXLM, endpoint, stellarPublicKey, reputationScore, lastSeenAt, status)
       VALUES ('stale', '["coding"]', 1, 'http://x', 'G', 0, ?, 'online')`
    ).run(staleTime);

    const count = db.markStaleAgents(5);
    expect(count).toBe(1);
    expect(db.findById("stale")?.status).toBe("offline");
  });

  it("does not mark fresh agents offline", () => {
    const raw = makeDb();
    const db = createAgentDb(raw);
    db.upsert(makeAgent({ id: "fresh", status: "online" })); // just inserted = fresh
    const count = db.markStaleAgents(5);
    expect(count).toBe(0);
  });
});

describe("createAgentDb — deleteOfflineAgents", () => {
  it("deletes old offline agents and returns count", () => {
    const raw = makeDb();
    const db = createAgentDb(raw);

    // Insert agent that has been offline for 26 hours
    const oldTime = new Date(Date.now() - 26 * 60 * 60_000).toISOString();
    raw.prepare(
      `INSERT INTO agents (id, capabilities, pricingXLM, endpoint, stellarPublicKey, reputationScore, lastSeenAt, status)
       VALUES ('old-offline', '["coding"]', 1, 'http://x', 'G', 0, ?, 'offline')`
    ).run(oldTime);

    const count = db.deleteOfflineAgents(24);
    expect(count).toBe(1);
    expect(db.findById("old-offline")).toBeUndefined();
  });

  it("does not delete recently-offline agents", () => {
    const raw = makeDb();
    const db = createAgentDb(raw);
    db.upsert(makeAgent({ status: "offline" })); // just marked offline = recent
    const count = db.deleteOfflineAgents(24);
    expect(count).toBe(0);
    expect(db.findById("agent-1")).toBeDefined();
  });
});
