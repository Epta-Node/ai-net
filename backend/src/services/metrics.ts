/**
 * Health dashboard metrics collection service.
 *
 * Responsibilities
 * ────────────────
 * • Sample every HTTP response (via {@link metricsMiddleware}) into a bounded
 *   ring buffer and derive rate / latency / error-rate analytics from it.
 * • Observe garbage collection pauses through `perf_hooks`.
 * • Probe dependency reachability (SQLite, Venice AI, Stellar Horizon,
 *   WebSocket) and read domain counters out of SQLite.
 * • Serve the assembled snapshot from a short-lived cache so that a scraping
 *   dashboard cannot turn `/health/dashboard` into a load generator.
 *
 * The heavy lifting lives in exported pure functions (`calculateRequestMetrics`,
 * `summarizePayments`, …) so that every metric calculation is unit-testable
 * without touching a database, a socket, or the clock.
 */

import os from "os";
import { PerformanceObserver } from "perf_hooks";

import { getConfig } from "../config";
import { createLogger } from "../utils/logger";
import type {
  AgentMetrics,
  CpuMetrics,
  DashboardStatus,
  DependencyMetrics,
  DependencyStatus,
  GcMetrics,
  HealthDashboard,
  MemoryMetrics,
  MetricsCollectorOptions,
  MetricsSources,
  PaymentAmount,
  PaymentMetrics,
  RequestMetrics,
  RequestSample,
  SystemMetrics,
  TaskMetrics,
} from "./metrics.types";

import type { NextFunction, Request, Response } from "express";

const logger = createLogger({ component: "metrics" });

/** 1 XLM = 10 000 000 stroops. */
const STROOPS_PER_XLM = 10_000_000n;

/** Timeout applied to each outbound dependency probe. */
const PROBE_TIMEOUT_MS = 5_000;

export const DEFAULT_CACHE_TTL_MS = 5_000;
export const DEFAULT_WINDOW_MS = 60_000;
export const DEFAULT_MAX_SAMPLES = 1_000;

// ─────────────────────────────────────────────────────────────────────────────
// Pure metric calculations
// ─────────────────────────────────────────────────────────────────────────────

/** Round to at most `digits` decimal places, keeping the value JSON-safe. */
export function round(value: number, digits = 2): number {
  if (!Number.isFinite(value)) return 0;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

/**
 * Nearest-rank percentile over an **already ascending** array of samples.
 *
 * `percentile([1, 2, 3, 4], 95)` → `4`. Returns `0` for an empty input so the
 * dashboard reports a number rather than `null` before any traffic arrives.
 *
 * @param sorted - Ascending values.
 * @param p - Percentile in `0..100`; values outside the range are clamped.
 */
export function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const clamped = Math.min(100, Math.max(0, p));
  const rank = Math.ceil((clamped / 100) * sorted.length);
  const index = Math.min(sorted.length - 1, Math.max(0, rank - 1));
  return sorted[index]!;
}

/**
 * Derive traffic analytics from the raw request samples.
 *
 * Only samples inside `[now - windowMs, now]` are considered, so the numbers
 * describe recent behaviour rather than the lifetime of the process. The error
 * rate counts every response with a status code >= 400.
 */
export function calculateRequestMetrics(
  samples: readonly RequestSample[],
  now: number,
  windowMs: number,
): RequestMetrics {
  const cutoff = now - windowMs;
  const recent = samples.filter((s) => s.timestamp >= cutoff);

  if (recent.length === 0) {
    return {
      totalRequests: 0,
      windowMs,
      requestRatePerSecond: 0,
      avgResponseTimeMs: 0,
      p95ResponseTimeMs: 0,
      p99ResponseTimeMs: 0,
      errorRate: 0,
      serverErrorCount: 0,
      clientErrorCount: 0,
    };
  }

  const durations = recent.map((s) => s.durationMs).sort((a, b) => a - b);
  const totalDuration = durations.reduce((sum, d) => sum + d, 0);
  const clientErrorCount = recent.filter(
    (s) => s.statusCode >= 400 && s.statusCode < 500,
  ).length;
  const serverErrorCount = recent.filter((s) => s.statusCode >= 500).length;

  return {
    totalRequests: recent.length,
    windowMs,
    requestRatePerSecond: round(recent.length / (windowMs / 1000), 4),
    avgResponseTimeMs: round(totalDuration / recent.length),
    p95ResponseTimeMs: round(percentile(durations, 95)),
    p99ResponseTimeMs: round(percentile(durations, 99)),
    errorRate: round((clientErrorCount + serverErrorCount) / recent.length, 4),
    serverErrorCount,
    clientErrorCount,
  };
}

/** Shape memory usage into the dashboard's memory block. */
export function calculateMemoryMetrics(usage: NodeJS.MemoryUsage): MemoryMetrics {
  return {
    rssBytes: usage.rss,
    heapTotalBytes: usage.heapTotal,
    heapUsedBytes: usage.heapUsed,
    externalBytes: usage.external,
    heapUsedPercent:
      usage.heapTotal > 0 ? round((usage.heapUsed / usage.heapTotal) * 100) : 0,
  };
}

/**
 * Convert a `process.cpuUsage()` delta into a usage percentage.
 *
 * `cpuUsage` deltas are in **microseconds**; `elapsedMs` is wall-clock time
 * since the previous sample. The result may exceed 100 % when more than one
 * core is busy, which is expected and left unclamped.
 */
export function calculateCpuMetrics(
  delta: NodeJS.CpuUsage,
  elapsedMs: number,
  loadAverage: number[],
  cpuCount: number,
): CpuMetrics {
  const userMs = delta.user / 1000;
  const systemMs = delta.system / 1000;
  const usagePercent = elapsedMs > 0 ? ((userMs + systemMs) / elapsedMs) * 100 : 0;

  return {
    userMs: round(userMs),
    systemMs: round(systemMs),
    usagePercent: round(usagePercent),
    loadAverage: [
      round(loadAverage[0] ?? 0),
      round(loadAverage[1] ?? 0),
      round(loadAverage[2] ?? 0),
    ],
    cpuCount,
  };
}

/** Accumulated garbage-collection observations. */
export interface GcState {
  available: boolean;
  collections: number;
  totalPauseMs: number;
  lastPauseMs: number;
}

/** Derive the GC block, including the mean pause, from raw counters. */
export function calculateGcMetrics(state: GcState): GcMetrics {
  return {
    available: state.available,
    collections: state.collections,
    totalPauseMs: round(state.totalPauseMs, 3),
    avgPauseMs:
      state.collections > 0 ? round(state.totalPauseMs / state.collections, 3) : 0,
    lastPauseMs: round(state.lastPauseMs, 3),
  };
}

/** Convert an exact stroop total into the dashboard's payment amount block. */
export function toPaymentAmount(count: number, stroops: bigint): PaymentAmount {
  return {
    count,
    stroops: stroops.toString(),
    // Number() on the quotient keeps whole XLM exact; the remainder adds the
    // fractional part. Exactness is preserved in the `stroops` string.
    xlm: round(
      Number(stroops / STROOPS_PER_XLM) +
        Number(stroops % STROOPS_PER_XLM) / Number(STROOPS_PER_XLM),
      7,
    ),
  };
}

/** A payment row as stored: status plus a stroop amount in string form. */
export interface PaymentRow {
  status: string;
  amountStroops: string | number | bigint | null;
}

/**
 * Total locked / released / refunded escrow amounts.
 *
 * Amounts are summed as `bigint` so that totals beyond `Number.MAX_SAFE_INTEGER`
 * stroops stay exact. Unparseable amounts contribute `0` rather than `NaN`, and
 * rows with an unrecognised status are ignored.
 */
export function summarizePayments(rows: readonly PaymentRow[]): PaymentMetrics {
  const totals = { locked: 0n, released: 0n, refunded: 0n };
  const counts = { locked: 0, released: 0, refunded: 0 };

  for (const row of rows) {
    const status = row.status as keyof typeof totals;
    if (!(status in totals)) continue;
    counts[status] += 1;
    totals[status] += parseStroops(row.amountStroops);
  }

  return {
    locked: toPaymentAmount(counts.locked, totals.locked),
    released: toPaymentAmount(counts.released, totals.released),
    refunded: toPaymentAmount(counts.refunded, totals.refunded),
  };
}

/** Parse a stroop amount into a `bigint`, treating malformed values as zero. */
export function parseStroops(value: string | number | bigint | null | undefined): bigint {
  if (value === null || value === undefined) return 0n;
  if (typeof value === "bigint") return value;
  if (typeof value === "number") return Number.isFinite(value) ? BigInt(Math.trunc(value)) : 0n;
  const trimmed = value.trim();
  if (!/^-?\d+$/.test(trimmed)) return 0n;
  return BigInt(trimmed);
}

/** A `status → count` aggregate row as produced by `GROUP BY status`. */
export interface StatusCountRow {
  status: string;
  count: number;
}

/**
 * Fold task status counts into the dashboard's task block.
 *
 * `active` mirrors the `running` status; `total` is the sum of every row,
 * including statuses the dashboard does not break out individually.
 */
export function summarizeTasks(rows: readonly StatusCountRow[]): TaskMetrics {
  const metrics: TaskMetrics = {
    total: 0,
    active: 0,
    queued: 0,
    completed: 0,
    failed: 0,
    cancelled: 0,
  };

  for (const row of rows) {
    const count = Number(row.count) || 0;
    metrics.total += count;
    switch (row.status) {
      case "running":
        metrics.active += count;
        break;
      case "queued":
        metrics.queued += count;
        break;
      case "completed":
        metrics.completed += count;
        break;
      case "failed":
        metrics.failed += count;
        break;
      case "cancelled":
        metrics.cancelled += count;
        break;
      default:
        break;
    }
  }

  return metrics;
}

/** Fold agent status counts, plus a measured mean latency, into one block. */
export function summarizeAgents(
  rows: readonly StatusCountRow[],
  avgResponseTimeMs: number,
): AgentMetrics {
  let total = 0;
  let online = 0;
  let offline = 0;

  for (const row of rows) {
    const count = Number(row.count) || 0;
    total += count;
    if (row.status === "online") online += count;
    else offline += count;
  }

  return { total, online, offline, avgResponseTimeMs: round(avgResponseTimeMs) };
}

/** A node lifecycle event used to measure how long agents take to respond. */
export interface NodeTimingEvent {
  taskId: string;
  nodeId: string | null;
  type: string;
  /** ISO-8601 timestamp. */
  timestamp: string;
}

/**
 * Mean agent response time, in milliseconds, derived from node lifecycle events.
 *
 * Each `node_started` is paired with the first subsequent `node_completed` or
 * `node_failed` for the same `(taskId, nodeId)`. Unpaired starts (still running)
 * and events without a `nodeId` are skipped. Returns `0` when nothing pairs up.
 */
export function calculateAgentResponseTime(events: readonly NodeTimingEvent[]): number {
  const started = new Map<string, number>();
  let totalMs = 0;
  let pairs = 0;

  const ordered = [...events].sort(
    (a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp),
  );

  for (const event of ordered) {
    if (!event.nodeId) continue;
    const at = Date.parse(event.timestamp);
    if (Number.isNaN(at)) continue;
    const key = `${event.taskId}::${event.nodeId}`;

    if (event.type === "node_started") {
      started.set(key, at);
      continue;
    }

    if (event.type !== "node_completed" && event.type !== "node_failed") continue;

    const startedAt = started.get(key);
    if (startedAt === undefined) continue;
    started.delete(key);
    totalMs += Math.max(0, at - startedAt);
    pairs += 1;
  }

  return pairs > 0 ? round(totalMs / pairs) : 0;
}

/**
 * Roll the individual dependency verdicts up into one dashboard status.
 *
 * SQLite is the only hard dependency: without it the service cannot serve
 * traffic, so an unreachable database is `unhealthy`. Any other failure or a
 * degraded dependency downgrades the dashboard to `degraded`.
 */
export function deriveDashboardStatus(dependencies: DependencyMetrics): DashboardStatus {
  if (dependencies.sqlite.status === "unreachable") return "unhealthy";

  const states = Object.values(dependencies).map((d) => d.status);
  if (states.some((s) => s === "unreachable" || s === "degraded")) return "degraded";
  return "healthy";
}

// ─────────────────────────────────────────────────────────────────────────────
// Metrics service
// ─────────────────────────────────────────────────────────────────────────────

/** Reported by whoever owns the WebSocket server, for the dependency block. */
export interface WebSocketProbeResult {
  listening: boolean;
  connections: number;
}

/**
 * Collects, caches and serves the health dashboard snapshot.
 *
 * A single shared instance ({@link metricsService}) is used by the HTTP
 * middleware and the dashboard route; tests construct their own instances with
 * injected sources and clock.
 */
export class MetricsService {
  private readonly cacheTtlMs: number;
  private readonly windowMs: number;
  private readonly maxSamples: number;
  private readonly clock: () => number;
  private readonly sources: MetricsSources;

  /** Bounded ring buffer of observed requests, oldest first. */
  private samples: RequestSample[] = [];

  private readonly startedAtMs: number;
  private lastCpuUsage: NodeJS.CpuUsage;
  private lastCpuSampleAtMs: number;

  private gcState: GcState = {
    available: false,
    collections: 0,
    totalPauseMs: 0,
    lastPauseMs: 0,
  };
  private gcObserver: PerformanceObserver | null = null;

  private cached: HealthDashboard | null = null;
  private cachedAtMs = 0;
  /** In-flight collection, shared so concurrent requests collect only once. */
  private inFlight: Promise<HealthDashboard> | null = null;

  private webSocketProbe: (() => WebSocketProbeResult) | null = null;

  constructor(options: MetricsCollectorOptions = {}) {
    const config = readMetricsConfig();
    this.cacheTtlMs = options.cacheTtlMs ?? config.cacheTtlMs;
    this.windowMs = options.windowMs ?? config.windowMs;
    this.maxSamples = options.maxSamples ?? config.maxSamples;
    this.clock = options.clock ?? Date.now;
    this.sources = options.sources ?? {};

    this.startedAtMs = this.clock();
    this.lastCpuUsage = process.cpuUsage();
    this.lastCpuSampleAtMs = Date.now();
  }

  /** Record one completed HTTP response. */
  recordRequest(durationMs: number, statusCode: number): void {
    this.samples.push({ timestamp: this.clock(), durationMs, statusCode });
    if (this.samples.length > this.maxSamples) {
      this.samples.splice(0, this.samples.length - this.maxSamples);
    }
  }

  /** Samples currently retained — exposed for assertions and diagnostics. */
  getSamples(): readonly RequestSample[] {
    return this.samples;
  }

  /** Traffic analytics over the rolling window. */
  getRequestMetrics(): RequestMetrics {
    return calculateRequestMetrics(this.samples, this.clock(), this.windowMs);
  }

  /**
   * Register the source of truth for WebSocket liveness.
   *
   * Called by the stream layer when it attaches to the HTTP server; without it
   * the WebSocket dependency reports `unknown` rather than a false failure.
   */
  setWebSocketProbe(probe: (() => WebSocketProbeResult) | null): void {
    this.webSocketProbe = probe;
  }

  /** Begin observing GC pauses. Safe to call more than once. */
  startGcObserver(): void {
    if (this.gcObserver) return;
    try {
      const observer = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          this.gcState.collections += 1;
          this.gcState.totalPauseMs += entry.duration;
          this.gcState.lastPauseMs = entry.duration;
        }
      });
      observer.observe({ entryTypes: ["gc"] });
      // Newer Node builds expose unref() so the observer never holds the event
      // loop open; older typings omit it, hence the guarded cast.
      (observer as unknown as { unref?: () => void }).unref?.();
      this.gcObserver = observer;
      this.gcState.available = true;
    } catch (error) {
      // GC entries are unavailable on some runtimes/flags — report, don't throw.
      logger.warn({ err: error }, "garbage collection observer unavailable");
      this.gcState.available = false;
    }
  }

  /** Stop observing GC pauses and release the observer. */
  stopGcObserver(): void {
    this.gcObserver?.disconnect();
    this.gcObserver = null;
  }

  /** Process health: uptime, memory, CPU-since-last-sample and GC. */
  getSystemMetrics(): SystemMetrics {
    const nowMs = Date.now();
    const cpuDelta = process.cpuUsage(this.lastCpuUsage);
    const elapsedMs = nowMs - this.lastCpuSampleAtMs;
    this.lastCpuUsage = process.cpuUsage();
    this.lastCpuSampleAtMs = nowMs;

    return {
      uptimeSeconds: Math.max(0, Math.floor((this.clock() - this.startedAtMs) / 1000)),
      memory: calculateMemoryMetrics(process.memoryUsage()),
      cpu: calculateCpuMetrics(cpuDelta, elapsedMs, os.loadavg(), os.cpus().length),
      gc: calculateGcMetrics(this.gcState),
    };
  }

  /**
   * The dashboard snapshot, recollected at most once per `cacheTtlMs`.
   *
   * @param force - Bypass the cache and collect immediately.
   */
  async getDashboard(force = false): Promise<HealthDashboard> {
    const now = this.clock();
    if (!force && this.cached) {
      const age = now - this.cachedAtMs;
      if (age < this.cacheTtlMs) {
        return { ...this.cached, cacheAgeMs: Math.max(0, age) };
      }
    }

    // Collapse concurrent misses onto a single collection.
    if (this.inFlight) return this.inFlight;

    this.inFlight = this.collect()
      .then((dashboard) => {
        this.cached = dashboard;
        this.cachedAtMs = this.clock();
        return dashboard;
      })
      .finally(() => {
        this.inFlight = null;
      });

    return this.inFlight;
  }

  /** Drop the cached snapshot so the next read collects fresh data. */
  resetCache(): void {
    this.cached = null;
    this.cachedAtMs = 0;
  }

  /** Discard every recorded request sample. */
  resetSamples(): void {
    this.samples = [];
  }

  /** Collect every metric family in parallel and assemble the snapshot. */
  private async collect(): Promise<HealthDashboard> {
    const [sqlite, venice, stellarHorizon, websocket, agents, tasks, payments] =
      await Promise.all([
        resolveProbe(this.sources.checkSqlite, checkSqlite),
        resolveProbe(this.sources.checkVenice, checkVenice),
        resolveProbe(this.sources.checkStellarHorizon, checkStellarHorizon),
        resolveProbe(this.sources.checkWebSocket, () =>
          checkWebSocket(this.webSocketProbe),
        ),
        resolveSource(this.sources.collectAgents, collectAgentMetrics, EMPTY_AGENTS),
        resolveSource(this.sources.collectTasks, collectTaskMetrics, EMPTY_TASKS),
        resolveSource(this.sources.collectPayments, collectPaymentMetrics, EMPTY_PAYMENTS),
      ]);

    const dependencies: DependencyMetrics = { sqlite, venice, stellarHorizon, websocket };
    const config = readMetricsConfig();

    return {
      status: deriveDashboardStatus(dependencies),
      timestamp: new Date(this.clock()).toISOString(),
      version: config.version,
      stellarNetwork: config.stellarNetwork,
      cacheAgeMs: 0,
      cacheTtlMs: this.cacheTtlMs,
      requests: this.getRequestMetrics(),
      dependencies,
      system: this.getSystemMetrics(),
      agents,
      tasks,
      payments,
    };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Dependency probes and SQLite collectors
// ─────────────────────────────────────────────────────────────────────────────

const EMPTY_AGENTS: AgentMetrics = { total: 0, online: 0, offline: 0, avgResponseTimeMs: 0 };

const EMPTY_TASKS: TaskMetrics = {
  total: 0,
  active: 0,
  queued: 0,
  completed: 0,
  failed: 0,
  cancelled: 0,
};

const EMPTY_PAYMENTS: PaymentMetrics = {
  locked: toPaymentAmount(0, 0n),
  released: toPaymentAmount(0, 0n),
  refunded: toPaymentAmount(0, 0n),
};

/** Run an overridable probe, converting a rejection into an `unreachable`. */
async function resolveProbe(
  override: (() => Promise<DependencyStatus> | DependencyStatus) | undefined,
  fallback: () => Promise<DependencyStatus> | DependencyStatus,
): Promise<DependencyStatus> {
  try {
    return await (override ?? fallback)();
  } catch (error) {
    return { status: "unreachable", error: errorMessage(error) };
  }
}

/** Run an overridable collector, falling back to zeroed metrics on failure. */
async function resolveSource<T>(
  override: (() => Promise<T> | T) | undefined,
  fallback: () => Promise<T> | T,
  empty: T,
): Promise<T> {
  try {
    return await (override ?? fallback)();
  } catch (error) {
    logger.warn({ err: error }, "metrics source failed; reporting zeroed metrics");
    return empty;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** `SELECT 1` against the task and payment databases. */
async function checkSqlite(): Promise<DependencyStatus> {
  const startedAt = Date.now();
  try {
    const { getTaskDb } = require("../db/tasks") as typeof import("../db/tasks");
    const { getDb } = require("../db/index") as typeof import("../db/index");
    getTaskDb().prepare("SELECT 1").get();
    getDb().prepare("SELECT 1").get();
    return { status: "ok", latencyMs: Date.now() - startedAt };
  } catch (error) {
    return {
      status: "unreachable",
      latencyMs: Date.now() - startedAt,
      error: errorMessage(error),
    };
  }
}

/** Probe the Venice AI model listing with a bounded timeout. */
async function checkVenice(): Promise<DependencyStatus> {
  const apiKey = safeConfig()?.VENICE_API_KEY ?? "";
  return probeHttp("https://api.venice.ai/api/v1/models", {
    Authorization: `Bearer ${apiKey}`,
  });
}

/** Probe the configured Stellar Horizon root endpoint. */
async function checkStellarHorizon(): Promise<DependencyStatus> {
  const url = safeConfig()?.STELLAR_HORIZON_URL ?? "https://horizon-testnet.stellar.org";
  return probeHttp(url);
}

/**
 * Report WebSocket liveness from the registered probe.
 *
 * Without a registered probe the stream layer has not attached — that is
 * reported as `unknown` rather than a failure, because a backend running
 * without the WebSocket server is a valid configuration.
 */
function checkWebSocket(probe: (() => WebSocketProbeResult) | null): DependencyStatus {
  if (!probe) {
    return { status: "unknown", error: "WebSocket server not attached" };
  }
  try {
    const result = probe();
    return {
      status: result.listening ? "ok" : "unreachable",
      details: { connections: result.connections },
    };
  } catch (error) {
    return { status: "unreachable", error: errorMessage(error) };
  }
}

/** Issue a bounded HEAD-like GET and classify the response. */
async function probeHttp(
  url: string,
  headers: Record<string, string> = {},
): Promise<DependencyStatus> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  const startedAt = Date.now();
  try {
    const response = await fetch(url, { headers, signal: controller.signal });
    const latencyMs = Date.now() - startedAt;
    if (response.ok) return { status: "ok", latencyMs };
    return {
      status: "degraded",
      latencyMs,
      error: `HTTP ${response.status}`,
    };
  } catch (error) {
    return {
      status: "unreachable",
      latencyMs: Date.now() - startedAt,
      error: errorMessage(error),
    };
  } finally {
    clearTimeout(timer);
  }
}

/** Agent population and mean node execution time, read from SQLite. */
function collectAgentMetrics(): AgentMetrics {
  const { getAgentDb } = require("../db/agents") as typeof import("../db/agents");
  const rows = getAgentDb()
    .prepare("SELECT status, COUNT(*) AS count FROM agents GROUP BY status")
    .all() as StatusCountRow[];

  let avgResponseTimeMs = 0;
  try {
    const { getTaskDb } = require("../db/tasks") as typeof import("../db/tasks");
    const events = getTaskDb()
      .prepare(
        `SELECT taskId, nodeId, type, timestamp FROM task_events
          WHERE type IN ('node_started', 'node_completed', 'node_failed')
          ORDER BY timestamp DESC
          LIMIT 1000`,
      )
      .all() as NodeTimingEvent[];
    avgResponseTimeMs = calculateAgentResponseTime(events);
  } catch (error) {
    // A missing task_events table must not sink the whole agent block.
    logger.warn({ err: error }, "unable to derive agent response time");
  }

  return summarizeAgents(rows, avgResponseTimeMs);
}

/** Task pipeline counters, read from SQLite. */
function collectTaskMetrics(): TaskMetrics {
  const { getTaskDb } = require("../db/tasks") as typeof import("../db/tasks");
  const rows = getTaskDb()
    .prepare("SELECT status, COUNT(*) AS count FROM tasks GROUP BY status")
    .all() as StatusCountRow[];
  return summarizeTasks(rows);
}

/** Escrow totals, read from SQLite and summed exactly as `bigint`. */
function collectPaymentMetrics(): PaymentMetrics {
  const { getDb } = require("../db/index") as typeof import("../db/index");
  const rows = getDb()
    .prepare("SELECT status, amountStroops FROM payments")
    .all() as PaymentRow[];
  return summarizePayments(rows);
}

/** Config-backed knobs, with defaults for contexts where config is unloaded. */
function readMetricsConfig(): {
  cacheTtlMs: number;
  windowMs: number;
  maxSamples: number;
  version: string;
  stellarNetwork: string;
} {
  const config = safeConfig();
  return {
    cacheTtlMs: config?.METRICS_CACHE_TTL_MS ?? DEFAULT_CACHE_TTL_MS,
    windowMs: config?.METRICS_WINDOW_MS ?? DEFAULT_WINDOW_MS,
    maxSamples: config?.METRICS_MAX_SAMPLES ?? DEFAULT_MAX_SAMPLES,
    version: config?.NPM_PACKAGE_VERSION ?? "0.0.0",
    stellarNetwork: config?.STELLAR_NETWORK ?? "unknown",
  };
}

/** `getConfig()` throws before `loadConfig()`; metrics must not depend on order. */
function safeConfig(): ReturnType<typeof getConfig> | null {
  try {
    return getConfig();
  } catch {
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Shared instance and Express middleware
// ─────────────────────────────────────────────────────────────────────────────

/** Process-wide metrics instance used by the middleware and dashboard route. */
export const metricsService = new MetricsService();

/**
 * Sample every HTTP response into {@link metricsService}.
 *
 * Mount before the routers so that latency covers the full handler chain.
 */
export function metricsMiddleware(_req: Request, res: Response, next: NextFunction): void {
  const startedAt = process.hrtime.bigint();

  res.on("finish", () => {
    const durationMs = Number(process.hrtime.bigint() - startedAt) / 1_000_000;
    metricsService.recordRequest(durationMs, res.statusCode);
  });

  next();
}
