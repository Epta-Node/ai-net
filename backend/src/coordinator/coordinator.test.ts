/**
 * Unit tests for the coordinator layer:
 *  - taskStore (createTask, getTask, updateTask, updateNode, getEventHistory)
 *
 * Tested against an in-memory SQLite database so no disk files are created.
 */
import Database from "better-sqlite3";
import { createTaskDb } from "../db/tasks";
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
//
// The event store now lives in `src/events/eventStore`. The
// `src/coordinator/eventStore` module this block was written against was removed
// as an orphan in #571, which left these cases pointing at a module that no
// longer exists.
//
// `src/events/eventStore.test.ts` already covers the same ground against the
// current API (append → StoredEvent with globalSeq/taskSeq, listByTask ordering,
// listByTaskSince cursor semantics, the UNIQUE(task_id, task_seq) constraint,
// cross-task isolation and close()), so the duplicated — and unimportable —
// copies are not repeated here.

// ─── AbortController registry (Issue #62) ─────────────────────────────────────

describe("taskStore — AbortController registry (Issue #62)", () => {
  const { registerTaskController, unregisterTaskController, abortTask } =
    jest.requireActual<typeof import("./taskStore")>("./taskStore");

  it("abortTask returns false when no controller is registered", () => {
    expect(abortTask("nonexistent-task")).toBe(false);
  });

  it("abortTask returns true and signals when a controller is registered", () => {
    const controller = new AbortController();
    registerTaskController("task-abc", controller);

    expect(controller.signal.aborted).toBe(false);
    const result = abortTask("task-abc");
    expect(result).toBe(true);
    expect(controller.signal.aborted).toBe(true);
  });

  it("abortTask removes the entry after signalling", () => {
    const controller = new AbortController();
    registerTaskController("task-xyz", controller);
    abortTask("task-xyz");

    // A second call should now return false (entry removed)
    expect(abortTask("task-xyz")).toBe(false);
  });

  it("unregisterTaskController removes an entry without aborting", () => {
    const controller = new AbortController();
    registerTaskController("task-noreg", controller);
    unregisterTaskController("task-noreg");

    expect(controller.signal.aborted).toBe(false);
    expect(abortTask("task-noreg")).toBe(false);
  });
});
