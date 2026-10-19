/**
 * Deep dependency probe backing `GET /health/deep`.
 *
 * Each dependency reports `{ status, critical, latencyMs, detail }`:
 *
 *   venice   (critical)     — Venice AI circuit breaker state + last success,
 *                             plus a reachability probe of the models endpoint.
 *   horizon  (critical)     — Stellar Horizon reachability + its breaker state.
 *   database (critical)     — write check against the task DB; skipped while
 *                             the API is in admin read-only mode.
 *   queue    (non-critical) — job queue depth against a warning threshold.
 *
 * Overall status is `fail` when any critical dependency fails (the route maps
 * that to 503), `degraded` when anything else is not `ok`, otherwise `ok`.
 *
 * Every collaborator is injectable so the probe can be unit-tested without
 * network or disk access.
 */
import type Database from 'better-sqlite3';
import { summarizeCircuitBreakers, type CircuitBreakerSummary } from './circuitBreaker.js';
import { getDatabaseMetrics, type DatabaseMetricsSnapshot } from '../db/metrics.js';

export type DependencyStatus = 'ok' | 'degraded' | 'fail';

export interface DependencyResult {
  status: DependencyStatus;
  /** A failing critical dependency fails the whole probe (503). */
  critical: boolean;
  latencyMs: number;
  detail: string;
  [extra: string]: unknown;
}

export interface DeepHealthReport {
  status: DependencyStatus;
  checkedAt: string;
  durationMs: number;
  dependencies: Record<string, DependencyResult>;
  /** Names of non-`ok` dependencies, split by severity. */
  failing: string[];
  degraded: string[];
  /** Pool utilisation and p99 query latency per SQLite database (#807). */
  db: DatabaseMetricsSnapshot;
}

export interface QueueStats {
  pending: number;
  active: number;
  failed: number;
  deadLetter: number;
}

export interface DeepHealthDeps {
  veniceApiKey: string;
  horizonUrl: string;
  timeoutMs: number;
  /** Queue depth at or above which the queue reports `degraded`. */
  queueDepthWarn: number;
  fetchFn?: typeof fetch;
  now?: () => number;
  getBreaker?: (name: string) => CircuitBreakerSummary | null;
  getWriteDb?: () => Database.Database | Promise<Database.Database>;
  isReadOnly?: () => boolean | Promise<boolean>;
  getQueueStats?: () => QueueStats | Promise<QueueStats>;
  getDatabaseMetrics?: () => DatabaseMetricsSnapshot;
}

/** Breaker names, as registered by the Venice client and PaymentService. */
export const VENICE_BREAKER = 'venice';
export const HORIZON_BREAKER = 'stellar-horizon';

const VENICE_MODELS_URL = 'https://api.venice.ai/api/v1/models';

/** Queue depth counts work still waiting to run: pending plus retriable failures. */
export function queueDepthOf(stats: QueueStats): number {
  return stats.pending + stats.failed;
}

async function timed<T>(
  now: () => number,
  fn: () => Promise<T>
): Promise<{ value: T; latencyMs: number }> {
  const start = now();
  const value = await fn();
  return { value, latencyMs: Math.max(0, now() - start) };
}

async function probeUrl(
  fetchFn: typeof fetch,
  url: string,
  timeoutMs: number,
  init: RequestInit = {},
  isOk: (res: Response) => boolean = (res) => res.ok
): Promise<{ reachable: boolean; detail: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchFn(url, { ...init, signal: controller.signal });
    return isOk(res)
      ? { reachable: true, detail: 'reachable' }
      : { reachable: false, detail: `upstream responded ${res.status ?? 'non-ok'}` };
  } catch (err) {
    const name = err instanceof Error ? err.name : '';
    return {
      reachable: false,
      detail: name === 'AbortError' ? `timed out after ${timeoutMs}ms` : 'unreachable',
    };
  } finally {
    clearTimeout(timer);
  }
}

function breakerView(summary: CircuitBreakerSummary | null) {
  if (!summary) return null;
  return {
    state: summary.state,
    instances: summary.instances,
    openInstances: summary.openInstances,
    failures: summary.failures,
    lastSuccessAt:
      summary.lastSuccessAt === null ? null : new Date(summary.lastSuccessAt).toISOString(),
    lastFailureAt:
      summary.lastFailureAt === null ? null : new Date(summary.lastFailureAt).toISOString(),
  };
}

/**
 * Combine a reachability probe with breaker state. An OPEN breaker fails the
 * dependency even when the probe succeeds: the breaker is what callers hit,
 * so requests are being rejected regardless of what the probe sees.
 */
function combine(
  reachable: boolean,
  probeDetail: string,
  breaker: CircuitBreakerSummary | null
): { status: DependencyStatus; detail: string } {
  if (breaker?.state === 'OPEN') {
    return {
      status: 'fail',
      detail: `circuit breaker OPEN (${breaker.failures} consecutive failures); probe: ${probeDetail}`,
    };
  }
  if (!reachable) return { status: 'fail', detail: probeDetail };
  if (breaker?.state === 'HALF_OPEN') {
    return { status: 'degraded', detail: 'circuit breaker HALF_OPEN — recovery probe in progress' };
  }
  return { status: 'ok', detail: probeDetail };
}

async function checkVenice(deps: Required<DeepHealthDeps>): Promise<DependencyResult> {
  const { value: probe, latencyMs } = await timed(deps.now, () =>
    probeUrl(
      deps.fetchFn,
      VENICE_MODELS_URL,
      deps.timeoutMs,
      { headers: { Authorization: `Bearer ${deps.veniceApiKey}` } },
      // 401 still proves the upstream is reachable; a bad key is a config issue.
      (res) => res.ok || res.status === 401
    )
  );
  const breaker = deps.getBreaker(VENICE_BREAKER);
  const breakerStatus = breakerView(breaker);
  return {
    ...combine(probe.reachable, probe.detail, breaker),
    critical: true,
    latencyMs,
    breaker: breakerStatus,
    lastSuccessAt: breakerStatus?.lastSuccessAt ?? null,
  };
}

async function checkHorizon(deps: Required<DeepHealthDeps>): Promise<DependencyResult> {
  const { value: probe, latencyMs } = await timed(deps.now, () =>
    probeUrl(deps.fetchFn, deps.horizonUrl, deps.timeoutMs)
  );
  const breaker = deps.getBreaker(HORIZON_BREAKER);
  return {
    ...combine(probe.reachable, probe.detail, breaker),
    critical: true,
    latencyMs,
    breaker: breakerView(breaker),
  };
}

/**
 * Verify the task database accepts writes without persisting anything:
 * `BEGIN IMMEDIATE` takes SQLite's write lock (failing on a read-only file or
 * handle), then the transaction is rolled back. `busy_timeout` is dropped to 0
 * for the attempt so a contended lock reports `degraded` instead of blocking
 * the event loop.
 */
async function checkDatabase(deps: Required<DeepHealthDeps>): Promise<DependencyResult> {
  const start = deps.now();
  const latency = () => Math.max(0, deps.now() - start);

  const readOnlyMode = await deps.isReadOnly();
  if (readOnlyMode) {
    try {
      const db = await deps.getWriteDb();
      db.prepare('SELECT 1').get();
      return {
        status: 'ok',
        critical: true,
        latencyMs: latency(),
        detail: 'read-only mode enabled — write check skipped, read check passed',
        readOnlyMode: true,
      };
    } catch (err) {
      return {
        status: 'fail',
        critical: true,
        latencyMs: latency(),
        detail: `read check failed: ${err instanceof Error ? err.message : String(err)}`,
        readOnlyMode: true,
      };
    }
  }

  let db: Database.Database;
  try {
    db = await deps.getWriteDb();
  } catch (err) {
    return {
      status: 'fail',
      critical: true,
      latencyMs: latency(),
      detail: `could not open database: ${err instanceof Error ? err.message : String(err)}`,
      readOnlyMode: false,
    };
  }

  if (db.readonly) {
    return {
      status: 'fail',
      critical: true,
      latencyMs: latency(),
      detail: 'database handle is read-only',
      readOnlyMode: false,
    };
  }

  const previousTimeout = db.pragma('busy_timeout', { simple: true }) as number;
  try {
    db.pragma('busy_timeout = 0');
    db.exec('BEGIN IMMEDIATE');
    db.exec('ROLLBACK');
    return {
      status: 'ok',
      critical: true,
      latencyMs: latency(),
      detail: 'write check passed',
      readOnlyMode: false,
    };
  } catch (err) {
    if (db.inTransaction) db.exec('ROLLBACK');
    const code = (err as { code?: string }).code ?? '';
    const message = err instanceof Error ? err.message : String(err);
    // A busy lock means another writer is active — writes work, just not this instant.
    if (code.startsWith('SQLITE_BUSY') || code.startsWith('SQLITE_LOCKED')) {
      return {
        status: 'degraded',
        critical: true,
        latencyMs: latency(),
        detail: `write lock contended: ${message}`,
        readOnlyMode: false,
      };
    }
    return {
      status: 'fail',
      critical: true,
      latencyMs: latency(),
      detail: `write check failed: ${message}`,
      readOnlyMode: false,
    };
  } finally {
    db.pragma(`busy_timeout = ${Number(previousTimeout) || 0}`);
  }
}

async function checkQueue(deps: Required<DeepHealthDeps>): Promise<DependencyResult> {
  const start = deps.now();
  try {
    const stats = await deps.getQueueStats();
    const depth = queueDepthOf(stats);
    const backlogged = depth >= deps.queueDepthWarn;
    return {
      status: backlogged ? 'degraded' : 'ok',
      critical: false,
      latencyMs: Math.max(0, deps.now() - start),
      detail: backlogged
        ? `queue depth ${depth} at or above warning threshold ${deps.queueDepthWarn}`
        : `queue depth ${depth}`,
      depth,
      active: stats.active,
      deadLetter: stats.deadLetter,
      threshold: deps.queueDepthWarn,
    };
  } catch (err) {
    // Queue stats are informational; an unreadable queue DB degrades rather than fails.
    return {
      status: 'degraded',
      critical: false,
      latencyMs: Math.max(0, deps.now() - start),
      detail: `queue stats unavailable: ${err instanceof Error ? err.message : String(err)}`,
      depth: null,
    };
  }
}

async function defaultWriteDb(): Promise<Database.Database> {
  const { getTaskDb } = await import('../db/tasks.js');
  return getTaskDb();
}

async function defaultIsReadOnly(): Promise<boolean> {
  const { isReadOnly } = await import('./adminControl.js');
  return isReadOnly();
}

async function defaultQueueStats(): Promise<QueueStats> {
  const { getJobDb, createJobStore } = await import('../queue/jobStore.js');
  return createJobStore(getJobDb()).getStats();
}

function defaultDatabaseMetrics(): DatabaseMetricsSnapshot {
  return getDatabaseMetrics();
}

export async function runDeepHealthCheck(input: DeepHealthDeps): Promise<DeepHealthReport> {
  const deps: Required<DeepHealthDeps> = {
    fetchFn: (...args) => fetch(...args),
    now: () => Date.now(),
    getBreaker: summarizeCircuitBreakers,
    getWriteDb: defaultWriteDb,
    isReadOnly: defaultIsReadOnly,
    getQueueStats: defaultQueueStats,
    getDatabaseMetrics: defaultDatabaseMetrics,
    ...input,
  };

  const start = deps.now();
  const [venice, horizon, database, queue] = await Promise.all([
    checkVenice(deps),
    checkHorizon(deps),
    checkDatabase(deps),
    checkQueue(deps),
  ]);
  const dependencies: Record<string, DependencyResult> = { venice, horizon, database, queue };

  const failing: string[] = [];
  const degraded: string[] = [];
  for (const [name, result] of Object.entries(dependencies)) {
    if (result.status === 'ok') continue;
    // A failing non-critical dependency only degrades the service.
    if (result.status === 'fail' && result.critical) failing.push(name);
    else degraded.push(name);
  }

  return {
    status: failing.length > 0 ? 'fail' : degraded.length > 0 ? 'degraded' : 'ok',
    checkedAt: new Date(start).toISOString(),
    durationMs: Math.max(0, deps.now() - start),
    dependencies,
    failing,
    degraded,
    db: deps.getDatabaseMetrics(),
  };
}
