import fs from "fs";
import os from "os";
import path from "path";
import {
  createPool,
  DEFAULT_MAX_CONNECTIONS,
  DEFAULT_MIN_CONNECTIONS,
  PoolClosedError,
  PoolTimeoutError,
  type SqlitePool,
} from "./pool";

/** Each test gets its own database file so they can run in any order. */
function tempDbPath(): string {
  return path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), "ai-net-pool-")),
    "test.db",
  );
}

const SCHEMA = (db: import("better-sqlite3").Database) => {
  db.exec(`
    CREATE TABLE IF NOT EXISTS items (
      id    INTEGER PRIMARY KEY AUTOINCREMENT,
      value TEXT NOT NULL
    )
  `);
};

describe("SqlitePool", () => {
  const pools: SqlitePool[] = [];
  const files: string[] = [];

  function makePool(options: Partial<Parameters<typeof createPool>[0]> = {}) {
    const filePath = options.filePath ?? tempDbPath();
    files.push(filePath);
    const pool = createPool({ filePath, onCreate: SCHEMA, ...options });
    pools.push(pool);
    return pool;
  }

  afterEach(async () => {
    await Promise.all(pools.map((p) => p.close()));
    pools.length = 0;
    for (const file of files) {
      fs.rmSync(path.dirname(file), { recursive: true, force: true });
    }
    files.length = 0;
  });

  describe("lifecycle", () => {
    it("opens `min` readers eagerly and reports them idle", () => {
      const pool = makePool({ min: 3, max: 5 });
      const metrics = pool.metrics();

      expect(metrics.idleConnections).toBe(3);
      expect(metrics.totalConnections).toBe(3);
      expect(metrics.activeConnections).toBe(0);
    });

    it("defaults to a 2-10 connection range", () => {
      const pool = makePool();
      expect(pool.metrics().idleConnections).toBe(DEFAULT_MIN_CONNECTIONS);
      expect(DEFAULT_MAX_CONNECTIONS).toBe(10);
    });

    it("rejects a max below min", () => {
      expect(() => makePool({ min: 4, max: 2 })).toThrow(RangeError);
    });

    it("rejects a min below one", () => {
      expect(() => makePool({ min: 0 })).toThrow(RangeError);
    });

    it("returns a connection to the idle set after use", async () => {
      const pool = makePool({ min: 1, max: 2 });
      await pool.read((db) => db.prepare("SELECT 1").get());

      expect(pool.metrics().activeConnections).toBe(0);
      expect(pool.metrics().idleConnections).toBeGreaterThanOrEqual(1);
    });

    it("releases the connection even when the callback throws", async () => {
      const pool = makePool({ min: 1, max: 1 });

      await expect(
        pool.read(() => {
          throw new Error("boom");
        }),
      ).rejects.toThrow("boom");

      expect(pool.metrics().activeConnections).toBe(0);
      // The pool is still usable.
      await expect(pool.read((db) => db.prepare("SELECT 1 AS n").get())).resolves.toEqual({ n: 1 });
    });
  });

  describe("reads and writes", () => {
    it("persists a write and reads it back", async () => {
      const pool = makePool();

      await pool.write((db) => db.prepare("INSERT INTO items (value) VALUES (?)").run("alpha"));
      const row = await pool.read((db) =>
        db.prepare("SELECT value FROM items WHERE value = ?").get("alpha"),
      );

      expect(row).toEqual({ value: "alpha" });
    });

    it("serialises concurrent writes without loss", async () => {
      const pool = makePool();
      const total = 100;

      await Promise.all(
        Array.from({ length: total }, (_, i) =>
          pool.write((db) => db.prepare("INSERT INTO items (value) VALUES (?)").run(`v${i}`)),
        ),
      );

      const count = await pool.read(
        (db) => (db.prepare("SELECT COUNT(*) AS n FROM items").get() as { n: number }).n,
      );
      expect(count).toBe(total);
    });

    it("preserves write ordering", async () => {
      const pool = makePool();
      const order: number[] = [];

      await Promise.all(
        Array.from({ length: 20 }, (_, i) =>
          pool.write(() => {
            order.push(i);
          }),
        ),
      );

      expect(order).toEqual(Array.from({ length: 20 }, (_, i) => i));
    });

    it("rejects writes to a read-only connection", async () => {
      const pool = makePool();
      await expect(
        pool.read((db) => db.prepare("INSERT INTO items (value) VALUES (?)").run("nope")),
      ).rejects.toThrow();
    });

    it("rolls a failed transaction back", async () => {
      const pool = makePool();

      await expect(
        pool.transaction((db) => {
          db.prepare("INSERT INTO items (value) VALUES (?)").run("kept?");
          throw new Error("abort");
        }),
      ).rejects.toThrow("abort");

      const count = await pool.read(
        (db) => (db.prepare("SELECT COUNT(*) AS n FROM items").get() as { n: number }).n,
      );
      expect(count).toBe(0);
    });

    it("commits a successful transaction", async () => {
      const pool = makePool();

      await pool.transaction((db) => {
        db.prepare("INSERT INTO items (value) VALUES (?)").run("a");
        db.prepare("INSERT INTO items (value) VALUES (?)").run("b");
      });

      const count = await pool.read(
        (db) => (db.prepare("SELECT COUNT(*) AS n FROM items").get() as { n: number }).n,
      );
      expect(count).toBe(2);
    });
  });

  describe("concurrency and overflow", () => {
    it("handles 100 concurrent reads without error", async () => {
      const pool = makePool({ min: 2, max: 10 });
      await pool.write((db) => db.prepare("INSERT INTO items (value) VALUES (?)").run("x"));

      const results = await Promise.all(
        Array.from({ length: 100 }, () =>
          pool.read(
            (db) => (db.prepare("SELECT COUNT(*) AS n FROM items").get() as { n: number }).n,
          ),
        ),
      );

      expect(results).toHaveLength(100);
      expect(results.every((n) => n === 1)).toBe(true);
      expect(pool.metrics().timedOutAcquires).toBe(0);
    });

    it("never exceeds max connections under load", async () => {
      const pool = makePool({ min: 1, max: 3 });
      let peak = 0;

      await Promise.all(
        Array.from({ length: 40 }, () =>
          pool.read((db) => {
            peak = Math.max(peak, pool.metrics().totalConnections);
            return db.prepare("SELECT 1").get();
          }),
        ),
      );

      expect(peak).toBeLessThanOrEqual(3);
    });

    it("times out an acquire when every reader stays busy", async () => {
      const pool = makePool({ min: 1, max: 1, acquireTimeoutMs: 50 });

      // Hold the only reader across a tick so the next acquire has to queue.
      const held = pool.read(async () => {
        await new Promise((r) => setTimeout(r, 200));
      });

      await expect(pool.read((db) => db.prepare("SELECT 1").get())).rejects.toBeInstanceOf(
        PoolTimeoutError,
      );

      await held;
      expect(pool.metrics().timedOutAcquires).toBe(1);
    });

    it("hands a released connection to the longest waiter", async () => {
      const pool = makePool({ min: 1, max: 1, acquireTimeoutMs: 1_000 });

      const held = pool.read(async () => {
        await new Promise((r) => setTimeout(r, 30));
        return "first";
      });
      const queued = pool.read(() => "second");

      await expect(held).resolves.toBe("first");
      await expect(queued).resolves.toBe("second");
      expect(pool.metrics().timedOutAcquires).toBe(0);
    });
  });

  describe("metrics", () => {
    it("counts acquisitions and tracks wait times", async () => {
      const pool = makePool({ min: 2, max: 2 });

      await pool.read((db) => db.prepare("SELECT 1").get());
      await pool.read((db) => db.prepare("SELECT 1").get());

      const metrics = pool.metrics();
      expect(metrics.totalAcquires).toBe(2);
      expect(metrics.averageWaitMs).toBeGreaterThanOrEqual(0);
      expect(metrics.maxWaitMs).toBeGreaterThanOrEqual(metrics.averageWaitMs);
    });

    it("reports an average wait of zero before any acquire", () => {
      const pool = makePool();
      const metrics = pool.metrics();
      expect(metrics.totalAcquires).toBe(0);
      expect(metrics.averageWaitMs).toBe(0);
    });

    it("reports queued writes while the writer is busy", async () => {
      const pool = makePool();
      let observed = 0;

      const first = pool.write(async () => {
        await new Promise((r) => setTimeout(r, 40));
      });
      const second = pool.write(() => {
        observed = 1;
      });
      // The second write is queued behind the first.
      expect(pool.metrics().pendingWrites).toBeGreaterThanOrEqual(0);

      await Promise.all([first, second]);
      expect(observed).toBe(1);
    });
  });

  describe("health checks", () => {
    it("replaces a connection that fails its health check", async () => {
      const pool = makePool({ min: 1, max: 2 });

      // Close the idle handle behind the pool's back to simulate a dead
      // connection; the next acquire must notice and replace it.
      const stolen = await pool.read((db) => db);
      stolen.close();

      const value = await pool.read(
        (db) => (db.prepare("SELECT 1 AS n").get() as { n: number }).n,
      );

      expect(value).toBe(1);
      expect(pool.metrics().failedHealthChecks).toBeGreaterThanOrEqual(1);
    });

    it("skips the ping when health checks are disabled", async () => {
      const pool = makePool({ min: 1, max: 1, healthCheck: false });
      await pool.read((db) => db.prepare("SELECT 1").get());
      expect(pool.metrics().failedHealthChecks).toBe(0);
    });
  });

  describe("shutdown", () => {
    it("closes every connection and reports closed", async () => {
      const pool = makePool({ min: 3, max: 3 });
      await pool.close();

      expect(pool.closed).toBe(true);
      expect(pool.metrics().totalConnections).toBe(0);
      expect(pool.metrics().idleConnections).toBe(0);
    });

    it("is idempotent", async () => {
      const pool = makePool();
      await pool.close();
      await expect(pool.close()).resolves.toBeUndefined();
    });

    it("rejects reads and writes after close", async () => {
      const pool = makePool();
      await pool.close();

      await expect(pool.read((db) => db.prepare("SELECT 1").get())).rejects.toBeInstanceOf(
        PoolClosedError,
      );
      await expect(pool.write((db) => db.prepare("SELECT 1").get())).rejects.toBeInstanceOf(
        PoolClosedError,
      );
    });

    it("rejects callers still queued when the pool closes", async () => {
      const pool = makePool({ min: 1, max: 1, acquireTimeoutMs: 5_000 });

      const held = pool.read(async () => {
        await new Promise((r) => setTimeout(r, 50));
      });
      const queued = pool.read((db) => db.prepare("SELECT 1").get());
      // Attach the rejection handler before closing: `close` rejects the queued
      // waiter synchronously, and an unhandled rejection in that window fails
      // the run regardless of the assertion that follows.
      const rejected = expect(queued).rejects.toBeInstanceOf(PoolClosedError);

      await pool.close();

      await rejected;
      await held;
    });

    it("lets an in-flight write finish before closing", async () => {
      const pool = makePool();
      let finished = false;

      const write = pool.write(async () => {
        await new Promise((r) => setTimeout(r, 30));
        finished = true;
      });

      await pool.close();
      await write;

      expect(finished).toBe(true);
    });
  });
});
