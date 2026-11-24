/**
 * Event-store retention and compaction — real-SQLite integration tests
 * (issue #383).
 *
 * These live in `tests/sqlite/` and run under `jest.sqlite.config.js` rather
 * than the default backend suite, because the default config maps
 * `better-sqlite3` to a stub mock (needed since the native module has no
 * Windows prebuild).  The behaviour under test here — transactional rollback,
 * `RAISE(ABORT)` triggers, `INSERT OR IGNORE`, partial-archive detection, and
 * row-count arithmetic under sustained load — cannot be observed through a
 * stub, so these tests need genuine SQLite.
 *
 * Nothing here touches the application databases: each test opens its own
 * temporary event-store file and injects a task-status lookup, so the suite is
 * fully isolated.
 */

import fs from "fs";
import os from "os";
import path from "path";
import Database from "better-sqlite3";
import { createEventStore, type EventStore } from "../../src/events/eventStore";
import { EventRetentionService } from "../../src/services/eventRetention";
import {
  makeNodeCompleted,
  makeNodeStarted,
  makePaymentLocked,
  makePaymentReleased,
  makeTaskCompleted,
  makeTaskCreated,
  type AppEvent,
} from "../../src/events/eventTypes";
import type { TaskStatus } from "../../src/types/task";

const MS_PER_DAY = 24 * 60 * 60 * 1000;

let tmpDir: string;
/** Handles opened by the current test, closed in afterEach. */
let openHandles: Array<{ close(): void }> = [];

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ainet-events-"));
  openHandles = [];
});

afterEach(() => {
  // Close before removing: a leaked handle makes the Windows unlink fail with
  // EPERM and would mask the real assertion failure.
  for (const handle of openHandles.reverse()) {
    try {
      handle.close();
    } catch {
      /* already closed */
    }
  }
  openHandles = [];
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

/** Open an isolated, file-backed event store for one test. */
function openStore(name = "events.db"): { store: EventStore; db: Database.Database } {
  const file = path.join(tmpDir, name);
  const store = createEventStore(file);
  // A second handle on the same file lets tests read tables directly and, more
  // importantly, install triggers that fail the archive write.
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  openHandles.push(db, store);
  return { store, db };
}

function isoAt(baseMs: number, offsetMs: number): string {
  return new Date(baseMs + offsetMs).toISOString();
}

/**
 * Seed one finished task with a realistic event sequence:
 * TaskCreated, then per node (NodeStarted, NodeCompleted, PaymentLocked,
 * PaymentReleased), then TaskCompleted.
 *
 * Events are written through `store.append` — the real write path — with
 * explicit `taskSeq` values so back-dated rows can be positioned precisely.
 */
function seedFinishedTask(
  store: EventStore,
  taskId: string,
  baseMs: number,
  nodes: number,
  opts: { terminal?: "completed" | "failed" } = {},
): number {
  const events: AppEvent[] = [
    makeTaskCreated(
      taskId,
      { prompt: "p", walletPublicKey: "w", dagSize: nodes },
      isoAt(baseMs, 0),
    ),
  ];

  for (let i = 0; i < nodes; i += 1) {
    const nodeId = `node-${i}`;
    const t = baseMs + (i + 1) * 1000;
    events.push(makeNodeStarted(taskId, nodeId, { agentType: "worker" }, isoAt(baseMs, t - baseMs)));
    events.push(
      makeNodeCompleted(taskId, nodeId, { result: "ok", durationMs: 500 }, isoAt(baseMs, t - baseMs + 100)),
    );
    events.push(
      makePaymentLocked(
        taskId,
        nodeId,
        { balanceId: `bal-${i}`, amountStroops: 1000 },
        isoAt(baseMs, t - baseMs + 150),
      ),
    );
    events.push(
      makePaymentReleased(
        taskId,
        nodeId,
        { txHash: `tx-${i}`, ledgerSequence: 1 },
        isoAt(baseMs, t - baseMs + 200),
      ),
    );
  }

  events.push(
    opts.terminal === "failed"
      ? makeTaskFailedEvent(taskId, isoAt(baseMs, (nodes + 1) * 1000))
      : makeTaskCompleted(taskId, isoAt(baseMs, (nodes + 1) * 1000)),
  );

  events.forEach((event, seq) => {
    store.append({ ...event, taskSeq: seq } as AppEvent);
  });
  return events.length;
}

// Local helper so the import list stays focused; mirrors makeTaskFailed.
function makeTaskFailedEvent(taskId: string, occurredAt: string): AppEvent {
  return { type: "TaskFailed", taskId, occurredAt, version: 2, payload: { error: "boom" } };
}

/** Seed a task whose events stop at NodeCompleted — i.e. still running. */
function seedRunningTask(store: EventStore, taskId: string, baseMs: number): number {
  const events: AppEvent[] = [
    makeTaskCreated(taskId, { prompt: "p", walletPublicKey: "w", dagSize: 1 }, isoAt(baseMs, 0)),
    makeNodeStarted(taskId, "node-0", { agentType: "worker" }, isoAt(baseMs, 1000)),
    makeNodeCompleted(taskId, "node-0", { result: "ok" }, isoAt(baseMs, 2000)),
  ];
  events.forEach((event, seq) => {
    store.append({ ...event, taskSeq: seq } as AppEvent);
  });
  return events.length;
}

/** Count rows in an arbitrary table via the raw handle. */
function countRows(db: Database.Database, table: string): number {
  return (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
}

/** A status lookup backed by an in-memory map. */
function statusLookup(statuses: Record<string, TaskStatus>) {
  return (taskId: string): TaskStatus | undefined => statuses[taskId];
}

// ---------------------------------------------------------------------------
// Test 2 — archive failure must purge nothing
// ---------------------------------------------------------------------------

describe("event retention: archive-then-purge safety", () => {
  it("purges nothing when the archive write aborts", () => {
    const { store, db } = openStore();
    seedFinishedTask(store, "task-a", Date.now() - 90 * MS_PER_DAY, 2);
    const before = countRows(db, "task_events");
    expect(before).toBeGreaterThan(0);

    // Simulate an archive that is unavailable (disk full, permissions, ...).
    db.exec(`
      CREATE TRIGGER block_archive BEFORE INSERT ON task_event_archive
      BEGIN SELECT RAISE(ABORT, 'archive unavailable'); END;
    `);

    const service = new EventRetentionService({
      eventStore: store,
      retentionDays: 30,
      batchTasks: 100,
      now: () => new Date(),
      getTaskStatus: statusLookup({ "task-a": "completed" }),
    });

    const stats = service.run();

    expect(stats.failedTasks).toBe(1);
    expect(stats.compactedTasks).toBe(0);
    expect(stats.eventsPurged).toBe(0);
    // The live rows must be completely intact — this is the no-data-loss window.
    expect(countRows(db, "task_events")).toBe(before);
    expect(countRows(db, "task_event_archive")).toBe(0);
    expect(countRows(db, "task_event_summary")).toBe(0);

    db.close();
    store.close();
  });

  it("purges nothing when the archive write is silently partial", () => {
    const { store, db } = openStore();
    seedFinishedTask(store, "task-b", Date.now() - 90 * MS_PER_DAY, 2);
    const before = countRows(db, "task_events");

    // RAISE(IGNORE) drops the row without raising an error, so the archive
    // insert "succeeds" but stores nothing. This is the case the in-transaction
    // read-back exists to catch — statement ordering alone would not.
    db.exec(`
      CREATE TRIGGER drop_archive BEFORE INSERT ON task_event_archive
      BEGIN SELECT RAISE(IGNORE); END;
    `);

    const service = new EventRetentionService({
      eventStore: store,
      retentionDays: 30,
      batchTasks: 100,
      now: () => new Date(),
      getTaskStatus: statusLookup({ "task-b": "completed" }),
    });

    const stats = service.run();

    expect(stats.failedTasks).toBe(1);
    expect(stats.eventsPurged).toBe(0);
    expect(countRows(db, "task_events")).toBe(before);
    expect(countRows(db, "task_event_archive")).toBe(0);

    db.close();
    store.close();
  });

  it("refuses to compact a task that stops being finished mid-pass", () => {
    const { store, db } = openStore();
    seedFinishedTask(store, "task-c", Date.now() - 90 * MS_PER_DAY, 1);
    const before = countRows(db, "task_events");

    let calls = 0;
    // Terminal on the eligibility check, non-terminal by the time the
    // in-transaction re-assert runs — exactly the cross-database TOCTOU window.
    const service = new EventRetentionService({
      eventStore: store,
      retentionDays: 30,
      batchTasks: 100,
      now: () => new Date(),
      getTaskStatus: () => {
        calls += 1;
        return calls <= 1 ? "completed" : "running";
      },
    });

    const stats = service.run();

    expect(stats.failedTasks).toBe(1);
    expect(stats.eventsPurged).toBe(0);
    expect(countRows(db, "task_events")).toBe(before);

    db.close();
    store.close();
  });
});

// ---------------------------------------------------------------------------
// Test 3 — idempotency
// ---------------------------------------------------------------------------

describe("event retention: idempotency", () => {
  it("is a no-op when run repeatedly over the same data", () => {
    const { store, db } = openStore();
    seedFinishedTask(store, "task-d", Date.now() - 90 * MS_PER_DAY, 2);

    const make = () =>
      new EventRetentionService({
        eventStore: store,
        retentionDays: 30,
        batchTasks: 100,
        now: () => new Date(),
        getTaskStatus: statusLookup({ "task-d": "completed" }),
      });

    const first = make().run();
    expect(first.compactedTasks).toBe(1);

    const liveAfterFirst = countRows(db, "task_events");
    const archivedAfterFirst = countRows(db, "task_event_archive");
    const summaryAfterFirst = countRows(db, "task_event_summary");
    const summaries = store.archive.listSummaryByTask("task-d");
    expect(summaryAfterFirst).toBeGreaterThan(0);

    const second = make().run();
    const third = make().run();

    // No error, nothing double-archived, nothing double-purged.
    expect(second.compactedTasks).toBe(0);
    expect(third.compactedTasks).toBe(0);
    expect(second.failedTasks).toBe(0);
    expect(third.failedTasks).toBe(0);
    expect(countRows(db, "task_events")).toBe(liveAfterFirst);
    expect(countRows(db, "task_event_archive")).toBe(archivedAfterFirst);
    expect(countRows(db, "task_event_summary")).toBe(summaryAfterFirst);
    expect(store.archive.listSummaryByTask("task-d")).toEqual(summaries);

    db.close();
    store.close();
  });

  it("treats a repeated compactTask on an already-purged task as a no-op", () => {
    const { store, db } = openStore();
    seedFinishedTask(store, "task-e", Date.now() - 90 * MS_PER_DAY, 1);

    const first = store.archive.compactTask("task-e", "completed", () => {});
    expect(first.compacted).toBe(true);
    const archivedAfterFirst = countRows(db, "task_event_archive");

    // Direct re-invocation: INSERT OR IGNORE / ON CONFLICT DO UPDATE must not
    // raise or duplicate even though the candidate scan would never select this
    // task again.
    const second = store.archive.compactTask("task-e", "completed", () => {});
    expect(second.compacted).toBe(false);
    expect(second.reason).toBe("no-live-events");
    expect(countRows(db, "task_event_archive")).toBe(archivedAfterFirst);

    db.close();
    store.close();
  });
});

// ---------------------------------------------------------------------------
// Test 4 — active tasks and the system pseudo-task are never touched
// ---------------------------------------------------------------------------

describe("event retention: eligibility", () => {
  it("never compacts unfinished tasks or the system pseudo-task", () => {
    const { store, db } = openStore();
    const old = Date.now() - 90 * MS_PER_DAY;

    seedRunningTask(store, "task-running", old);
    seedFinishedTask(store, "task-completed", old, 2);
    store.append({
      ...makeTaskCreated("task-queued", { prompt: "p", walletPublicKey: "w", dagSize: 1 }),
      taskSeq: 0,
    } as AppEvent);
    store.append({ ...makeTaskCompleted("task-queued"), taskSeq: 1 } as AppEvent);
    // Agent-monitor events are emitted under the "system" pseudo-task and have
    // no row in the tasks table; they must never be archived or purged.
    store.append({
      type: "AgentRecovered",
      taskId: "system",
      occurredAt: isoAt(old, 0),
      version: 2,
      payload: { agentId: "a" },
      taskSeq: 0,
    } as unknown as AppEvent);
    store.append({
      type: "AgentMarkedOffline",
      taskId: "system",
      occurredAt: isoAt(old, 1000),
      version: 2,
      payload: { agentId: "a" },
      taskSeq: 1,
    } as unknown as AppEvent);

    const service = new EventRetentionService({
      eventStore: store,
      retentionDays: 30,
      batchTasks: 100,
      now: () => new Date(),
      getTaskStatus: statusLookup({
        "task-running": "running",
        "task-completed": "completed",
        "task-queued": "queued",
        // Note: no "system" entry — it is not a task.
      }),
    });

    const stats = service.run();

    expect(stats.compactedTasks).toBe(1);
    expect(stats.failedTasks).toBe(0);

    expect(store.listByTask("task-running").length).toBeGreaterThan(0);
    expect(store.listByTask("task-queued").length).toBeGreaterThan(0);
    expect(store.listByTask("system").length).toBe(2);
    // Only the finished task's 10 rows left the live table:
    // running(3) + queued(2) + system(2).
    expect(countRows(db, "task_events")).toBe(7);
    expect(countRows(db, "task_event_archive")).toBe(10);

    db.close();
    store.close();
  });
});

// ---------------------------------------------------------------------------
// Test 5 — purged events remain queryable via the archive
// ---------------------------------------------------------------------------

describe("event retention: archive queryability", () => {
  it("serves a purged task's full timeline from the archive", () => {
    const { store, db } = openStore();
    seedFinishedTask(store, "task-f", Date.now() - 90 * MS_PER_DAY, 2);

    const liveBefore = store.listByTask("task-f");
    expect(liveBefore.length).toBe(10);

    const service = new EventRetentionService({
      eventStore: store,
      retentionDays: 30,
      batchTasks: 100,
      now: () => new Date(),
      getTaskStatus: statusLookup({ "task-f": "completed" }),
    });
    expect(service.run().compactedTasks).toBe(1);

    // Purged from the live table...
    expect(store.listByTask("task-f")).toEqual([]);

    // ...but still fully replayable, in order, with payloads intact.
    const archived = store.archive.listArchivedByTask("task-f");
    expect(archived).toEqual(liveBefore);
    expect(archived.map((e) => e.taskSeq)).toEqual(liveBefore.map((e) => e.taskSeq));
    expect(archived.map((e) => e.type)).toEqual(liveBefore.map((e) => e.type));

    // The materialized summary is also queryable.
    const summaries = store.archive.listSummaryByTask("task-f");
    expect(summaries.length).toBe(3); // 2 nodes + 1 task-level rollup
    const totals = summaries.reduce((sum, s) => sum + s.eventCount, 0);
    expect(totals).toBe(10);

    const taskLevel = summaries.find((s) => s.nodeId === "");
    expect(taskLevel).toBeDefined();
    expect(taskLevel?.terminalStatus).toBe("completed");
    expect(taskLevel?.counts.TaskCreated).toBe(1);
    expect(taskLevel?.counts.TaskCompleted).toBe(1);

    const nodeLevel = summaries.filter((s) => s.nodeId !== "");
    expect(nodeLevel).toHaveLength(2);
    for (const node of nodeLevel) {
      expect(node.eventCount).toBe(4); // started, completed, locked, released
      expect(node.counts.NodeStarted).toBe(1);
      expect(node.counts.PaymentLocked).toBe(1);
    }

    db.close();
    store.close();
  });
});

// ---------------------------------------------------------------------------
// Test 6 — table size plateaus under steady load
// ---------------------------------------------------------------------------

describe("event retention: plateau under steady load", () => {
  const DAYS = 60;
  const TASKS_PER_DAY = 100;
  const NODES = 2;
  const EVENTS_PER_TASK = 1 + NODES * 4 + 1; // 10
  const EVENTS_PER_DAY = TASKS_PER_DAY * EVENTS_PER_TASK;
  const RETENTION_DAYS = 7;

  it("keeps the live table bounded while archiving everything it purges", () => {
    const { store, db } = openStore();
    const t0 = Date.parse("2026-01-01T00:00:00.000Z");
    const statuses: Record<string, TaskStatus> = {};
    const liveCounts: number[] = [];
    let totalWritten = 0;

    for (let day = 0; day < DAYS; day += 1) {
      const dayBase = t0 + day * MS_PER_DAY;
      for (let t = 0; t < TASKS_PER_DAY; t += 1) {
        const taskId = `day-${day}-task-${t}`;
        totalWritten += seedFinishedTask(store, taskId, dayBase, NODES);
        statuses[taskId] = "completed";
      }

      // One compaction pass per simulated day, at the end of that day.
      const service = new EventRetentionService({
        eventStore: store,
        retentionDays: RETENTION_DAYS,
        // Must be >= the number of tasks ageing out per day, otherwise the
        // pass cannot keep up with ingestion. Covered explicitly by the next
        // test.
        batchTasks: TASKS_PER_DAY * 2,
        now: () => new Date(dayBase + MS_PER_DAY),
        getTaskStatus: statusLookup(statuses),
      });
      service.run();

      liveCounts.push(countRows(db, "task_events"));
    }

    const firstSettled = RETENTION_DAYS + 1;
    const plateau = liveCounts.slice(firstSettled);
    const last = liveCounts[liveCounts.length - 1];
    const twentyDaysIn = liveCounts[20];

    // eslint-disable-next-line no-console
    console.log(
      `[plateau] live rows: first=${liveCounts[0]} day20=${twentyDaysIn} ` +
        `day${DAYS - 1}=${last} | ingested total=${totalWritten} ` +
        `archived=${countRows(db, "task_event_archive")} ` +
        `summaries=${countRows(db, "task_event_summary")}`,
    );

    // 1. Bounded: the live table never exceeds the retention window plus a
    //    day's partial, with 10% headroom for batch boundaries.
    const ceiling = (RETENTION_DAYS + 1) * EVENTS_PER_DAY * 1.1;
    expect(last).toBeLessThanOrEqual(ceiling);
    for (const count of plateau) {
      expect(count).toBeLessThanOrEqual(ceiling);
    }

    // 2. The slope is flat: net growth between day 20 and day 59 is less than a
    //    single day of ingestion. This is the actual "plateaus" assertion —
    //    not merely "it stopped growing at some point".
    expect(last - twentyDaysIn).toBeLessThan(EVENTS_PER_DAY);
    expect(Math.max(...plateau) - Math.min(...plateau)).toBeLessThan(EVENTS_PER_DAY);

    // 3. Nothing was lost: every row written is either live or archived.
    expect(countRows(db, "task_events") + countRows(db, "task_event_archive")).toBe(totalWritten);
    expect(countRows(db, "task_event_archive")).toBeGreaterThan(0);
    expect(countRows(db, "task_event_summary")).toBeGreaterThan(0);

    // 4. Every archived task is queryable via the archive.
    const sampleTaskId = "day-0-task-0";
    expect(store.listByTask(sampleTaskId)).toEqual([]);
    expect(store.archive.listArchivedByTask(sampleTaskId)).toHaveLength(EVENTS_PER_TASK);

    db.close();
    store.close();
  });

  it("grows without bound when the batch cap is below the ageing-out rate", () => {
    // Demonstrates that the plateau depends on the compaction rate keeping up
    // with ingestion, rather than being an automatic property of the policy.
    const { store, db } = openStore();
    const t0 = Date.parse("2026-01-01T00:00:00.000Z");
    const statuses: Record<string, TaskStatus> = {};
    const BATCH = 25; // < TASKS_PER_DAY, so the backlog can never be drained
    const DAYS = 20;

    for (let day = 0; day < DAYS; day += 1) {
      const dayBase = t0 + day * MS_PER_DAY;
      for (let t = 0; t < TASKS_PER_DAY; t += 1) {
        const taskId = `slow-${day}-task-${t}`;
        seedFinishedTask(store, taskId, dayBase, NODES);
        statuses[taskId] = "completed";
      }
      new EventRetentionService({
        eventStore: store,
        retentionDays: RETENTION_DAYS,
        batchTasks: BATCH,
        now: () => new Date(dayBase + MS_PER_DAY),
        getTaskStatus: statusLookup(statuses),
      }).run();
    }

    const underCompacted = countRows(db, "task_events");
    const ceiling = (RETENTION_DAYS + 1) * EVENTS_PER_DAY * 1.1;
    expect(underCompacted).toBeGreaterThan(ceiling);

    db.close();
    store.close();
  });
});
