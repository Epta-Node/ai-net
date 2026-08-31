/**
 * Unit tests for the health dashboard metrics service.
 *
 * Strategy:
 *  - Exercise every metric calculation as a pure function: fixed inputs in,
 *    exact numbers out. No database, no network, no real clock.
 *  - Drive MetricsService through an injected clock and injected sources so
 *    caching, the rolling window, and the ring buffer are deterministic.
 */
import {
  MetricsService,
  calculateAgentResponseTime,
  calculateCpuMetrics,
  calculateGcMetrics,
  calculateMemoryMetrics,
  calculateRequestMetrics,
  deriveDashboardStatus,
  parseStroops,
  percentile,
  round,
  summarizeAgents,
  summarizePayments,
  summarizeTasks,
  toPaymentAmount,
  type NodeTimingEvent,
  type PaymentRow,
} from "./metrics";
import type {
  AgentMetrics,
  DependencyMetrics,
  PaymentMetrics,
  RequestSample,
  TaskMetrics,
} from "./metrics.types";

// ── Helpers ──────────────────────────────────────────────────────────────────

function sample(
  timestamp: number,
  durationMs: number,
  statusCode = 200,
): RequestSample {
  return { timestamp, durationMs, statusCode };
}

const OK_DEPENDENCIES: DependencyMetrics = {
  sqlite: { status: "ok" },
  venice: { status: "ok" },
  stellarHorizon: { status: "ok" },
  websocket: { status: "ok" },
};

// ── round ────────────────────────────────────────────────────────────────────

describe("round", () => {
  it("rounds to two decimal places by default", () => {
    expect(round(1.23456)).toBe(1.23);
    expect(round(1.239)).toBe(1.24);
    expect(round(2)).toBe(2);
  });

  it("honours an explicit digit count", () => {
    expect(round(1.23456, 4)).toBe(1.2346);
    expect(round(1.5, 0)).toBe(2);
  });

  it("maps non-finite values to 0", () => {
    expect(round(NaN)).toBe(0);
    expect(round(Infinity)).toBe(0);
  });
});

// ── percentile ───────────────────────────────────────────────────────────────

describe("percentile", () => {
  it("returns 0 for an empty sample set", () => {
    expect(percentile([], 95)).toBe(0);
  });

  it("uses nearest-rank on a sorted array", () => {
    const sorted = Array.from({ length: 100 }, (_, i) => i + 1); // 1..100
    expect(percentile(sorted, 95)).toBe(95);
    expect(percentile(sorted, 99)).toBe(99);
    expect(percentile(sorted, 50)).toBe(50);
    expect(percentile(sorted, 100)).toBe(100);
  });

  it("returns the single value for a one-element array", () => {
    expect(percentile([42], 95)).toBe(42);
    expect(percentile([42], 1)).toBe(42);
  });

  it("clamps percentiles outside 0..100", () => {
    const sorted = [10, 20, 30];
    expect(percentile(sorted, -5)).toBe(10);
    expect(percentile(sorted, 150)).toBe(30);
  });

  it("rounds the rank up so p99 of 10 samples is the largest", () => {
    const sorted = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    expect(percentile(sorted, 99)).toBe(10);
    expect(percentile(sorted, 91)).toBe(10);
    expect(percentile(sorted, 90)).toBe(9);
  });
});

// ── calculateRequestMetrics ──────────────────────────────────────────────────

describe("calculateRequestMetrics", () => {
  const NOW = 1_000_000;

  it("returns zeroed metrics when there are no samples", () => {
    const metrics = calculateRequestMetrics([], NOW, 60_000);
    expect(metrics).toEqual({
      totalRequests: 0,
      windowMs: 60_000,
      requestRatePerSecond: 0,
      avgResponseTimeMs: 0,
      p95ResponseTimeMs: 0,
      p99ResponseTimeMs: 0,
      errorRate: 0,
      serverErrorCount: 0,
      clientErrorCount: 0,
    });
  });

  it("ignores samples older than the window", () => {
    const samples = [
      sample(NOW - 90_000, 500), // outside a 60s window
      sample(NOW - 30_000, 100),
      sample(NOW - 10_000, 200),
    ];
    const metrics = calculateRequestMetrics(samples, NOW, 60_000);
    expect(metrics.totalRequests).toBe(2);
    expect(metrics.avgResponseTimeMs).toBe(150);
  });

  it("includes a sample landing exactly on the window boundary", () => {
    const metrics = calculateRequestMetrics([sample(NOW - 60_000, 10)], NOW, 60_000);
    expect(metrics.totalRequests).toBe(1);
  });

  it("computes the request rate over the window length, not the sample span", () => {
    const samples = Array.from({ length: 120 }, (_, i) => sample(NOW - i * 100, 5));
    const metrics = calculateRequestMetrics(samples, NOW, 60_000);
    expect(metrics.totalRequests).toBe(120);
    expect(metrics.requestRatePerSecond).toBe(2); // 120 requests / 60 s
  });

  it("computes the average, p95 and p99 response times", () => {
    // 1..100 ms, one request each.
    const samples = Array.from({ length: 100 }, (_, i) => sample(NOW - 1_000, i + 1));
    const metrics = calculateRequestMetrics(samples, NOW, 60_000);
    expect(metrics.avgResponseTimeMs).toBe(50.5);
    expect(metrics.p95ResponseTimeMs).toBe(95);
    expect(metrics.p99ResponseTimeMs).toBe(99);
  });

  it("counts 4xx and 5xx separately and folds both into the error rate", () => {
    const samples = [
      sample(NOW, 10, 200),
      sample(NOW, 10, 201),
      sample(NOW, 10, 404),
      sample(NOW, 10, 500),
    ];
    const metrics = calculateRequestMetrics(samples, NOW, 60_000);
    expect(metrics.clientErrorCount).toBe(1);
    expect(metrics.serverErrorCount).toBe(1);
    expect(metrics.errorRate).toBe(0.5);
  });

  it("reports an error rate of 0 when every response succeeded", () => {
    const samples = [sample(NOW, 10, 200), sample(NOW, 10, 304)];
    expect(calculateRequestMetrics(samples, NOW, 60_000).errorRate).toBe(0);
  });

  it("reports an error rate of 1 when every response failed", () => {
    const samples = [sample(NOW, 10, 500), sample(NOW, 10, 503)];
    expect(calculateRequestMetrics(samples, NOW, 60_000).errorRate).toBe(1);
  });

  it("does not require the samples to be pre-sorted by duration", () => {
    const samples = [
      sample(NOW, 300),
      sample(NOW, 100),
      sample(NOW, 200),
      sample(NOW, 400),
    ];
    const metrics = calculateRequestMetrics(samples, NOW, 60_000);
    expect(metrics.avgResponseTimeMs).toBe(250);
    expect(metrics.p95ResponseTimeMs).toBe(400);
  });
});

// ── calculateMemoryMetrics ───────────────────────────────────────────────────

describe("calculateMemoryMetrics", () => {
  it("passes through the raw byte counters and derives heap usage", () => {
    const metrics = calculateMemoryMetrics({
      rss: 100,
      heapTotal: 200,
      heapUsed: 50,
      external: 10,
      arrayBuffers: 5,
    });
    expect(metrics).toEqual({
      rssBytes: 100,
      heapTotalBytes: 200,
      heapUsedBytes: 50,
      externalBytes: 10,
      heapUsedPercent: 25,
    });
  });

  it("reports 0 % usage rather than NaN when heapTotal is 0", () => {
    const metrics = calculateMemoryMetrics({
      rss: 0,
      heapTotal: 0,
      heapUsed: 0,
      external: 0,
      arrayBuffers: 0,
    });
    expect(metrics.heapUsedPercent).toBe(0);
  });
});

// ── calculateCpuMetrics ──────────────────────────────────────────────────────

describe("calculateCpuMetrics", () => {
  it("converts microsecond deltas into milliseconds and a usage percentage", () => {
    // 500 ms user + 250 ms system over 1 000 ms of wall clock = 75 %.
    const metrics = calculateCpuMetrics(
      { user: 500_000, system: 250_000 },
      1_000,
      [1, 2, 3],
      8,
    );
    expect(metrics.userMs).toBe(500);
    expect(metrics.systemMs).toBe(250);
    expect(metrics.usagePercent).toBe(75);
    expect(metrics.loadAverage).toEqual([1, 2, 3]);
    expect(metrics.cpuCount).toBe(8);
  });

  it("allows usage above 100 % when several cores are busy", () => {
    const metrics = calculateCpuMetrics(
      { user: 2_000_000, system: 0 },
      1_000,
      [0, 0, 0],
      4,
    );
    expect(metrics.usagePercent).toBe(200);
  });

  it("reports 0 % when no wall-clock time has elapsed", () => {
    const metrics = calculateCpuMetrics({ user: 1_000, system: 1_000 }, 0, [], 1);
    expect(metrics.usagePercent).toBe(0);
  });

  it("pads a short load average array with zeros", () => {
    expect(calculateCpuMetrics({ user: 0, system: 0 }, 1, [], 1).loadAverage).toEqual([
      0, 0, 0,
    ]);
  });
});

// ── calculateGcMetrics ───────────────────────────────────────────────────────

describe("calculateGcMetrics", () => {
  it("derives the mean pause from the totals", () => {
    const metrics = calculateGcMetrics({
      available: true,
      collections: 4,
      totalPauseMs: 10,
      lastPauseMs: 3,
    });
    expect(metrics.collections).toBe(4);
    expect(metrics.totalPauseMs).toBe(10);
    expect(metrics.avgPauseMs).toBe(2.5);
    expect(metrics.lastPauseMs).toBe(3);
    expect(metrics.available).toBe(true);
  });

  it("reports a mean of 0 before any collection is observed", () => {
    const metrics = calculateGcMetrics({
      available: false,
      collections: 0,
      totalPauseMs: 0,
      lastPauseMs: 0,
    });
    expect(metrics.avgPauseMs).toBe(0);
    expect(metrics.available).toBe(false);
  });
});

// ── parseStroops / toPaymentAmount ───────────────────────────────────────────

describe("parseStroops", () => {
  it("parses decimal strings", () => {
    expect(parseStroops("12345")).toBe(12345n);
    expect(parseStroops(" 42 ")).toBe(42n);
    expect(parseStroops("-7")).toBe(-7n);
  });

  it("parses numbers and bigints", () => {
    expect(parseStroops(1_000)).toBe(1000n);
    expect(parseStroops(1.9)).toBe(1n);
    expect(parseStroops(99n)).toBe(99n);
  });

  it("treats null, undefined and malformed values as zero", () => {
    expect(parseStroops(null)).toBe(0n);
    expect(parseStroops(undefined)).toBe(0n);
    expect(parseStroops("abc")).toBe(0n);
    expect(parseStroops("1.5")).toBe(0n);
    expect(parseStroops(NaN)).toBe(0n);
  });
});

describe("toPaymentAmount", () => {
  it("converts stroops to XLM", () => {
    expect(toPaymentAmount(1, 10_000_000n)).toEqual({
      count: 1,
      stroops: "10000000",
      xlm: 1,
    });
  });

  it("keeps sub-XLM precision to 7 decimal places", () => {
    expect(toPaymentAmount(1, 1n).xlm).toBe(0.0000001);
    expect(toPaymentAmount(1, 15_000_001n).xlm).toBe(1.5000001);
  });

  it("keeps totals beyond Number.MAX_SAFE_INTEGER exact in the stroops field", () => {
    const huge = 9_007_199_254_740_993n; // 2^53 + 1
    expect(toPaymentAmount(1, huge).stroops).toBe("9007199254740993");
  });
});

// ── summarizePayments ────────────────────────────────────────────────────────

describe("summarizePayments", () => {
  it("returns zeroed totals for no rows", () => {
    const metrics = summarizePayments([]);
    expect(metrics.locked).toEqual({ count: 0, stroops: "0", xlm: 0 });
    expect(metrics.released).toEqual({ count: 0, stroops: "0", xlm: 0 });
    expect(metrics.refunded).toEqual({ count: 0, stroops: "0", xlm: 0 });
  });

  it("totals each status independently", () => {
    const rows: PaymentRow[] = [
      { status: "locked", amountStroops: "10000000" },
      { status: "locked", amountStroops: "5000000" },
      { status: "released", amountStroops: "20000000" },
      { status: "refunded", amountStroops: "1000000" },
    ];
    const metrics = summarizePayments(rows);
    expect(metrics.locked).toEqual({ count: 2, stroops: "15000000", xlm: 1.5 });
    expect(metrics.released).toEqual({ count: 1, stroops: "20000000", xlm: 2 });
    expect(metrics.refunded).toEqual({ count: 1, stroops: "1000000", xlm: 0.1 });
  });

  it("ignores rows with an unrecognised status", () => {
    const rows: PaymentRow[] = [
      { status: "pending", amountStroops: "10000000" },
      { status: "locked", amountStroops: "10000000" },
    ];
    const metrics = summarizePayments(rows);
    expect(metrics.locked.count).toBe(1);
    expect(metrics.released.count).toBe(0);
  });

  it("sums exactly past the float safe-integer range", () => {
    const rows: PaymentRow[] = [
      { status: "released", amountStroops: "9007199254740992" },
      { status: "released", amountStroops: "1" },
    ];
    expect(summarizePayments(rows).released.stroops).toBe("9007199254740993");
  });

  it("treats malformed amounts as zero without corrupting the total", () => {
    const rows: PaymentRow[] = [
      { status: "locked", amountStroops: "not-a-number" },
      { status: "locked", amountStroops: "10000000" },
    ];
    const metrics = summarizePayments(rows);
    expect(metrics.locked.count).toBe(2);
    expect(metrics.locked.stroops).toBe("10000000");
  });
});

// ── summarizeTasks ───────────────────────────────────────────────────────────

describe("summarizeTasks", () => {
  it("returns zeroed counters for no rows", () => {
    expect(summarizeTasks([])).toEqual({
      total: 0,
      active: 0,
      queued: 0,
      completed: 0,
      failed: 0,
      cancelled: 0,
    });
  });

  it("maps running to active and totals every row", () => {
    const metrics = summarizeTasks([
      { status: "running", count: 3 },
      { status: "queued", count: 5 },
      { status: "completed", count: 10 },
      { status: "failed", count: 2 },
      { status: "cancelled", count: 1 },
    ]);
    expect(metrics).toEqual({
      total: 21,
      active: 3,
      queued: 5,
      completed: 10,
      failed: 2,
      cancelled: 1,
    });
  });

  it("counts unknown statuses towards the total only", () => {
    const metrics = summarizeTasks([
      { status: "completed", count: 2 },
      { status: "archived", count: 4 },
    ]);
    expect(metrics.total).toBe(6);
    expect(metrics.completed).toBe(2);
  });

  it("coerces non-numeric counts to 0", () => {
    const metrics = summarizeTasks([
      { status: "queued", count: "3" as unknown as number },
      { status: "failed", count: NaN },
    ]);
    expect(metrics.queued).toBe(3);
    expect(metrics.failed).toBe(0);
  });
});

// ── summarizeAgents ──────────────────────────────────────────────────────────

describe("summarizeAgents", () => {
  it("splits the population into online and offline", () => {
    const metrics = summarizeAgents(
      [
        { status: "online", count: 4 },
        { status: "offline", count: 6 },
      ],
      123.456,
    );
    expect(metrics).toEqual({
      total: 10,
      online: 4,
      offline: 6,
      avgResponseTimeMs: 123.46,
    });
  });

  it("counts any non-online status as offline", () => {
    const metrics = summarizeAgents([{ status: "frozen", count: 2 }], 0);
    expect(metrics.offline).toBe(2);
    expect(metrics.online).toBe(0);
  });

  it("returns zeros for an empty registry", () => {
    expect(summarizeAgents([], 0)).toEqual({
      total: 0,
      online: 0,
      offline: 0,
      avgResponseTimeMs: 0,
    });
  });
});

// ── calculateAgentResponseTime ───────────────────────────────────────────────

describe("calculateAgentResponseTime", () => {
  function event(
    taskId: string,
    nodeId: string | null,
    type: string,
    timestamp: string,
  ): NodeTimingEvent {
    return { taskId, nodeId, type, timestamp };
  }

  it("returns 0 when there are no events", () => {
    expect(calculateAgentResponseTime([])).toBe(0);
  });

  it("pairs a start with its completion and averages the durations", () => {
    const events = [
      event("t1", "n1", "node_started", "2026-01-01T00:00:00.000Z"),
      event("t1", "n1", "node_completed", "2026-01-01T00:00:01.000Z"),
      event("t2", "n1", "node_started", "2026-01-01T00:00:00.000Z"),
      event("t2", "n1", "node_completed", "2026-01-01T00:00:03.000Z"),
    ];
    expect(calculateAgentResponseTime(events)).toBe(2000);
  });

  it("pairs on (taskId, nodeId) so identical node ids do not cross tasks", () => {
    const events = [
      event("t1", "n1", "node_started", "2026-01-01T00:00:00.000Z"),
      event("t2", "n1", "node_started", "2026-01-01T00:00:05.000Z"),
      event("t1", "n1", "node_completed", "2026-01-01T00:00:10.000Z"),
    ];
    expect(calculateAgentResponseTime(events)).toBe(10_000);
  });

  it("counts failures as responses", () => {
    const events = [
      event("t1", "n1", "node_started", "2026-01-01T00:00:00.000Z"),
      event("t1", "n1", "node_failed", "2026-01-01T00:00:00.500Z"),
    ];
    expect(calculateAgentResponseTime(events)).toBe(500);
  });

  it("ignores still-running nodes and completions with no start", () => {
    const events = [
      event("t1", "n1", "node_started", "2026-01-01T00:00:00.000Z"),
      event("t2", "n2", "node_completed", "2026-01-01T00:00:04.000Z"),
    ];
    expect(calculateAgentResponseTime(events)).toBe(0);
  });

  it("sorts events by timestamp before pairing", () => {
    const events = [
      event("t1", "n1", "node_completed", "2026-01-01T00:00:02.000Z"),
      event("t1", "n1", "node_started", "2026-01-01T00:00:00.000Z"),
    ];
    expect(calculateAgentResponseTime(events)).toBe(2000);
  });

  it("skips events without a node id or with an unparseable timestamp", () => {
    const events = [
      event("t1", null, "node_started", "2026-01-01T00:00:00.000Z"),
      event("t1", null, "node_completed", "2026-01-01T00:00:02.000Z"),
      event("t2", "n1", "node_started", "not-a-date"),
      event("t2", "n1", "node_completed", "2026-01-01T00:00:02.000Z"),
    ];
    expect(calculateAgentResponseTime(events)).toBe(0);
  });
});

// ── deriveDashboardStatus ────────────────────────────────────────────────────

describe("deriveDashboardStatus", () => {
  it("is healthy when every dependency is ok", () => {
    expect(deriveDashboardStatus(OK_DEPENDENCIES)).toBe("healthy");
  });

  it("is unhealthy when SQLite is unreachable", () => {
    expect(
      deriveDashboardStatus({
        ...OK_DEPENDENCIES,
        sqlite: { status: "unreachable" },
      }),
    ).toBe("unhealthy");
  });

  it("is degraded when an external dependency is unreachable", () => {
    expect(
      deriveDashboardStatus({
        ...OK_DEPENDENCIES,
        venice: { status: "unreachable" },
      }),
    ).toBe("degraded");
  });

  it("is degraded when a dependency is degraded", () => {
    expect(
      deriveDashboardStatus({
        ...OK_DEPENDENCIES,
        stellarHorizon: { status: "degraded" },
      }),
    ).toBe("degraded");
  });

  it("stays healthy when a dependency is merely unknown", () => {
    expect(
      deriveDashboardStatus({
        ...OK_DEPENDENCIES,
        websocket: { status: "unknown" },
      }),
    ).toBe("healthy");
  });
});

// ── MetricsService ───────────────────────────────────────────────────────────

describe("MetricsService", () => {
  const AGENTS: AgentMetrics = {
    total: 2,
    online: 1,
    offline: 1,
    avgResponseTimeMs: 42,
  };
  const TASKS: TaskMetrics = {
    total: 4,
    active: 1,
    queued: 1,
    completed: 1,
    failed: 1,
    cancelled: 0,
  };
  const PAYMENTS: PaymentMetrics = {
    locked: { count: 1, stroops: "10000000", xlm: 1 },
    released: { count: 1, stroops: "20000000", xlm: 2 },
    refunded: { count: 0, stroops: "0", xlm: 0 },
  };

  /** Build a service whose every source is stubbed and whose clock is manual. */
  function buildService(overrides: Record<string, unknown> = {}) {
    let now = 1_000_000;
    const collectAgents = jest.fn(() => AGENTS);
    const service = new MetricsService({
      cacheTtlMs: 5_000,
      windowMs: 60_000,
      maxSamples: 5,
      clock: () => now,
      sources: {
        checkSqlite: () => ({ status: "ok" as const }),
        checkVenice: () => ({ status: "ok" as const }),
        checkStellarHorizon: () => ({ status: "ok" as const }),
        checkWebSocket: () => ({ status: "ok" as const }),
        collectAgents,
        collectTasks: () => TASKS,
        collectPayments: () => PAYMENTS,
        ...overrides,
      },
    });
    return {
      service,
      collectAgents,
      advance: (ms: number) => {
        now += ms;
      },
      nowRef: () => now,
    };
  }

  it("records requests and derives metrics from them", () => {
    const { service } = buildService();
    service.recordRequest(100, 200);
    service.recordRequest(300, 500);

    const metrics = service.getRequestMetrics();
    expect(metrics.totalRequests).toBe(2);
    expect(metrics.avgResponseTimeMs).toBe(200);
    expect(metrics.serverErrorCount).toBe(1);
    expect(metrics.errorRate).toBe(0.5);
  });

  it("caps retained samples at maxSamples, discarding the oldest", () => {
    const { service } = buildService();
    for (let i = 0; i < 10; i++) service.recordRequest(i, 200);

    const samples = service.getSamples();
    expect(samples).toHaveLength(5);
    expect(samples.map((s) => s.durationMs)).toEqual([5, 6, 7, 8, 9]);
  });

  it("drops samples that fall out of the rolling window", () => {
    const { service, advance } = buildService();
    service.recordRequest(100, 200);
    advance(61_000);
    service.recordRequest(200, 200);

    const metrics = service.getRequestMetrics();
    expect(metrics.totalRequests).toBe(1);
    expect(metrics.avgResponseTimeMs).toBe(200);
  });

  it("assembles every metric family into the dashboard", async () => {
    const { service } = buildService();
    service.recordRequest(50, 200);

    const dashboard = await service.getDashboard();
    expect(dashboard.status).toBe("healthy");
    expect(dashboard.agents).toEqual(AGENTS);
    expect(dashboard.tasks).toEqual(TASKS);
    expect(dashboard.payments).toEqual(PAYMENTS);
    expect(dashboard.requests.totalRequests).toBe(1);
    expect(dashboard.dependencies.sqlite.status).toBe("ok");
    expect(dashboard.system.memory.rssBytes).toBeGreaterThan(0);
    expect(dashboard.system.uptimeSeconds).toBeGreaterThanOrEqual(0);
    expect(dashboard.cacheTtlMs).toBe(5_000);
    expect(dashboard.cacheAgeMs).toBe(0);
    expect(new Date(dashboard.timestamp).toISOString()).toBe(dashboard.timestamp);
  });

  it("serves the cached snapshot until the TTL expires", async () => {
    const { service, collectAgents, advance } = buildService();

    await service.getDashboard();
    advance(4_000);
    const cached = await service.getDashboard();

    expect(collectAgents).toHaveBeenCalledTimes(1);
    expect(cached.cacheAgeMs).toBe(4_000);
  });

  it("recollects once the TTL has elapsed", async () => {
    const { service, collectAgents, advance } = buildService();

    await service.getDashboard();
    advance(5_001);
    const fresh = await service.getDashboard();

    expect(collectAgents).toHaveBeenCalledTimes(2);
    expect(fresh.cacheAgeMs).toBe(0);
  });

  it("bypasses the cache when forced", async () => {
    const { service, collectAgents } = buildService();

    await service.getDashboard();
    await service.getDashboard(true);

    expect(collectAgents).toHaveBeenCalledTimes(2);
  });

  it("collapses concurrent cache misses onto a single collection", async () => {
    const { service, collectAgents } = buildService();

    await Promise.all([
      service.getDashboard(),
      service.getDashboard(),
      service.getDashboard(),
    ]);

    expect(collectAgents).toHaveBeenCalledTimes(1);
  });

  it("recollects after the cache is reset", async () => {
    const { service, collectAgents } = buildService();

    await service.getDashboard();
    service.resetCache();
    await service.getDashboard();

    expect(collectAgents).toHaveBeenCalledTimes(2);
  });

  it("clears recorded samples on resetSamples", () => {
    const { service } = buildService();
    service.recordRequest(10, 200);
    service.resetSamples();
    expect(service.getSamples()).toHaveLength(0);
  });

  it("reports a failing dependency probe as unreachable", async () => {
    const { service } = buildService({
      checkVenice: () => {
        throw new Error("boom");
      },
    });

    const dashboard = await service.getDashboard();
    expect(dashboard.dependencies.venice.status).toBe("unreachable");
    expect(dashboard.dependencies.venice.error).toBe("boom");
    expect(dashboard.status).toBe("degraded");
  });

  it("falls back to zeroed domain metrics when a collector throws", async () => {
    const { service } = buildService({
      collectTasks: () => {
        throw new Error("table missing");
      },
    });

    const dashboard = await service.getDashboard();
    expect(dashboard.tasks).toEqual({
      total: 0,
      active: 0,
      queued: 0,
      completed: 0,
      failed: 0,
      cancelled: 0,
    });
    // A failed collector must not take the whole dashboard down.
    expect(dashboard.status).toBe("healthy");
  });

  /**
   * Build a service with every source stubbed **except** the WebSocket probe,
   * so the real `checkWebSocket` path is exercised without any network or disk.
   */
  function buildWithRealWebSocketProbe(): MetricsService {
    return new MetricsService({
      cacheTtlMs: 0,
      sources: {
        checkSqlite: () => ({ status: "ok" as const }),
        checkVenice: () => ({ status: "ok" as const }),
        checkStellarHorizon: () => ({ status: "ok" as const }),
        collectAgents: () => AGENTS,
        collectTasks: () => TASKS,
        collectPayments: () => PAYMENTS,
      },
    });
  }

  it("reports the WebSocket dependency from the registered probe", async () => {
    const service = buildWithRealWebSocketProbe();
    service.setWebSocketProbe(() => ({ listening: true, connections: 3 }));

    const dashboard = await service.getDashboard(true);
    expect(dashboard.dependencies.websocket.status).toBe("ok");
    expect(dashboard.dependencies.websocket.details).toEqual({ connections: 3 });
  });

  it("reports WebSocket as unknown when no probe is registered", async () => {
    const service = buildWithRealWebSocketProbe();
    service.setWebSocketProbe(null);

    const dashboard = await service.getDashboard(true);
    expect(dashboard.dependencies.websocket.status).toBe("unknown");
  });

  it("reports WebSocket as unreachable when the server is not listening", async () => {
    const service = buildWithRealWebSocketProbe();
    service.setWebSocketProbe(() => ({ listening: false, connections: 0 }));

    const dashboard = await service.getDashboard(true);
    expect(dashboard.dependencies.websocket.status).toBe("unreachable");
  });

  it("starts and stops the GC observer without throwing", () => {
    const { service } = buildService();
    service.startGcObserver();
    service.startGcObserver(); // idempotent
    expect(service.getSystemMetrics().gc.available).toBe(true);
    service.stopGcObserver();
  });
});
