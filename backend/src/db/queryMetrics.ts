/**
 * Per-query timing for the SQLite pools (issue #807).
 *
 * Every statement run through a named pool is timed. Timings feed three things:
 *
 *  • `db_query_duration_seconds` — a histogram labelled by `db` and `operation`
 *  • `db_slow_queries_total`     — a counter for statements over the threshold,
 *                                  each also logged as a `slow_query` warning
 *  • a bounded ring of recent durations per database, for the p99 shown on
 *    `GET /health/deep`
 *
 * This module is deliberately a leaf: `pool.ts` imports it, so it must not
 * import anything that imports the pool back.
 *
 * Log lines carry a short hash of the SQL text, never the bound values, so a
 * slow query can be grouped without leaking data into the logs.
 */

import { createHash } from "crypto";
import type Database from "better-sqlite3";
import { createLogger } from "../utils/logger";
import { getConfig } from "../config";

const logger = createLogger({ component: "db-query-metrics" });

export type DbOperation = "select" | "insert" | "update" | "delete" | "other";

/** Histogram upper bounds in seconds when `DB_LATENCY_BUCKETS` is unset. */
export const DEFAULT_DB_LATENCY_BUCKETS_SECONDS = [0.001, 0.005, 0.01, 0.05, 0.1, 0.5, 1.0];
/** Slow-query threshold when `SLOW_QUERY_THRESHOLD_MS` is unavailable. */
export const DEFAULT_SLOW_QUERY_THRESHOLD_MS = 200;
/** Recent durations kept per database for p99 estimates. */
const LATENCY_WINDOW_SIZE = 1024;

/** Methods on a prepared statement that execute SQL and are therefore timed. */
const TIMED_STATEMENT_METHODS = new Set(["run", "get", "all"]);

interface OperationSeries {
  /** Observations at or below each bucket bound (non-cumulative). */
  bucketCounts: number[];
  /** Observations above the largest bucket bound. */
  overflow: number;
  sum: number;
  count: number;
}

interface DatabaseSeries {
  operations: Map<DbOperation, OperationSeries>;
  window: number[];
  windowNext: number;
  slowQueries: number;
}

export interface DbQueryMetricsSnapshot {
  /** Bucket upper bounds, in seconds. */
  buckets: number[];
  databases: Record<
    string,
    {
      p99LatencyMs: number;
      slowQueries: number;
      operations: Partial<Record<DbOperation, { count: number; sumSeconds: number; buckets: Array<{ le: number; count: number }>; overflow: number }>>;
    }
  >;
}

let bucketBounds: number[] | null = null;
let slowThresholdMs: number | null = null;
const seriesByDatabase = new Map<string, DatabaseSeries>();

/**
 * Parse `DB_LATENCY_BUCKETS` (comma-separated milliseconds) into ascending
 * bucket bounds in seconds. Unparseable entries are dropped; an empty result
 * falls back to the defaults so a bad value never disables the histogram.
 */
export function parseLatencyBucketsMs(raw: string | undefined): number[] {
  if (!raw || raw.trim() === "") return [...DEFAULT_DB_LATENCY_BUCKETS_SECONDS];
  const seconds = raw
    .split(",")
    .map((part) => Number(part.trim()))
    .filter((ms) => Number.isFinite(ms) && ms > 0)
    .map((ms) => ms / 1000);
  const unique = [...new Set(seconds)].sort((a, b) => a - b);
  return unique.length > 0 ? unique : [...DEFAULT_DB_LATENCY_BUCKETS_SECONDS];
}

function readConfiguredValues(): { buckets: number[]; slowMs: number } {
  try {
    // Metrics are best-effort telemetry: a config that fails to load (e.g. a
    // partial test environment) falls back to the defaults rather than
    // breaking the query path.
    const cfg = getConfig();
    return {
      buckets: parseLatencyBucketsMs(cfg.DB_LATENCY_BUCKETS),
      slowMs: cfg.SLOW_QUERY_THRESHOLD_MS,
    };
  } catch {
    return { buckets: [...DEFAULT_DB_LATENCY_BUCKETS_SECONDS], slowMs: DEFAULT_SLOW_QUERY_THRESHOLD_MS };
  }
}

function configured(): { buckets: number[]; slowMs: number } {
  if (bucketBounds === null || slowThresholdMs === null) {
    const values = readConfiguredValues();
    bucketBounds = values.buckets;
    slowThresholdMs = values.slowMs;
  }
  return { buckets: bucketBounds, slowMs: slowThresholdMs };
}

/** Classify a SQL statement by its leading keyword. */
export function operationOf(sql: string): DbOperation {
  const match = /^\s*(select|insert|update|delete|with)\b/i.exec(sql);
  if (!match) return "other";
  const keyword = match[1]!.toLowerCase();
  return keyword === "with" ? "select" : (keyword as DbOperation);
}

/** Short, stable fingerprint of a SQL text. Never includes bound values. */
export function queryHashOf(sql: string): string {
  return createHash("sha256").update(sql).digest("hex").slice(0, 12);
}

function seriesFor(dbName: string): DatabaseSeries {
  let series = seriesByDatabase.get(dbName);
  if (!series) {
    series = { operations: new Map(), window: [], windowNext: 0, slowQueries: 0 };
    seriesByDatabase.set(dbName, series);
  }
  return series;
}

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, index)]!;
}

/**
 * Record one executed statement. `durationMs` is wall-clock time spent inside
 * the driver call. Never throws.
 */
export function recordDbQuery(dbName: string, sql: string, durationMs: number): void {
  try {
    const { buckets, slowMs } = configured();
    const operation = operationOf(sql);
    const seconds = durationMs / 1000;
    const series = seriesFor(dbName);

    let op = series.operations.get(operation);
    if (!op) {
      op = { bucketCounts: buckets.map(() => 0), overflow: 0, sum: 0, count: 0 };
      series.operations.set(operation, op);
    }
    const index = buckets.findIndex((bound) => seconds <= bound);
    if (index === -1) op.overflow += 1;
    else op.bucketCounts[index] += 1;
    op.sum += seconds;
    op.count += 1;

    if (series.window.length < LATENCY_WINDOW_SIZE) {
      series.window.push(durationMs);
    } else {
      series.window[series.windowNext] = durationMs;
      series.windowNext = (series.windowNext + 1) % LATENCY_WINDOW_SIZE;
    }

    if (durationMs >= slowMs) {
      series.slowQueries += 1;
      logger.warn(
        { event: "slow_query", db: dbName, operation, durationMs: Math.round(durationMs * 100) / 100, queryHash: queryHashOf(sql) },
        "slow query",
      );
    }
  } catch {
    // Telemetry must never fail a query.
  }
}

/**
 * Wrap a statement so `run`, `get` and `all` are timed. Every other member is
 * passed straight through to the native statement.
 */
function timeStatement(statement: Database.Statement, dbName: string, sql: string): Database.Statement {
  return new Proxy(statement, {
    get(target, prop) {
      const value = Reflect.get(target, prop, target) as unknown;
      if (typeof prop !== "string" || !TIMED_STATEMENT_METHODS.has(prop) || typeof value !== "function") {
        return value;
      }
      return (...args: unknown[]) => {
        const started = process.hrtime.bigint();
        try {
          return (value as (...a: unknown[]) => unknown).apply(target, args);
        } finally {
          recordDbQuery(dbName, sql, Number(process.hrtime.bigint() - started) / 1_000_000);
        }
      };
    },
  });
}

/**
 * Route every `prepare` on this connection through the timing wrapper. The
 * patch is per handle, so a pool's writer and readers are each instrumented
 * once when they are opened.
 */
export function instrumentDatabase(db: Database.Database, dbName: string): void {
  type PrepareFn = (this: Database.Database, source: string) => Database.Statement;
  const original = db.prepare as unknown as PrepareFn;
  (db as unknown as { prepare: PrepareFn }).prepare = function (this: Database.Database, source: string) {
    return timeStatement(original.call(this, source), dbName, source);
  };
}

/** Point-in-time view of the recorded timings, for Prometheus and health output. */
export function getDbQueryMetricsSnapshot(): DbQueryMetricsSnapshot {
  const { buckets } = configured();
  const databases: DbQueryMetricsSnapshot["databases"] = {};
  for (const [name, series] of seriesByDatabase) {
    const operations: DbQueryMetricsSnapshot["databases"][string]["operations"] = {};
    for (const [operation, op] of series.operations) {
      operations[operation] = {
        count: op.count,
        sumSeconds: op.sum,
        overflow: op.overflow,
        buckets: buckets.map((le, i) => ({ le, count: op.bucketCounts[i]! })),
      };
    }
    databases[name] = {
      p99LatencyMs: Math.round(percentile(series.window, 99) * 100) / 100,
      slowQueries: series.slowQueries,
      operations,
    };
  }
  return { buckets: [...buckets], databases };
}

/** Clear every recorded timing and cached config value (test helper). */
export function resetDbQueryMetrics(): void {
  seriesByDatabase.clear();
  bucketBounds = null;
  slowThresholdMs = null;
}
