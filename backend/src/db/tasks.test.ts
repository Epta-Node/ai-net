/**
 * Unit tests for createTaskDb — covers insert, findById, list (with filters/sort/pagination),
 * updateStatus, updateDagJson, insertEvent, getEventHistory, and failRunningTasks.
 *
 * All tests use an in-memory SQLite database.
 */
import Database from "better-sqlite3";
import { createTaskDb } from "./tasks";
import type { Task } from "../types/task";

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeDb(): Database.Database {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE IF NOT EXISTS tasks (
      id              TEXT PRIMARY KEY,
      prompt          TEXT NOT NULL,
      walletPublicKey TEXT NOT NULL DEFAULT '',
      status          TEXT NOT NULL DEFAULT 'queued',
      dagJson         TEXT NOT NULL DEFAULT '[]',
      createdAt       TEXT NOT NULL,
      updatedAt       TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS task_events (
      id        INTEGER PRIMARY KEY AUTOINCREMENT,
      taskId    TEXT    NOT NULL,
      type      TEXT    NOT NULL,
      nodeId    TEXT,
      payload   TEXT,
      timestamp TEXT    NOT NULL
    );
  `);
  return db;
}

const WALLET = "GWALLET";

function makeTask(overrides: Partial<Task> = {}): Task {
  const now = new Date().toISOString();
  return {
    id: "task_001",
    prompt: "Test prompt",
    walletPublicKey: WALLET,
    status: "queued",
    dag: [],
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

// ── insert / findById ─────────────────────────────────────────────────────────

describe("createTaskDb — insert / findById", () => {
  it("inserts a task and retrieves it by id", () => {
    const db = createTaskDb(makeDb());
    const task = makeTask();
    db.insert(task);
    const found = db.findById("task_001");
    expect(found).toBeDefined();
    expect(found!.id).toBe("task_001");
    expect(found!.prompt).toBe("Test prompt");
    expect(found!.status).toBe("queued");
  });

  it("returns undefined for unknown id", () => {
    const db = createTaskDb(makeDb());
    expect(db.findById("nonexistent")).toBeUndefined();
  });

  it("serialises and deserialises the dag array", () => {
    const db = createTaskDb(makeDb());
    const dag = [{ id: "n1", type: "research", status: "pending", prompt: "p" }] as any[];
    db.insert(makeTask({ dag }));
    const found = db.findById("task_001");
    expect(Array.isArray(found!.dag)).toBe(true);
    expect(found!.dag).toHaveLength(1);
    expect((found!.dag as any[])[0].id).toBe("n1");
  });
});

// ── list (pagination + filters + sort) ──────────────────────────────────────

describe("createTaskDb — list", () => {
  let db: ReturnType<typeof createTaskDb>;
  const wallet = WALLET;
  const now = Date.now();

  beforeEach(() => {
    const raw = makeDb();
    db = createTaskDb(raw);
    const tasks: Array<{ id: string; prompt: string; status: Task["status"]; minutesAgo: number }> = [
      { id: "t1", prompt: "Solar energy research", status: "completed", minutesAgo: 5 },
      { id: "t2", prompt: "Wind energy risk analysis", status: "queued", minutesAgo: 4 },
      { id: "t3", prompt: "Solar panel costs", status: "completed", minutesAgo: 3 },
      { id: "t4", prompt: "Battery storage", status: "failed", minutesAgo: 2 },
      { id: "t5", prompt: "Nuclear energy", status: "running", minutesAgo: 1 },
    ];
    for (const t of tasks) {
      const ts = new Date(now - t.minutesAgo * 60_000).toISOString();
      db.insert(makeTask({ id: t.id, prompt: t.prompt, status: t.status, createdAt: ts, updatedAt: ts }));
    }
  });

  it("returns all tasks with default pagination", () => {
    const { tasks, total } = db.list(wallet, 1, 10);
    expect(tasks).toHaveLength(5);
    expect(total).toBe(5);
  });

  it("paginates correctly: page 1 of 2 with pageSize 3", () => {
    const { tasks, total } = db.list(wallet, 1, 3);
    expect(tasks).toHaveLength(3);
    expect(total).toBe(5);
  });

  it("paginates correctly: page 2 of 2 with pageSize 3", () => {
    const { tasks, total } = db.list(wallet, 2, 3);
    expect(tasks).toHaveLength(2);
    expect(total).toBe(5);
  });

  it("filters by status", () => {
    const { tasks, total } = db.list(wallet, 1, 10, { status: "completed" });
    expect(total).toBe(2);
    tasks.forEach(t => expect(t.status).toBe("completed"));
  });

  it("filters by full-text search (prompt LIKE)", () => {
    const { tasks, total } = db.list(wallet, 1, 10, { q: "solar" });
    expect(total).toBe(2);
    tasks.forEach(t => expect(t.prompt.toLowerCase()).toContain("solar"));
  });

  it("returns newest first by default (createdAt:desc)", () => {
    const { tasks } = db.list(wallet, 1, 10);
    for (let i = 1; i < tasks.length; i++) {
      expect(new Date(tasks[i].createdAt).getTime())
        .toBeLessThanOrEqual(new Date(tasks[i - 1].createdAt).getTime());
    }
  });

  it("returns oldest first when sort=createdAt:asc", () => {
    const { tasks } = db.list(wallet, 1, 10, { sort: "createdAt:asc" });
    for (let i = 1; i < tasks.length; i++) {
      expect(new Date(tasks[i].createdAt).getTime())
        .toBeGreaterThanOrEqual(new Date(tasks[i - 1].createdAt).getTime());
    }
  });

  it("filters by createdAfter", () => {
    // createdAfter 3.5 minutes ago → only tasks from t1-t3 would be excluded; t4, t5 remain
    const threshold = new Date(now - 3.5 * 60_000 + 1).toISOString();
    const { tasks } = db.list(wallet, 1, 10, { createdAfter: threshold });
    // t5 (1 min ago) and t4 (2 min ago) are after the threshold
    expect(tasks.length).toBeGreaterThanOrEqual(1);
    tasks.forEach(t => expect(new Date(t.createdAt).getTime()).toBeGreaterThan(new Date(threshold).getTime()));
  });

  it("returns empty array and total=0 when no tasks match", () => {
    const { tasks, total } = db.list(wallet, 1, 10, { q: "xyzzy-nonexistent" });
    expect(tasks).toHaveLength(0);
    expect(total).toBe(0);
  });

  it("returns tasks only for the specified wallet", () => {
    const otherWallet = "GOTHER";
    db.insert(makeTask({ id: "other-task", walletPublicKey: otherWallet }));
    const { tasks } = db.list(otherWallet, 1, 10);
    expect(tasks).toHaveLength(1);
    expect(tasks[0].id).toBe("other-task");
  });
});

// ── updateStatus ──────────────────────────────────────────────────────────────

describe("createTaskDb — updateStatus", () => {
  it("updates the task status", () => {
    const db = createTaskDb(makeDb());
    db.insert(makeTask());
    db.updateStatus("task_001", "running");
    expect(db.findById("task_001")!.status).toBe("running");
  });

  it("updates updatedAt when status changes", () => {
    const db = createTaskDb(makeDb());
    const before = new Date().toISOString();
    db.insert(makeTask({ updatedAt: before }));
    db.updateStatus("task_001", "completed");
    const task = db.findById("task_001")!;
    expect(new Date(task.updatedAt).getTime()).toBeGreaterThanOrEqual(new Date(before).getTime());
  });
});

// ── updateDagJson ─────────────────────────────────────────────────────────────

describe("createTaskDb — updateDagJson", () => {
  it("overwrites the dag JSON", () => {
    const db = createTaskDb(makeDb());
    db.insert(makeTask());
    const newDag = JSON.stringify([{ id: "n1", status: "completed" }]);
    db.updateDagJson("task_001", newDag);
    const task = db.findById("task_001")!;
    expect((task.dag as any[])[0].status).toBe("completed");
  });
});

// ── insertEvent / getEventHistory ─────────────────────────────────────────────

describe("createTaskDb — insertEvent / getEventHistory", () => {
  it("stores events and retrieves them in insertion order", () => {
    const db = createTaskDb(makeDb());
    db.insert(makeTask());

    const ts = new Date().toISOString();
    db.insertEvent({ taskId: "task_001", type: "node_started", nodeId: "n1", timestamp: ts });
    db.insertEvent({ taskId: "task_001", type: "node_completed", nodeId: "n1", timestamp: ts });

    const events = db.getEventHistory("task_001");
    expect(events).toHaveLength(2);
    expect(events[0].type).toBe("node_started");
    expect(events[1].type).toBe("node_completed");
  });

  it("stores optional payload as JSON", () => {
    const db = createTaskDb(makeDb());
    db.insert(makeTask());

    const payload = { result: "done", score: 0.9 };
    db.insertEvent({ taskId: "task_001", type: "node_completed", nodeId: "n1", payload, timestamp: new Date().toISOString() });

    const [event] = db.getEventHistory("task_001");
    expect(event.payload).toEqual(payload);
  });

  it("returns empty array for a task with no events", () => {
    const db = createTaskDb(makeDb());
    db.insert(makeTask());
    expect(db.getEventHistory("task_001")).toHaveLength(0);
  });

  it("handles null nodeId gracefully", () => {
    const db = createTaskDb(makeDb());
    db.insert(makeTask());

    db.insertEvent({ taskId: "task_001", type: "task_started", timestamp: new Date().toISOString() });
    const events = db.getEventHistory("task_001");
    expect(events[0].nodeId).toBeUndefined();
  });
});

// ── failRunningTasks ──────────────────────────────────────────────────────────

describe("createTaskDb — failRunningTasks", () => {
  it("marks all running tasks as failed", () => {
    const db = createTaskDb(makeDb());
    db.insert(makeTask({ id: "t-run", status: "running" }));
    db.insert(makeTask({ id: "t-queued", status: "queued" }));

    db.failRunningTasks();

    expect(db.findById("t-run")!.status).toBe("failed");
    expect(db.findById("t-queued")!.status).toBe("queued"); // unchanged
  });

  it("marks running and pending DAG nodes as failed", () => {
    const db = createTaskDb(makeDb());
    const dag = [
      { id: "n1", status: "running" },
      { id: "n2", status: "pending" },
      { id: "n3", status: "completed" },
    ] as any[];
    db.insert(makeTask({ id: "t-run", status: "running", dag }));

    db.failRunningTasks();

    const task = db.findById("t-run")!;
    const nodes = task.dag as any[];
    expect(nodes.find(n => n.id === "n1").status).toBe("failed");
    expect(nodes.find(n => n.id === "n2").status).toBe("failed");
    expect(nodes.find(n => n.id === "n3").status).toBe("completed"); // unchanged
  });

  it("does not fail tasks that are already completed or queued", () => {
    const db = createTaskDb(makeDb());
    db.insert(makeTask({ id: "t-done", status: "completed" }));
    db.failRunningTasks();
    expect(db.findById("t-done")!.status).toBe("completed");
  });

  it("is safe to call when no running tasks exist", () => {
    const db = createTaskDb(makeDb());
    expect(() => db.failRunningTasks()).not.toThrow();
  });
});
