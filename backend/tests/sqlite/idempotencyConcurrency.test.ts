/**
 * Idempotency reservation — real-SQLite regression tests (issue #658).
 *
 * The default `jest.config.js` maps `better-sqlite3` to a no-op mock whose
 * `run()` always reports `changes: 1` and whose `get()` ignores its arguments,
 * so it cannot observe the primitive this fix depends on: `INSERT OR IGNORE`
 * against a composite primary key. This file therefore requires the real native
 * module by absolute path — the same technique as
 * `tests/sqlite/agentCapabilities.test.ts` — so the suite runs on genuine
 * SQLite under both the default project and `jest.sqlite.config.js`
 * (`npm run test:sqlite`).
 *
 * The bug under test: the middleware used to look a key up and only write the
 * response *after* the handler returned. Two concurrent requests sharing a key
 * both missed the lookup, both ran the handler, and the second write silently
 * overwrote the first — so the store looked correct while the side effect
 * happened twice. The fix reserves the `(wallet, key)` slot before dispatch.
 */

// Bypass the moduleNameMapper stub — require the real native module directly.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const RealDatabase = require("../../node_modules/better-sqlite3") as typeof import("better-sqlite3");

import request from "supertest";
import express, { Router, Request, Response, NextFunction } from "express";
import { AppError } from "../../src/errors";
import { createIdempotencyStore, type IdempotencyStore } from "../../src/services/idempotency";
import { createIdempotencyMiddleware } from "../../src/api/middleware/idempotency";

type RealDb = InstanceType<typeof RealDatabase>;

const WALLET_A = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const WALLET_B = "GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";

/** How many requests race for one key in the concurrency tests. */
const CONCURRENCY = 20;

/**
 * Minimal stand-in for `errorHandler`.
 *
 * `jest.sqlite.config.js` runs ts-jest with diagnostics enabled, and importing
 * the real central error handler would pull in a pre-existing, unrelated type
 * error in `src/api/middleware/errorHandler.ts` (TS7053) and fail this suite
 * before a single assertion runs. This keeps the file focused on the
 * reservation behaviour; the canonical error envelope itself is covered by
 * `tests/idempotency.test.ts`, which does use the real handler.
 */
function errorHandler(err: unknown, _req: Request, res: Response, _next: NextFunction): void {
  const statusCode = err instanceof AppError ? err.statusCode : 500;
  const code = err instanceof AppError ? err.code : "INTERNAL_ERROR";
  res.status(statusCode).json({ error: { code, message: (err as Error)?.message } });
}

describe("idempotency reservation on real SQLite (#658)", () => {
  let db: RealDb;
  let store: IdempotencyStore;

  beforeEach(() => {
    db = new RealDatabase(":memory:");
    store = createIdempotencyStore(db, { cleanupIntervalMs: 0, pendingTtlMs: 30_000 });
  });

  afterEach(() => {
    store.close();
  });

  // ── AC1 / AC2 at the store level ───────────────────────────────────────────

  it("grants a reservation to exactly one of twenty concurrent callers", () => {
    const results = Array.from({ length: CONCURRENCY }, () => store.reserve(WALLET_A, "race-key"));

    const reserved = results.filter((r) => r.status === "reserved");
    const conflicted = results.filter((r) => r.status === "conflict");

    expect(reserved).toHaveLength(1);
    expect(conflicted).toHaveLength(CONCURRENCY - 1);

    // And only one row exists for the slot.
    const { c } = db
      .prepare("SELECT COUNT(*) as c FROM idempotency_keys WHERE wallet = ? AND key = ?")
      .get(WALLET_A, "race-key") as { c: number };
    expect(c).toBe(1);
  });

  it("does not treat an empty lookup as a free slot", () => {
    // The old check-then-execute logic stopped here and let every caller
    // through; the reservation is what makes the slot exclusive.
    expect(store.get(WALLET_A, "race-key")).toBeUndefined();

    const first = store.reserve(WALLET_A, "race-key");
    expect(first.status).toBe("reserved");

    expect(store.reserve(WALLET_A, "race-key").status).toBe("conflict");
  });

  it("replays once the reservation has been promoted to a completed record", () => {
    const reservation = store.reserve(WALLET_A, "done-key");
    expect(reservation.status).toBe("reserved");
    expect(reservation.reservationId).toBeDefined();

    store.complete(WALLET_A, "done-key", reservation.reservationId!, 201, { taskId: "task_1" });

    const replay = store.reserve(WALLET_A, "done-key");
    expect(replay.status).toBe("replay");
    expect(replay.entry?.statusCode).toBe(201);
    expect(JSON.parse(replay.entry!.responseBody!)).toEqual({ taskId: "task_1" });
  });

  it("records a pending entry with no response before completion", () => {
    store.reserve(WALLET_A, "pending-key");
    const entry = store.get(WALLET_A, "pending-key");

    expect(entry?.status).toBe("pending");
    expect(entry?.statusCode).toBeUndefined();
    expect(entry?.responseBody).toBeUndefined();
  });

  it("releases a reservation so the key can be retried", () => {
    const reservation = store.reserve(WALLET_A, "retry-key");
    store.release(WALLET_A, "retry-key", reservation.reservationId!);

    expect(store.get(WALLET_A, "retry-key")).toBeUndefined();
    expect(store.reserve(WALLET_A, "retry-key").status).toBe("reserved");
  });

  // ── Fencing token ──────────────────────────────────────────────────────────

  it("refuses to promote a reservation that has already been superseded", () => {
    const stale = store.reserve(WALLET_A, "fence-key");
    store.release(WALLET_A, "fence-key", stale.reservationId!);
    const fresh = store.reserve(WALLET_A, "fence-key");

    // The original handler finally returns and tries to store its response.
    store.complete(WALLET_A, "fence-key", stale.reservationId!, 201, { taskId: "stale" });

    // The newer reservation is untouched.
    expect(store.get(WALLET_A, "fence-key")?.status).toBe("pending");
    expect(fresh.reservationId).not.toBe(stale.reservationId);
  });

  it("refuses to release a reservation that has already been superseded", () => {
    const stale = store.reserve(WALLET_A, "fence-key-2");
    store.release(WALLET_A, "fence-key-2", stale.reservationId!);
    const fresh = store.reserve(WALLET_A, "fence-key-2");

    store.release(WALLET_A, "fence-key-2", stale.reservationId!);

    expect(store.get(WALLET_A, "fence-key-2")?.status).toBe("pending");
    expect(fresh.status).toBe("reserved");
  });

  // ── AC3: wallet scoping ────────────────────────────────────────────────────

  it("scopes keys by wallet so one wallet cannot replay another's response", () => {
    const a = store.reserve(WALLET_A, "same-key");
    store.complete(WALLET_A, "same-key", a.reservationId!, 201, { taskId: "wallet_a_task" });

    // Wallet B reuses the same key value and must get its own reservation.
    const b = store.reserve(WALLET_B, "same-key");
    expect(b.status).toBe("reserved");
    expect(b.status).not.toBe("replay");

    store.complete(WALLET_B, "same-key", b.reservationId!, 201, { taskId: "wallet_b_task" });

    expect(JSON.parse(store.reserve(WALLET_A, "same-key").entry!.responseBody!)).toEqual({
      taskId: "wallet_a_task",
    });
    expect(JSON.parse(store.reserve(WALLET_B, "same-key").entry!.responseBody!)).toEqual({
      taskId: "wallet_b_task",
    });
  });

  it("deletes and looks up entries per (wallet, key)", () => {
    const a = store.reserve(WALLET_A, "scoped");
    const b = store.reserve(WALLET_B, "scoped");
    store.complete(WALLET_A, "scoped", a.reservationId!, 200, { who: "a" });
    store.complete(WALLET_B, "scoped", b.reservationId!, 200, { who: "b" });

    store.delete(WALLET_A, "scoped");

    expect(store.get(WALLET_A, "scoped")).toBeUndefined();
    expect(store.get(WALLET_B, "scoped")).toBeDefined();
  });

  // ── TTL and cleanup ────────────────────────────────────────────────────────

  it("expires a reservation once the pending TTL has passed", () => {
    const shortLived = createIdempotencyStore(db, { cleanupIntervalMs: 0, pendingTtlMs: 1 });
    const first = shortLived.reserve(WALLET_A, "stale-pending");
    expect(first.status).toBe("reserved");

    const start = Date.now();
    while (Date.now() - start < 5) {
      /* spin past the 1 ms TTL */
    }

    // An abandoned reservation must not block the key forever.
    expect(shortLived.reserve(WALLET_A, "stale-pending").status).toBe("reserved");
    shortLived.stopCleanup();
  });

  it("removes expired entries and reports the count", () => {
    const shortLived = createIdempotencyStore(db, { cleanupIntervalMs: 0, pendingTtlMs: 1 });
    for (let i = 0; i < 20; i++) {
      shortLived.reserve(WALLET_A, `bounded-${i}`);
    }

    const start = Date.now();
    while (Date.now() - start < 5) {
      /* spin */
    }

    expect(shortLived.cleanup()).toBe(20);
    const { c } = db.prepare("SELECT COUNT(*) as c FROM idempotency_keys").get() as { c: number };
    expect(c).toBe(0);
    shortLived.stopCleanup();
  });

  it("keeps a completed record alive across a sweep", () => {
    const reservation = store.reserve(WALLET_A, "long-lived");
    store.complete(WALLET_A, "long-lived", reservation.reservationId!, 201, { ok: true });

    // A sweep must not take a freshly completed record: promotion resets the
    // expiry to the full TTL, which is far beyond the pending TTL.
    expect(store.cleanup()).toBe(0);
    expect(store.get(WALLET_A, "long-lived")?.status).toBe("completed");
    expect(store.reserve(WALLET_A, "long-lived").status).toBe("replay");
  });

  // ── Legacy schema upgrade ──────────────────────────────────────────────────

  it("upgrades a pre-#658 unscoped table instead of replaying across wallets", () => {
    const legacy = new RealDatabase(":memory:");
    legacy.exec(`
      CREATE TABLE idempotency_keys (
        key         TEXT PRIMARY KEY,
        status_code INTEGER NOT NULL,
        body        TEXT    NOT NULL,
        created_at  TEXT    NOT NULL,
        expires_at  TEXT    NOT NULL
      );
    `);
    legacy
      .prepare(
        "INSERT INTO idempotency_keys (key, status_code, body, created_at, expires_at) VALUES (?, ?, ?, ?, ?)",
      )
      .run(
        "legacy-key",
        201,
        JSON.stringify({ taskId: "someone_elses_task" }),
        new Date().toISOString(),
        new Date(Date.now() + 3_600_000).toISOString(),
      );

    const upgraded = createIdempotencyStore(legacy, { cleanupIntervalMs: 0 });
    const columns = legacy.prepare("PRAGMA table_info(idempotency_keys)").all() as {
      name: string;
    }[];

    expect(columns.map((c) => c.name)).toEqual(
      expect.arrayContaining(["wallet", "key", "status", "reservation_id"]),
    );
    // The unscoped legacy row is gone, so it can no longer be replayed.
    expect(upgraded.get(WALLET_A, "legacy-key")).toBeUndefined();
    expect(upgraded.get(WALLET_B, "legacy-key")).toBeUndefined();
    // And the slot is genuinely free again.
    expect(upgraded.reserve(WALLET_A, "legacy-key").status).toBe("reserved");

    const tables = legacy
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all() as { name: string }[];
    expect(tables.map((t) => t.name)).not.toContain("idempotency_keys_legacy");

    upgraded.close();
  });

  it("is a no-op when the wallet-scoped table already exists", () => {
    const existing = new RealDatabase(":memory:");
    const first = createIdempotencyStore(existing, { cleanupIntervalMs: 0 });
    const reservation = first.reserve(WALLET_A, "persisted");
    first.complete(WALLET_A, "persisted", reservation.reservationId!, 201, { ok: true });
    first.stopCleanup();

    // Re-running the schema against a store that already has the current shape
    // must not disturb the stored record.
    const reopened = createIdempotencyStore(existing, { cleanupIntervalMs: 0 });
    expect(reopened.reserve(WALLET_A, "persisted").status).toBe("replay");
    reopened.close();
  });
});

// ---------------------------------------------------------------------------
// End-to-end: the middleware over the real store
// ---------------------------------------------------------------------------

describe("idempotency middleware over the real store (#658)", () => {
  let db: RealDb;
  let store: IdempotencyStore;
  let app: express.Express;
  let handlerCallCount: number;

  beforeEach(() => {
    db = new RealDatabase(":memory:");
    store = createIdempotencyStore(db, { cleanupIntervalMs: 0, pendingTtlMs: 30_000 });
    handlerCallCount = 0;

    app = express();
    app.use(express.json());

    const router = Router();
    router.post(
      "/tasks",
      createIdempotencyMiddleware(store),
      async (_req: Request, res: Response) => {
        handlerCallCount += 1;
        // Snapshot the id now: reading the shared counter after the await
        // below would make every concurrent response report the same task.
        const taskId = `task_${handlerCallCount}`;
        // Yield so every racing request is genuinely in flight at the same
        // time, which is the condition the old check-then-execute lost.
        await new Promise((resolve) => setTimeout(resolve, 25));
        res.status(201).json({ taskId, status: "queued" });
      },
    );
    app.use("/api", router);
    app.use(errorHandler);
  });

  afterEach(() => {
    store.close();
  });

  it("performs exactly one side effect for twenty parallel requests sharing a key (AC1)", async () => {
    const responses = await Promise.all(
      Array.from({ length: CONCURRENCY }, () =>
        request(app)
          .post("/api/tasks")
          .set("Idempotency-Key", "parallel-key")
          .set("walletpublickey", WALLET_A)
          .send({ prompt: "hello" }),
      ),
    );

    // The whole point: one execution, not twenty.
    expect(handlerCallCount).toBe(1);

    const created = responses.filter((r) => r.status === 201);
    const conflicts = responses.filter((r) => r.status === 409);

    expect(created).toHaveLength(1);
    expect(conflicts).toHaveLength(CONCURRENCY - 1);

    // Every response agrees on the one task that was created.
    const taskIds = new Set(responses.map((r) => r.body?.taskId).filter(Boolean));
    expect([...taskIds]).toEqual(["task_1"]);

    // A later retry still replays the single response.
    const retry = await request(app)
      .post("/api/tasks")
      .set("Idempotency-Key", "parallel-key")
      .set("walletpublickey", WALLET_A)
      .send({ prompt: "hello" });
    expect(retry.status).toBe(201);
    expect(retry.body.taskId).toBe("task_1");
    expect(handlerCallCount).toBe(1);
  });

  it("answers a concurrent duplicate with 409 or a replay, never a second execution (AC2)", async () => {
    const responses = await Promise.all(
      Array.from({ length: 5 }, () =>
        request(app)
          .post("/api/tasks")
          .set("Idempotency-Key", "dup-key")
          .set("walletpublickey", WALLET_A)
          .send({ prompt: "hello" }),
      ),
    );

    expect(handlerCallCount).toBe(1);
    for (const res of responses) {
      expect([201, 409]).toContain(res.status);
      if (res.status === 409) {
        expect(res.body.error.code).toBe("REQUEST_IN_PROGRESS");
      }
    }
  });

  it("executes once per wallet when two wallets share a key (AC3)", async () => {
    const [a, b] = await Promise.all([
      request(app)
        .post("/api/tasks")
        .set("Idempotency-Key", "shared")
        .set("walletpublickey", WALLET_A)
        .send({ prompt: "hello" }),
      request(app)
        .post("/api/tasks")
        .set("Idempotency-Key", "shared")
        .set("walletpublickey", WALLET_B)
        .send({ prompt: "hello" }),
    ]);

    expect(a.status).toBe(201);
    expect(b.status).toBe(201);
    expect(a.body.taskId).not.toBe(b.body.taskId);
    expect(handlerCallCount).toBe(2);

    // Replays are also isolated per wallet.
    const replayA = await request(app)
      .post("/api/tasks")
      .set("Idempotency-Key", "shared")
      .set("walletpublickey", WALLET_A)
      .send({ prompt: "hello" });
    const replayB = await request(app)
      .post("/api/tasks")
      .set("Idempotency-Key", "shared")
      .set("walletpublickey", WALLET_B)
      .send({ prompt: "hello" });

    expect(replayA.body.taskId).toBe(a.body.taskId);
    expect(replayB.body.taskId).toBe(b.body.taskId);
    expect(handlerCallCount).toBe(2);
  });

  it("rejects an oversized key with 400 without executing the handler (AC4)", async () => {
    const res = await request(app)
      .post("/api/tasks")
      .set("Idempotency-Key", "x".repeat(256))
      .set("walletpublickey", WALLET_A)
      .send({ prompt: "hello" });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
    expect(handlerCallCount).toBe(0);

    const { c } = db.prepare("SELECT COUNT(*) as c FROM idempotency_keys").get() as { c: number };
    expect(c).toBe(0);
  });

  it("releases the reservation after a failed request so the key stays retryable", async () => {
    const failing = express();
    failing.use(express.json());
    const router = Router();
    router.post("/tasks", createIdempotencyMiddleware(store), (_req, res) => {
      handlerCallCount += 1;
      res.status(500).json({ error: "upstream down" });
    });
    failing.use("/api", router);
    failing.use(errorHandler);

    const first = await request(failing)
      .post("/api/tasks")
      .set("Idempotency-Key", "flaky")
      .set("walletpublickey", WALLET_A)
      .send({});
    expect(first.status).toBe(500);

    expect(store.get(WALLET_A, "flaky")).toBeUndefined();

    const second = await request(failing)
      .post("/api/tasks")
      .set("Idempotency-Key", "flaky")
      .set("walletpublickey", WALLET_A)
      .send({});
    expect(second.status).toBe(500);
    expect(handlerCallCount).toBe(2);
  });
});
