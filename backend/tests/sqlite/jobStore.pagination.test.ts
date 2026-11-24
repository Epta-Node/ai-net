/**
 * Tests for issue #650: Admin job listing pageSize is unclamped and NaN-prone.
 * Store-level (AC1, AC2, AC4) tests — run against real SQLite via jest.sqlite.config.js.
 *
 * NOTE: These tests require the native better-sqlite3 binary, which must be
 * compiled for the target platform. Run with:
 *   npm run test:sqlite
 *
 * In environments where the native binary is unavailable (e.g. Node v24 ABI
 * mismatch), see tests/jobStore.pagination.clamp.test.ts for the pure-logic
 * clamp tests that run under the default jest config.
 *
 * Acceptance criteria:
 *  AC1: pageSize=-1 is clamped to 1 in the store (no LIMIT -1 sent to SQLite)
 *  AC2: pageSize=1e9 returns at most 100 rows (clamped to 100)
 *  AC4: The clamp lives in the store so every caller is protected
 */

import Database from "better-sqlite3";
import { createJobStore, type Job, type JobStore } from "../../src/queue/jobStore";

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeJob(overrides: Partial<Job> = {}): Job {
  const now = new Date().toISOString();
  return {
    id: `job_${Math.random().toString(36).slice(2, 10)}`,
    taskId: `task_${Math.random().toString(36).slice(2, 10)}`,
    type: "execute_task",
    payload: {},
    status: "pending",
    priority: "normal",
    progress: 0,
    attempts: 0,
    maxAttempts: 3,
    nextRunAt: now,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

// ── AC4: Store-level clamp ────────────────────────────────────────────────────

describe("jobStore.list() — pageSize / page clamping (AC4)", () => {
  let db: Database.Database;
  let store: JobStore;

  beforeEach(() => {
    db = new Database(":memory:");
    store = createJobStore(db);

    // Insert 10 jobs so pagination results are observable.
    for (let i = 0; i < 10; i++) {
      store.insert(makeJob());
    }
  });

  afterEach(() => {
    db.close();
  });

  // AC1: negative pageSize must not produce LIMIT -1 (unbounded SQLite scan)
  it("AC1: clamps pageSize=-1 to 1 and returns exactly 1 job", () => {
    const result = store.list({ pageSize: -1 });
    expect(result.jobs).toHaveLength(1);
    expect(result.total).toBe(10);
  });

  it("AC1: clamps pageSize=0 to 1 and returns exactly 1 job", () => {
    const result = store.list({ pageSize: 0 });
    expect(result.jobs).toHaveLength(1);
  });

  // AC2: enormous pageSize must be capped at 100
  it("AC2: clamps pageSize=1e9 to 100 and returns at most 10 jobs (all that exist)", () => {
    const result = store.list({ pageSize: 1e9 });
    // Only 10 jobs in the DB, so we get 10 back — but the store must have
    // issued LIMIT 100 instead of LIMIT 1000000000.
    expect(result.jobs.length).toBeLessThanOrEqual(100);
    expect(result.jobs).toHaveLength(10); // all 10 rows fit within the 100-cap
  });

  it("AC2: clamps pageSize=200 to exactly 100", () => {
    // Insert 110 more so we have 120 total — enough to tell 100 from 200.
    for (let i = 0; i < 110; i++) {
      store.insert(makeJob());
    }
    const result = store.list({ pageSize: 200 });
    expect(result.jobs).toHaveLength(100);
  });

  // AC4: NaN (what Number("abc") produces) must be handled safely
  it("AC4: clamps pageSize=NaN to 1 without throwing", () => {
    expect(() => store.list({ pageSize: NaN })).not.toThrow();
    const result = store.list({ pageSize: NaN });
    expect(result.jobs).toHaveLength(1);
  });

  it("AC4: clamps page=NaN to 1 without throwing", () => {
    expect(() => store.list({ page: NaN })).not.toThrow();
    const result = store.list({ page: NaN });
    expect(result.jobs).toHaveLength(10); // default pageSize=50, all 10 fit
  });

  it("AC4: clamps page=-5 to 1 (no negative offset)", () => {
    const result = store.list({ page: -5 });
    // page=1, pageSize default=50 → offset 0 → all 10 rows
    expect(result.jobs).toHaveLength(10);
  });

  it("AC4: page=1 and pageSize=5 returns exactly 5 jobs", () => {
    const result = store.list({ page: 1, pageSize: 5 });
    expect(result.jobs).toHaveLength(5);
  });

  it("AC4: page=2 and pageSize=5 returns the next 5 jobs", () => {
    const p1 = store.list({ page: 1, pageSize: 5 });
    const p2 = store.list({ page: 2, pageSize: 5 });
    expect(p1.jobs).toHaveLength(5);
    expect(p2.jobs).toHaveLength(5);
    const p1Ids = new Set(p1.jobs.map((j) => j.id));
    const p2Ids = new Set(p2.jobs.map((j) => j.id));
    // No overlap between pages
    for (const id of p2Ids) {
      expect(p1Ids.has(id)).toBe(false);
    }
  });
});
