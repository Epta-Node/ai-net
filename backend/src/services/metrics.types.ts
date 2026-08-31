/**
 * Shared types for the health dashboard metrics service.
 *
 * The dashboard aggregates four independent families of signal:
 *  • HTTP traffic (rate, latency percentiles, error rate) — sampled in-process.
 *  • Dependency reachability (SQLite, Venice AI, Stellar Horizon, WebSocket).
 *  • Process health (memory, CPU, uptime, garbage collection).
 *  • Domain counters (agents, tasks, payments) — read from SQLite.
 *
 * Every numeric field is a plain JSON-safe `number`; stroop amounts are also
 * surfaced as decimal strings so callers never lose precision on large sums.
 */

/** Reachability verdict for a single dependency. */
export type DependencyState = "ok" | "degraded" | "unreachable" | "unknown";

/** Overall dashboard verdict, derived from the individual dependency states. */
export type DashboardStatus = "healthy" | "degraded" | "unhealthy";

/** A single recorded HTTP request, kept in a bounded in-memory ring buffer. */
export interface RequestSample {
  /** Epoch milliseconds at which the response finished. */
  timestamp: number;
  /** Wall-clock duration of the request in milliseconds. */
  durationMs: number;
  /** HTTP status code written to the response. */
  statusCode: number;
}

/** Traffic and latency analytics over the rolling metrics window. */
export interface RequestMetrics {
  /** Requests observed inside the rolling window. */
  totalRequests: number;
  /** Length of the rolling window in milliseconds. */
  windowMs: number;
  /** Requests per second across the window. */
  requestRatePerSecond: number;
  /** Mean response time in milliseconds. */
  avgResponseTimeMs: number;
  /** 95th percentile response time in milliseconds. */
  p95ResponseTimeMs: number;
  /** 99th percentile response time in milliseconds. */
  p99ResponseTimeMs: number;
  /** Fraction of requests answered with a 5xx/4xx status, in `0..1`. */
  errorRate: number;
  /** Count of responses with a status code >= 500. */
  serverErrorCount: number;
  /** Count of responses with a status code in `400..499`. */
  clientErrorCount: number;
}

/** Reachability of one external or internal dependency. */
export interface DependencyStatus {
  status: DependencyState;
  /** Round-trip time of the probe in milliseconds, when measured. */
  latencyMs?: number;
  /** Human-readable failure reason; omitted when healthy. */
  error?: string;
  /** Probe-specific extras (e.g. active WebSocket connections). */
  details?: Record<string, unknown>;
}

/** Reachability report for every dependency the dashboard tracks. */
export interface DependencyMetrics {
  sqlite: DependencyStatus;
  venice: DependencyStatus;
  stellarHorizon: DependencyStatus;
  websocket: DependencyStatus;
}

/** Resident memory footprint of the Node.js process. */
export interface MemoryMetrics {
  rssBytes: number;
  heapTotalBytes: number;
  heapUsedBytes: number;
  externalBytes: number;
  /** `heapUsed / heapTotal` as a percentage in `0..100`. */
  heapUsedPercent: number;
}

/** CPU consumption of the Node.js process since the previous sample. */
export interface CpuMetrics {
  /** User-mode CPU time consumed since the previous sample, in milliseconds. */
  userMs: number;
  /** Kernel-mode CPU time consumed since the previous sample, in milliseconds. */
  systemMs: number;
  /**
   * CPU time consumed as a percentage of elapsed wall-clock time since the
   * previous sample. May exceed 100 on multi-core workloads.
   */
  usagePercent: number;
  /** 1, 5 and 15 minute load averages as reported by the OS. */
  loadAverage: [number, number, number];
  /** Logical CPU count of the host. */
  cpuCount: number;
}

/** Garbage collection activity observed since process start. */
export interface GcMetrics {
  /** Whether GC observation is active (requires `perf_hooks` GC entries). */
  available: boolean;
  /** Number of GC pauses observed. */
  collections: number;
  /** Cumulative GC pause time in milliseconds. */
  totalPauseMs: number;
  /** Mean GC pause duration in milliseconds. */
  avgPauseMs: number;
  /** Duration of the most recent GC pause in milliseconds. */
  lastPauseMs: number;
}

/** Process-level health: memory, CPU, uptime and GC. */
export interface SystemMetrics {
  /** Seconds since the metrics service (and therefore the process) started. */
  uptimeSeconds: number;
  memory: MemoryMetrics;
  cpu: CpuMetrics;
  gc: GcMetrics;
}

/** Registered-agent population and responsiveness. */
export interface AgentMetrics {
  total: number;
  online: number;
  offline: number;
  /** Mean node execution time across recorded agent dispatches, in ms. */
  avgResponseTimeMs: number;
}

/** Task pipeline counters. */
export interface TaskMetrics {
  total: number;
  active: number;
  queued: number;
  completed: number;
  failed: number;
  cancelled: number;
}

/** Escrow totals for one payment status. */
export interface PaymentAmount {
  /** Number of payment records with this status. */
  count: number;
  /** Exact total in stroops, as a decimal string (1 XLM = 10 000 000 stroops). */
  stroops: string;
  /** Total converted to XLM. Lossy above 2^53 stroops; `stroops` stays exact. */
  xlm: number;
}

/** Escrow totals broken down by payment status. */
export interface PaymentMetrics {
  locked: PaymentAmount;
  released: PaymentAmount;
  refunded: PaymentAmount;
}

/** The full payload returned by `GET /health/dashboard`. */
export interface HealthDashboard {
  status: DashboardStatus;
  /** ISO-8601 timestamp at which this snapshot was collected. */
  timestamp: string;
  version: string;
  stellarNetwork: string;
  /** Age of the cached snapshot in milliseconds; `0` on a fresh collection. */
  cacheAgeMs: number;
  /** How long a snapshot is served before it is recollected. */
  cacheTtlMs: number;
  requests: RequestMetrics;
  dependencies: DependencyMetrics;
  system: SystemMetrics;
  agents: AgentMetrics;
  tasks: TaskMetrics;
  payments: PaymentMetrics;
}

/**
 * Injectable probes and data sources. Every field is optional — the service
 * falls back to the real implementations (SQLite handles, `fetch`) when a
 * probe is not supplied, which keeps unit tests free of I/O.
 */
export interface MetricsCollectorOptions {
  /** Snapshot lifetime in milliseconds. Default: `METRICS_CACHE_TTL_MS`. */
  cacheTtlMs?: number;
  /** Rolling request window in milliseconds. Default: `METRICS_WINDOW_MS`. */
  windowMs?: number;
  /** Maximum request samples retained. Default: `METRICS_MAX_SAMPLES`. */
  maxSamples?: number;
  /** Injectable clock, in epoch milliseconds. Default: `Date.now`. */
  clock?: () => number;
  /** Overrides for the individual metric sources. */
  sources?: MetricsSources;
}

/** Individual metric sources, each independently overridable in tests. */
export interface MetricsSources {
  checkSqlite?: () => Promise<DependencyStatus> | DependencyStatus;
  checkVenice?: () => Promise<DependencyStatus> | DependencyStatus;
  checkStellarHorizon?: () => Promise<DependencyStatus> | DependencyStatus;
  checkWebSocket?: () => Promise<DependencyStatus> | DependencyStatus;
  collectAgents?: () => Promise<AgentMetrics> | AgentMetrics;
  collectTasks?: () => Promise<TaskMetrics> | TaskMetrics;
  collectPayments?: () => Promise<PaymentMetrics> | PaymentMetrics;
}
