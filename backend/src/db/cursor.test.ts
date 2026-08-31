import { describe, it, expect, beforeEach } from "@jest/globals";
import Database from "better-sqlite3";
import { createTaskDb } from "../../src/db/tasks";
import { createAgentDb, type AgentRecord } from "../../src/db/agents";
import { decodeCursor } from "../../src/db/cursor";
import type { Task } from "../../src/types/task";

// ─── helpers ──────────────────────────────────────────────────────────────────

function makeTask(overrides: Partial<Task> = {}): Task {
  const id = overrides.id ?? `task_${Math.random().toString(36).slice(2, 9)}`;
  return {
    id,
    prompt: "test prompt",
    walletPublicKey: "wallet1",
    status: "queued",
    dag: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

function makeAgent(overrides: Partial<AgentRecord> = {}): AgentRecord {
  return {
    id: `agent_${Math.random().toString(36).slice(2, 9)}`,
    capabilities: ["research"],
    pricingXLM: 0.5,
    endpoint: "https://example.com",
    stellarPublicKey: "GABCDEF",
    reputationScore: 5,
    lastSeenAt: new Date().toISOString(),
    status: "online",
    ...overrides,
  };
}

// ─── Task cursor pagination ───────────────────────────────────────────────────

describe("TaskDb.listCursor", () => {
  let db: ReturnType<typeof createTaskDb>;

  beforeEach(() => {
    const raw = new Database(":memory:");
    raw.pragma("journal_mode = WAL");
    raw.exec(`
      CREATE TABLE tasks (
        id TEXT PRIMARY KEY,
        prompt TEXT NOT NULL,
        walletPublicKey TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'queued',
        dagJson TEXT NOT NULL DEFAULT '[]',
        createdAt TEXT NOT NULL,
        updatedAt TEXT NOT NULL
      );
      CREATE INDEX idx_tasks_wallet_created ON tasks (walletPublicKey, createdAt DESC, id DESC);
    `);
    db = createTaskDb(raw);

    // Insert 25 tasks with distinct timestamps (oldest first)
    const base = new Date("2024-01-01T00:00:00.000Z").getTime();
    for (let i = 0; i < 25; i++) {
      const ts = new Date(base + i * 1000).toISOString();
      db.insert(makeTask({ id: `task_${String(i).padStart(3, "0")}`, walletPublicKey: "wallet1", createdAt: ts, updatedAt: ts }));
    }
    // One task for a different wallet — must never appear in wallet1 results
    db.insert(makeTask({ id: "task_other", walletPublicKey: "wallet2" }));
  });

  it("returns the first page with correct item count", () => {
    const page = db.listCursor("wallet1", { limit: 10 });
    expect(page.items).toHaveLength(10);
  });

  it("returns a nextCursor when more pages exist", () => {
    const page = db.listCursor("wallet1", { limit: 10 });
    expect(page.nextCursor).toBeDefined();
  });

  it("does not return a nextCursor on the last page", () => {
    const page = db.listCursor("wallet1", { limit: 30 });
    expect(page.nextCursor).toBeUndefined();
  });

  it("pages through all items without duplicates or gaps", () => {
    const seen = new Set<string>();
    let cursor: string | undefined;

    do {
      const page = db.listCursor("wallet1", { limit: 10, cursor });
      for (const task of page.items) {
        expect(seen.has(task.id)).toBe(false); // no duplicates
        seen.add(task.id);
      }
      cursor = page.nextCursor;
    } while (cursor);

    expect(seen.size).toBe(25); // all 25 tasks, no gaps
    expect(seen.has("task_other")).toBe(false); // other wallet excluded
  });

  it("returns items in descending createdAt order by default", () => {
    const page = db.listCursor("wallet1", { limit: 25 });
    const dates = page.items.map((t) => new Date(t.createdAt).getTime());
    for (let i = 1; i < dates.length; i++) {
      expect(dates[i]).toBeLessThanOrEqual(dates[i - 1]);
    }
  });

  it("cursor payload encodes the last row's (createdAt, id)", () => {
    const page = db.listCursor("wallet1", { limit: 5 });
    const last = page.items[page.items.length - 1];
    const decoded = decodeCursor(page.nextCursor!);
    expect(decoded?.createdAt).toBe(last.createdAt);
    expect(decoded?.id).toBe(last.id);
  });

  it("is stable when a new row is inserted mid-pagination", () => {
    const p1 = db.listCursor("wallet1", { limit: 10 });
    // Insert a brand-new task with a very recent timestamp
    const newTask = makeTask({
      id: "task_new",
      walletPublicKey: "wallet1",
      createdAt: new Date("2030-01-01").toISOString(),
      updatedAt: new Date("2030-01-01").toISOString(),
    });
    db.insert(newTask);

    // Page 2 from the saved cursor should NOT include the new task
    const p2 = db.listCursor("wallet1", { limit: 10, cursor: p1.nextCursor });
    const ids = p2.items.map((t) => t.id);
    expect(ids).not.toContain("task_new");
  });

  it("filters by status", () => {
    db.insert(makeTask({ id: "task_done", walletPublicKey: "wallet1", status: "completed" }));
    const page = db.listCursor("wallet1", { limit: 50, status: "completed" });
    expect(page.items.every((t) => t.status === "completed")).toBe(true);
    expect(page.items.map((t) => t.id)).toContain("task_done");
  });

  it("ignores a malformed cursor and returns the first page", () => {
    const page = db.listCursor("wallet1", { limit: 10, cursor: "not-valid-base64url!!" });
    // Should silently fall back to first page
    expect(page.items).toHaveLength(10);
  });
});

// ─── Agent cursor pagination ──────────────────────────────────────────────────

describe("AgentDb.listCursor", () => {
  let db: ReturnType<typeof createAgentDb>;

  beforeEach(() => {
    const raw = new Database(":memory:");
    raw.exec(`
      CREATE TABLE agents (
        id TEXT PRIMARY KEY,
        capabilities TEXT NOT NULL,
        pricingXLM REAL NOT NULL,
        endpoint TEXT NOT NULL,
        stellarPublicKey TEXT NOT NULL,
        reputationScore REAL NOT NULL DEFAULT 0,
        lastSeenAt TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'online'
      )
    `);
    db = createAgentDb(raw);

    const base = new Date("2024-06-01T00:00:00.000Z").getTime();
    for (let i = 0; i < 15; i++) {
      const ts = new Date(base + i * 60_000).toISOString();
      db.upsert(makeAgent({ id: `agent_${String(i).padStart(3, "0")}`, lastSeenAt: ts }));
    }
  });

  it("pages through all agents without duplicates", () => {
    const seen = new Set<string>();
    let cursor: string | undefined;

    do {
      const page = db.listCursor({ limit: 5, cursor });
      for (const agent of page.items) {
        expect(seen.has(agent.id)).toBe(false);
        seen.add(agent.id);
      }
      cursor = page.nextCursor;
    } while (cursor);

    expect(seen.size).toBe(15);
  });

  it("respects the status filter", () => {
    db.upsert(makeAgent({ id: "agent_offline", status: "offline" }));
    const page = db.listCursor({ limit: 50, status: "offline" });
    expect(page.items.every((a) => a.status === "offline")).toBe(true);
    expect(page.items.map((a) => a.id)).toContain("agent_offline");
  });
});
