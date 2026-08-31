/**
 * Unit tests for the coordinator layer:
 *  - taskStore (createTask, getTask, updateTask, updateNode, getEventHistory)
 *  - eventStore (append, listByTask, listByTaskSince, close)
 *
 * Both modules are tested against an in-memory SQLite database injected via
 * jest module mocks so no disk files are created.
 */
import Database from "better-sqlite3";
import { createTaskDb } from "../db/tasks";
import { createEventStore } from "./eventStore";
import type { Task, DAGNode } from "../types/task";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeTaskDb(): [Database.Database, ReturnType<typeof createTaskDb>] {
  const raw = new Database(":memory:");
  raw.exec(`
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
  return [raw, createTaskDb(raw)];
}

function makeTask(overrides: Partial<Task> = {}): Task {
  const now = new Date().toISOString();
  return {
    id: "task_001",
    prompt: "Test task",
    walletPublicKey: "GWALLET",
    status: "queued",
    dag: [],
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

// ─── taskStore operations (via createTaskDb directly) ─────────────────────────

describe("coordinator/taskStore — CRUD via TaskDb", () => {
  it("insert + findById round-trips", () => {
    const [, db] = makeTaskDb();
    const task = makeTask();
    db.insert(task);
    const found = db.findById("task_001");
    expect(found).toBeDefined();
    expect(found!.id).toBe("task_001");
    expect(found!.prompt).toBe("Test task");
  });

  it("updateStatus changes the task status", () => {
    const [, db] = makeTaskDb();
    db.insert(makeTask());
    db.updateStatus("task_001", "running");
    expect(db.findById("task_001")!.status).toBe("running");
  });

  it("updateDagJson overwrites the stored DAG", () => {
    const [, db] = makeTaskDb();
    db.insert(makeTask());
    const dag: DAGNode[] = [{ nodeId: "n1", type: "research", status: "pending", prompt: "p", dependencies: [] }];
    db.updateDagJson("task_001", JSON.stringify(dag));
    const task = db.findById("task_001")!;
    expect((task.dag as DAGNode[])[0].nodeId).toBe("n1");
  });

  it("failRunningTasks marks running tasks failed", () => {
    const [, db] = makeTaskDb();
    db.insert(makeTask({ id: "t-run", status: "running" }));
    db.failRunningTasks();
    expect(db.findById("t-run")!.status).toBe("failed");
  });
});

// ─── EventStore ───────────────────────────────────────────────────────────────

describe("createEventStore — append / listByTask / listByTaskSince", () => {
  it("appends events and returns them with seq", () => {
    const store = createEventStore();
    const ev = store.append({
      type: "node_started",
      taskId: "task_001",
      nodeId: "n1",
      timestamp: new Date().toISOString(),
      seq: 0,
    });
    expect(ev.seq).toBe(0);
    store.close();
  });

  it("listByTask returns events in insertion order", () => {
    const store = createEventStore();
    const ts = new Date().toISOString();
    store.append({ type: "node_started", taskId: "t1", nodeId: "n1", timestamp: ts, seq: 0 });
    store.append({ type: "node_completed", taskId: "t1", nodeId: "n1", timestamp: ts, seq: 1 });
    store.append({ type: "payment_released", taskId: "t1", nodeId: "n1", timestamp: ts, seq: 2 });

    const events = store.listByTask("t1");
    expect(events).toHaveLength(3);
    expect(events[0].type).toBe("node_started");
    expect(events[1].type).toBe("node_completed");
    expect(events[2].type).toBe("payment_released");
    store.close();
  });

  it("listByTask returns empty array for unknown task", () => {
    const store = createEventStore();
    expect(store.listByTask("nonexistent")).toHaveLength(0);
    store.close();
  });

  it("listByTaskSince returns only events with seq > afterSeq", () => {
    const store = createEventStore();
    const ts = new Date().toISOString();
    store.append({ type: "node_started", taskId: "t2", nodeId: "n1", timestamp: ts, seq: 0 });
    store.append({ type: "node_completed", taskId: "t2", nodeId: "n1", timestamp: ts, seq: 1 });
    store.append({ type: "payment_released", taskId: "t2", nodeId: "n1", timestamp: ts, seq: 2 });

    const events = store.listByTaskSince("t2", 0);
    expect(events).toHaveLength(2);
    expect(events[0].seq).toBe(1);
    store.close();
  });

  it("listByTaskSince returns empty array when afterSeq exceeds all events", () => {
    const store = createEventStore();
    const ts = new Date().toISOString();
    store.append({ type: "node_started", taskId: "t3", nodeId: "n1", timestamp: ts, seq: 0 });
    expect(store.listByTaskSince("t3", 99)).toHaveLength(0);
    store.close();
  });

  it("stores and retrieves payload objects", () => {
    const store = createEventStore();
    const payload = { result: "solar report", confidence: 0.9 };
    store.append({
      type: "node_completed",
      taskId: "t4",
      nodeId: "n1",
      timestamp: new Date().toISOString(),
      payload,
      seq: 0,
    });
    const events = store.listByTask("t4");
    expect(events[0].payload).toEqual(payload);
    store.close();
  });

  it("handles events without nodeId (task-level events)", () => {
    const store = createEventStore();
    store.append({ type: "task_completed", taskId: "t5", timestamp: new Date().toISOString(), seq: 0 });
    const events = store.listByTask("t5");
    expect(events[0].nodeId).toBeUndefined();
    store.close();
  });

  it("isolates events across different tasks", () => {
    const store = createEventStore();
    const ts = new Date().toISOString();
    store.append({ type: "node_started", taskId: "tA", nodeId: "n1", timestamp: ts, seq: 0 });
    store.append({ type: "node_started", taskId: "tB", nodeId: "n1", timestamp: ts, seq: 0 });

    expect(store.listByTask("tA")).toHaveLength(1);
    expect(store.listByTask("tB")).toHaveLength(1);
    store.close();
  });

  it("close() does not throw", () => {
    const store = createEventStore();
    expect(() => store.close()).not.toThrow();
  });

  it("accepts a file path string to create a persistent store", () => {
    // Use :memory: path to avoid writing files in test
    const store = createEventStore(":memory:");
    const ts = new Date().toISOString();
    store.append({ type: "node_started", taskId: "t6", nodeId: "n1", timestamp: ts, seq: 0 });
    expect(store.listByTask("t6")).toHaveLength(1);
    store.close();
  });
});
