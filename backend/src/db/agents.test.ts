/**
 * Unit tests for the AgentDb (createAgentDb) operations.
 *
 * Uses an in-memory SQLite database so no files are created on disk.
 */
import fs from "fs";
import os from "os";
import path from "path";
import Database from "better-sqlite3";
import {
  closeAgentDb,
  createAgentDb,
  ensureAgentTable,
  getAgentDb,
  getAgentPool,
  type AgentRecord,
} from "./agents";

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * A raw handle with the schema already applied, mirroring what the pool's
 * `onCreate` hook leaves behind. `createAgentDb` is a pure mapping now, so the
 * fixture has to initialise the schema itself.
 */
function makeDb(): Database.Database {
  const db = new Database(":memory:");
  ensureAgentTable(db);
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

// ── Schema initialisation & wrapper memoisation ──────────────────────────────

/** Schema DDL issued through `exec` (the only channel `ensureAgentTable` uses). */
function ddlFrom(execSpy: jest.SpyInstance): string[] {
  return execSpy.mock.calls
    .map(([sql]: [string]) => String(sql))
    .filter((sql) => /^\s*(CREATE|ALTER|DROP)\b/i.test(sql));
}

describe("agent schema initialisation", () => {
  let execSpy: jest.SpyInstance;
  let dir: string;

  beforeEach(() => {
    // Spying on the prototype catches the DDL the pool runs while it is still
    // being constructed, before a test could reach the handle.
    execSpy = jest.spyOn(Database.prototype as unknown as { exec: () => void }, "exec");
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "agents-init-"));
  });

  afterEach(() => {
    closeAgentDb();
    execSpy.mockRestore();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("creates the agents schema while the pool is being initialised", () => {
    getAgentPool(path.join(dir, "agents.db"));

    const ddl = ddlFrom(execSpy).join("\n");
    expect(ddl).toMatch(/CREATE TABLE IF NOT EXISTS agents/i);
    // `bondAmountXLM` only appears in `ensureAgentTable`, so this pins the
    // schema setup to the pool's onCreate hook specifically.
    expect(ddl).toMatch(/bondAmountXLM/);
  });

  it("issues zero DDL when wrapping an already-initialised handle", () => {
    const file = path.join(dir, "agents.db");
    getAgentPool(file);
    execSpy.mockClear();

    for (let i = 0; i < 25; i += 1) {
      createAgentDb(getAgentDb(file));
    }

    expect(execSpy).not.toHaveBeenCalled();
  });

  it("returns the same wrapper reference for the same handle", () => {
    const raw = makeDb();
    expect(createAgentDb(raw)).toBe(createAgentDb(raw));
  });

  it("returns a distinct wrapper for a different handle", () => {
    expect(createAgentDb(makeDb())).not.toBe(createAgentDb(makeDb()));
  });
});

describe("agent reputation columns (#910)", () => {
  it("migration adds both columns with the documented defaults and rolls back", () => {
    const dir = path.join(__dirname, "migrations", "agents");
    const up = fs.readFileSync(path.join(dir, "003_agent_reputation.up.sql"), "utf8");
    const down = fs.readFileSync(path.join(dir, "003_agent_reputation.down.sql"), "utf8");
    const raw = new Database(":memory:");
    raw.exec("CREATE TABLE agents (id TEXT PRIMARY KEY, reputationScore REAL NOT NULL DEFAULT 2.5)");
    raw.prepare("INSERT INTO agents (id, reputationScore) VALUES ('a1', 3.2)").run();

    raw.exec(up);
    const row = raw.prepare(
      "SELECT reputation_score, reputation_updated_at FROM agents WHERE id = 'a1'"
    ).get() as { reputation_score: number; reputation_updated_at: string | null };
    expect(row.reputation_score).toBeCloseTo(3.2);
    expect(Object.prototype.hasOwnProperty.call(row, "reputation_updated_at")).toBe(true);

    raw.exec(down);
    const columns = raw.prepare("PRAGMA table_info(agents)").all() as Array<{ name: string }>;
    expect(columns.map((column) => column.name)).not.toContain("reputation_score");
    expect(columns.map((column) => column.name)).not.toContain("reputation_updated_at");
  });

  it("upsert writes both reputation columns and the update timestamp", () => {
    const raw = makeDb();
    const db = createAgentDb(raw);
    db.upsert(makeAgent({ reputationScore: 1.2 }));

    const row = raw.prepare(
      "SELECT reputationScore, reputation_score, reputation_updated_at FROM agents WHERE id = 'agent-1'"
    ).get() as { reputationScore: number; reputation_score: number; reputation_updated_at: string };
    expect(row.reputationScore).toBeCloseTo(1.2);
    expect(row.reputation_score).toBeCloseTo(1.2);
    expect(typeof row.reputation_updated_at).toBe("string");
  });

  it("reads reputation from the new column", () => {
    const raw = makeDb();
    const db = createAgentDb(raw);
    db.upsert(makeAgent({ reputationScore: 0.5 }));
    raw.prepare(
      "UPDATE agents SET reputation_score = 4.1, reputation_updated_at = '2026-01-01T00:00:00.000Z' WHERE id = 'agent-1'"
    ).run();

    expect(db.findById("agent-1")).toMatchObject({
      reputationScore: 4.1,
      reputationUpdatedAt: "2026-01-01T00:00:00.000Z",
    });
  });

  it("updateReputation keeps both columns in sync and stamps the time", () => {
    const raw = makeDb();
    const db = createAgentDb(raw);
    db.upsert(makeAgent({ reputationScore: 0.5 }));
    db.updateReputation("agent-1", 0.2);

    const row = raw.prepare(
      "SELECT reputationScore, reputation_score, reputation_updated_at FROM agents WHERE id = 'agent-1'"
    ).get() as { reputationScore: number; reputation_score: number; reputation_updated_at: string };
    expect(row.reputationScore).toBeCloseTo(0.7);
    expect(row.reputation_score).toBeCloseTo(0.7);
    expect(typeof row.reputation_updated_at).toBe("string");
  });

  it("filters by the new reputation column", () => {
    const raw = makeDb();
    const db = createAgentDb(raw);
    db.upsert(makeAgent({ id: "a1", reputationScore: 0.8 }));
    raw.prepare("UPDATE agents SET reputation_score = 0.2 WHERE id = 'a1'").run();
    db.upsert(makeAgent({ id: "a2", reputationScore: 0.5 }));

    expect(db.list({ minReputation: 0.5 }).map((agent) => agent.id)).toEqual(["a2"]);
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
