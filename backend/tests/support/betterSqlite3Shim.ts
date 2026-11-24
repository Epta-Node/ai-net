/**
 * A dependency-free, `better-sqlite3`-compatible test driver backed by Node's
 * built-in `node:sqlite`.
 *
 * Why this exists
 * ---------------
 * `better-sqlite3` is a native addon. The default Jest project
 * (`backend/jest.config.js`) therefore maps it to the inert stub in
 * `backend/__mocks__/better-sqlite3.js`, which answers every query with
 * `undefined`/`{ changes: 0 }` — it cannot observe a conditional `UPDATE`,
 * `RETURNING`, transactions or row counts. The real addon is only wired up in
 * `jest.sqlite.config.js`, and that project is not part of the CI workflow.
 *
 * Issue #648 is *precisely* a conditional `UPDATE` ("reclaim only the jobs whose
 * lease has lapsed"), so the tests for it must run against genuine SQL in the
 * default Jest project. `node:sqlite` ships with Node 22.5+ — including the
 * Node 24 that CI pins — so these tests get real SQLite on every platform,
 * with no native build step.
 *
 * Scope
 * -----
 * Only the slice of the `better-sqlite3` API used by `src/queue/jobStore.ts` is
 * implemented: `pragma`, `exec`, `prepare().run/get/all`, `transaction()`
 * (including `.immediate()`), `on` and `close`. Not implemented: streaming,
 * `.raw()`, `.columns()`, `.serialize()`, user-defined functions and
 * extensions — the job store uses none of them.
 *
 * Known behavioural differences from `better-sqlite3`:
 *  - `pragma(sql)` executes `PRAGMA <sql>` and returns `undefined` rather than
 *    the resulting row. Nothing in the job store reads the value.
 *  - Rows come back as null-prototype objects, which is fine for property
 *    access and `JSON.parse`/`JSON.stringify`.
 *  - `run()` normalises `changes`/`lastInsertRowid` to `number`, matching
 *    `better-sqlite3` (node:sqlite may report `bigint`).
 */

import type BetterSqlite3 from "better-sqlite3";

interface NodeSqliteStatement {
  run(...params: unknown[]): { changes: number | bigint; lastInsertRowid: number | bigint };
  get(...params: unknown[]): Record<string, unknown> | undefined;
  all(...params: unknown[]): Record<string, unknown>[];
}

interface NodeSqliteDatabase {
  exec(sql: string): void;
  prepare(sql: string): NodeSqliteStatement;
  close(): void;
}

// Resolved lazily so this module is only pulled in by tests that need SQL.
/* eslint-disable @typescript-eslint/no-var-requires */
const { DatabaseSync } = require("node:sqlite") as {
  DatabaseSync: new (location: string) => NodeSqliteDatabase;
};

type TransactionMode = "DEFERRED" | "IMMEDIATE" | "EXCLUSIVE";

/** Statement facade exposing the methods `jobStore.ts` calls. */
class ShimStatement {
  constructor(private readonly statement: NodeSqliteStatement) {}

  run(...params: unknown[]): { changes: number; lastInsertRowid: number } {
    const result = this.statement.run(...params);
    return {
      changes: Number(result.changes),
      lastInsertRowid: Number(result.lastInsertRowid),
    };
  }

  get(...params: unknown[]): unknown {
    return this.statement.get(...params);
  }

  all(...params: unknown[]): unknown[] {
    return this.statement.all(...params);
  }
}

/**
 * In-memory/file SQLite database with a `better-sqlite3`-shaped API.
 *
 * Transactions are real: `transaction(fn)` wraps `fn` in `BEGIN`/`COMMIT`, and
 * the returned function's `.immediate()` (used by the job store's atomic claim)
 * opens the transaction with `BEGIN IMMEDIATE` so it takes the write lock up
 * front, exactly like `better-sqlite3` does.
 */
class ShimDatabase {
  private readonly db: NodeSqliteDatabase;

  constructor(location: string) {
    this.db = new DatabaseSync(location);
  }

  pragma(sql: string): undefined {
    this.db.exec(`PRAGMA ${sql}`);
    return undefined;
  }

  exec(sql: string): this {
    this.db.exec(sql);
    return this;
  }

  prepare(sql: string): ShimStatement {
    return new ShimStatement(this.db.prepare(sql));
  }

  transaction<T extends (...args: never[]) => unknown>(
    fn: T
  ): T & { immediate: T; deferred: T; exclusive: T } {
    const withMode = (mode: TransactionMode) =>
      ((...args: Parameters<T>) => {
        this.db.exec(`BEGIN ${mode}`);
        try {
          const result = fn(...args);
          this.db.exec("COMMIT");
          return result;
        } catch (err) {
          try {
            this.db.exec("ROLLBACK");
          } catch {
            // The failure may have rolled the transaction back already.
          }
          throw err;
        }
      }) as T;

    const wrapped = withMode("DEFERRED") as T & {
      immediate: T;
      deferred: T;
      exclusive: T;
    };
    wrapped.immediate = withMode("IMMEDIATE");
    wrapped.deferred = withMode("DEFERRED");
    wrapped.exclusive = withMode("EXCLUSIVE");
    return wrapped;
  }

  /** No-op: the job store only registers an error listener. */
  on(_event: string, _listener: (...args: unknown[]) => void): this {
    return this;
  }

  close(): this {
    this.db.close();
    return this;
  }
}

/**
 * Open an isolated SQLite database with the `better-sqlite3` API surface the
 * job store depends on. `location` is a file path, or `:memory:` for a
 * throwaway database.
 */
export function openSqliteDatabase(location: string): BetterSqlite3.Database {
  return new ShimDatabase(location) as unknown as BetterSqlite3.Database;
}
