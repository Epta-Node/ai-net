/**
 * Persisted `capabilities` decoding — real-SQLite regression tests (issue #645).
 *
 * The default `jest.config.js` maps `better-sqlite3` to a no-op mock, so this
 * file requires the real native module by absolute path — the same technique as
 * `tests/taskEventsSchema.test.ts`. Doing so keeps the suite on genuine SQLite
 * whether it is collected by the default project or by `jest.sqlite.config.js`
 * (`npm run test:sqlite`), which deliberately omits the mapping.
 *
 * Real SQLite is required because the production failure is a SQLite-level one:
 * the registry list queries filter with `json_each(capabilities)`, and SQLite
 * raises `malformed JSON` as soon as that column is not valid JSON. A single
 * corrupted row therefore failed the whole query, which the route layer turned
 * into a 500 for `GET /api/agents`, `GET /api/agents/:id` and the cursor
 * endpoint.
 */
// Bypass the moduleNameMapper stub — require the real native module directly.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const RealDatabase = require("../../node_modules/better-sqlite3") as typeof import("better-sqlite3");

import { createAgentDb, ensureAgentTable, type AgentRecord } from "../../src/db/agents";

type RealDb = InstanceType<typeof RealDatabase>;

/** Corrupt payload: not valid JSON in any SQLite flavour. */
const MALFORMED = "{oops";

/** Fixed timestamps keep the `lastSeenAt DESC, id DESC` ordering deterministic. */
const T0 = "2026-01-01T00:00:00.000Z";
const T1 = "2026-01-02T00:00:00.000Z";
const T2 = "2026-01-03T00:00:00.000Z";

function makeDb(): RealDb {
  const db = new RealDatabase(":memory:");
  // Apply the schema up front so a fixture can insert a raw, corrupted
  // `capabilities` value before any reader runs; `createAgentDb()` would
  // otherwise apply it on first use.
  ensureAgentTable(db);
  return db;
}

function makeAgent(overrides: Partial<AgentRecord> = {}): AgentRecord {
  return {
    id: "agent-1",
    capabilities: ["research"],
    pricingXLM: 1,
    endpoint: "http://localhost:3001",
    stellarPublicKey: "GTEST",
    reputationScore: 2.5,
    lastSeenAt: T0,
    status: "online",
    ...overrides,
  };
}

/**
 * Insert a row whose `capabilities` column holds `raw` verbatim, bypassing the
 * `JSON.stringify` in `upsert()` — the only way to reproduce a corrupted column.
 */
function insertRawCapabilities(db: RealDb, id: string, raw: string, lastSeenAt = T0): void {
  db.prepare(
    `INSERT INTO agents (id, capabilities, pricingXLM, endpoint, stellarPublicKey, reputationScore, lastSeenAt, status)
     VALUES (?, ?, 1, 'http://localhost:3001', 'GTEST', 2.5, ?, 'online')`,
  ).run(id, raw, lastSeenAt);
}

describe("agent capabilities decoding (#645)", () => {
  it("shows the raw json_each() filter failing on the corrupted row", () => {
    // Anchors the rest of the suite: without the guard, the filter below is an
    // SQLite error, not a smaller result set.
    const db = makeDb();
    insertRawCapabilities(db, "broken", MALFORMED);

    expect(() =>
      db
        .prepare("SELECT * FROM agents WHERE EXISTS (SELECT 1 FROM json_each(capabilities) WHERE value = ?)")
        .all("research"),
    ).toThrow(/malformed JSON/i);
  });

  it("findById() degrades the corrupted column to an empty array", () => {
    const db = makeDb();
    const agents = createAgentDb(db);
    insertRawCapabilities(db, "broken", MALFORMED);

    const found = agents.findById("broken");
    expect(found).toBeDefined();
    expect(found!.id).toBe("broken");
    expect(found!.capabilities).toEqual([]);
  });

  it("list() returns healthy rows and degrades the corrupted one", () => {
    const db = makeDb();
    const agents = createAgentDb(db);
    agents.upsert(makeAgent({ id: "healthy", capabilities: ["research", "coding"] }));
    insertRawCapabilities(db, "broken", MALFORMED);

    const rows = agents.list();
    expect(rows).toHaveLength(2);
    const byId = new Map(rows.map((row) => [row.id, row]));
    expect(byId.get("healthy")!.capabilities).toEqual(["research", "coding"]);
    expect(byId.get("broken")!.capabilities).toEqual([]);
  });

  it("list({ capability }) keeps matching healthy rows and skips the corrupted one", () => {
    const db = makeDb();
    const agents = createAgentDb(db);
    agents.upsert(makeAgent({ id: "a1", capabilities: ["research"] }));
    agents.upsert(makeAgent({ id: "a2", capabilities: ["coding"], lastSeenAt: T1 }));
    insertRawCapabilities(db, "broken", MALFORMED, T2);

    const rows = agents.list({ capability: "research" });
    expect(rows.map((row) => row.id)).toEqual(["a1"]);
    expect(rows[0].capabilities).toEqual(["research"]);
  });

  it("list({ capability }) survives a corrupted row as the only row in the table", () => {
    const db = makeDb();
    const agents = createAgentDb(db);
    insertRawCapabilities(db, "broken", MALFORMED);

    expect(agents.list({ capability: "research" })).toEqual([]);
  });

  it("listCursor({ capability }) paginates healthy rows and skips the corrupted one", () => {
    const db = makeDb();
    const agents = createAgentDb(db);
    agents.upsert(makeAgent({ id: "a1", capabilities: ["research"], lastSeenAt: T0 }));
    agents.upsert(makeAgent({ id: "a2", capabilities: ["coding"], lastSeenAt: T1 }));
    insertRawCapabilities(db, "broken", MALFORMED, T2);

    const page = agents.listCursor({ capability: "coding" });
    expect(page.items.map((row) => row.id)).toEqual(["a2"]);
    expect(page.items[0].capabilities).toEqual(["coding"]);
  });

  it("treats a valid JSON document that is not an array as no capabilities", () => {
    const db = makeDb();
    const agents = createAgentDb(db);
    insertRawCapabilities(db, "object", '{"research":true}');

    expect(agents.findById("object")!.capabilities).toEqual([]);
    expect(agents.list({ capability: "research" })).toEqual([]);
  });

  it("keeps the healthy upsert() → findById() round trip unchanged", () => {
    const db = makeDb();
    const agents = createAgentDb(db);
    agents.upsert(makeAgent({ id: "round-trip", capabilities: ["coding", "design"] }));

    expect(agents.findById("round-trip")!.capabilities).toEqual(["coding", "design"]);
  });
});

