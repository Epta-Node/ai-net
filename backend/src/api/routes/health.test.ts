/**
 * Unit tests for GET /health, GET /health/deep, and GET /health/ready routes.
 *
 * Strategy:
 *  - Load config once at the top of the file.
 *  - Mock global `fetch` via jest.spyOn to control Venice and Horizon reachability.
 *  - Mock DB modules for /health/ready tests.
 */
import express from "express";
import request from "supertest";

// ── Bootstrap config before importing the health router ──────────────────────
// The health router's deep-check uses getConfig() which requires loadConfig()
// to have been called. We do that here once for all tests in this file.
beforeAll(() => {
  process.env.VENICE_API_KEY = process.env.VENICE_API_KEY || "test-venice-key";
  process.env.DATABASE_URL = process.env.DATABASE_URL || ":memory:";

  // Initialise config singleton if not already done
  try {
    const { loadConfig } = require("../../config");
    loadConfig();
  } catch {
    // Already loaded — ignore
  }
});

// ── Helpers ──────────────────────────────────────────────────────────────────

function buildApp() {
  const { healthRouter } = require("./health");
  const app = express();
  app.use(express.json());
  app.use("/health", healthRouter);
  return app;
}

// ── GET /health ───────────────────────────────────────────────────────────────

describe("GET /health", () => {
  const app = buildApp();

  it("returns 200 with status ok", async () => {
    const res = await request(app).get("/health");
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("ok");
  });

  it("returns uptime as a non-negative number", async () => {
    const res = await request(app).get("/health");
    expect(typeof res.body.uptime).toBe("number");
    expect(res.body.uptime).toBeGreaterThanOrEqual(0);
  });

  it("returns a version string", async () => {
    const res = await request(app).get("/health");
    expect(typeof res.body.version).toBe("string");
    expect(res.body.version.length).toBeGreaterThan(0);
  });

  it("returns a stellarNetwork string", async () => {
    const res = await request(app).get("/health");
    expect(typeof res.body.stellarNetwork).toBe("string");
  });
});

// ── GET /health/deep ─────────────────────────────────────────────────────────

describe("GET /health/deep", () => {
  let fetchSpy: jest.SpyInstance;

  beforeEach(() => {
    // Spy on global fetch — the router uses the global fetch internally
    fetchSpy = jest.spyOn(global, "fetch" as any);
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it("returns 200 with both ok when all dependencies reachable", async () => {
    fetchSpy.mockResolvedValue({ ok: true } as Response);
    const app = buildApp();
    const res = await request(app).get("/health/deep");
    expect(res.status).toBe(200);
    expect(res.body.venice).toBe("ok");
    expect(res.body.horizon).toBe("ok");
  });

  it("reports venice as unreachable when Venice fetch rejects", async () => {
    fetchSpy.mockImplementation((url: string) => {
      if (url.includes("venice.ai")) {
        return Promise.reject(new Error("network error"));
      }
      return Promise.resolve({ ok: true } as Response);
    });
    const app = buildApp();
    const res = await request(app).get("/health/deep");
    expect(res.status).toBe(200);
    expect(res.body.venice).toBe("unreachable");
    expect(res.body.horizon).toBe("ok");
  });

  it("reports horizon as unreachable when Horizon fetch rejects", async () => {
    fetchSpy.mockImplementation((url: string) => {
      if (url.includes("venice.ai")) {
        return Promise.resolve({ ok: true } as Response);
      }
      return Promise.reject(new Error("network error"));
    });
    const app = buildApp();
    const res = await request(app).get("/health/deep");
    expect(res.status).toBe(200);
    expect(res.body.venice).toBe("ok");
    expect(res.body.horizon).toBe("unreachable");
  });

  it("reports both unreachable when both dependencies return non-ok status", async () => {
    fetchSpy.mockResolvedValue({ ok: false } as Response);
    const app = buildApp();
    const res = await request(app).get("/health/deep");
    expect(res.status).toBe(200);
    expect(res.body.venice).toBe("unreachable");
    expect(res.body.horizon).toBe("unreachable");
  });

  it("reports unreachable when fetch throws an AbortError", async () => {
    const abortError = Object.assign(new Error("aborted"), { name: "AbortError" });
    fetchSpy.mockRejectedValue(abortError);
    const app = buildApp();
    const res = await request(app).get("/health/deep");
    expect(res.status).toBe(200);
    expect(res.body.venice).toBe("unreachable");
    expect(res.body.horizon).toBe("unreachable");
  });
});

// ── GET /health/ready ─────────────────────────────────────────────────────────

describe("GET /health/ready", () => {
  it("returns 200 or 500 with structured checks response", async () => {
    // The /health/ready endpoint performs dynamic imports of DB modules and
    // runs SELECT 1 against them. In the test environment without real DB files
    // it may return 200 or 500 depending on the SQLite setup. We validate
    // the response shape is always present regardless of status.
    const app = buildApp();
    const res = await request(app).get("/health/ready");
    // Status must be one of the expected values
    expect([200, 500]).toContain(res.status);
    // Body must have a status and a checks object
    expect(res.body).toHaveProperty("checks");
    expect(["ok", "error"]).toContain(res.body.status);
  });

  it("checks object always has tasks and payments keys", async () => {
    const app = buildApp();
    const res = await request(app).get("/health/ready");
    expect(res.body.checks).toHaveProperty("tasks");
    expect(res.body.checks).toHaveProperty("payments");
  });
});

// ── GET /health/dashboard ────────────────────────────────────────────────────

describe("GET /health/dashboard", () => {
  const ADMIN_KEY = "test-admin-key";

  /** A fully-populated snapshot, so route assertions never touch I/O. */
  function fakeDashboard() {
    return {
      status: "healthy",
      timestamp: "2026-01-01T00:00:00.000Z",
      version: "0.1.0",
      stellarNetwork: "testnet",
      cacheAgeMs: 0,
      cacheTtlMs: 5000,
      requests: {
        totalRequests: 3,
        windowMs: 60000,
        requestRatePerSecond: 0.05,
        avgResponseTimeMs: 12.5,
        p95ResponseTimeMs: 30,
        p99ResponseTimeMs: 40,
        errorRate: 0.33,
        serverErrorCount: 1,
        clientErrorCount: 0,
      },
      dependencies: {
        sqlite: { status: "ok", latencyMs: 1 },
        venice: { status: "ok", latencyMs: 20 },
        stellarHorizon: { status: "ok", latencyMs: 30 },
        websocket: { status: "ok", details: { connections: 2 } },
      },
      system: {
        uptimeSeconds: 120,
        memory: {
          rssBytes: 1000,
          heapTotalBytes: 800,
          heapUsedBytes: 400,
          externalBytes: 100,
          heapUsedPercent: 50,
        },
        cpu: {
          userMs: 10,
          systemMs: 5,
          usagePercent: 1.5,
          loadAverage: [0.1, 0.2, 0.3],
          cpuCount: 8,
        },
        gc: {
          available: true,
          collections: 2,
          totalPauseMs: 4,
          avgPauseMs: 2,
          lastPauseMs: 1,
        },
      },
      agents: { total: 2, online: 1, offline: 1, avgResponseTimeMs: 42 },
      tasks: { total: 4, active: 1, queued: 1, completed: 1, failed: 1, cancelled: 0 },
      payments: {
        locked: { count: 1, stroops: "10000000", xlm: 1 },
        released: { count: 1, stroops: "20000000", xlm: 2 },
        refunded: { count: 0, stroops: "0", xlm: 0 },
      },
    };
  }

  let dashboardSpy: jest.SpyInstance;
  let originalKey: string | undefined;

  beforeEach(() => {
    originalKey = process.env.ADMIN_API_KEY;
    process.env.ADMIN_API_KEY = ADMIN_KEY;

    const { metricsService } = require("../../services/metrics");
    dashboardSpy = jest
      .spyOn(metricsService, "getDashboard")
      .mockResolvedValue(fakeDashboard());
  });

  afterEach(() => {
    dashboardSpy.mockRestore();
    if (originalKey === undefined) delete process.env.ADMIN_API_KEY;
    else process.env.ADMIN_API_KEY = originalKey;
  });

  // ── Admin API key protection ───────────────────────────────────────────────

  it("returns 401 when no admin API key is supplied", async () => {
    const res = await request(buildApp()).get("/health/dashboard");
    expect(res.status).toBe(401);
    expect(res.body.error).toBe("Unauthorized");
    expect(dashboardSpy).not.toHaveBeenCalled();
  });

  it("returns 401 when the admin API key is wrong", async () => {
    const res = await request(buildApp())
      .get("/health/dashboard")
      .set("X-Admin-API-Key", "wrong-key");
    expect(res.status).toBe(401);
    expect(dashboardSpy).not.toHaveBeenCalled();
  });

  it("returns 401 when the key is a prefix of the configured key", async () => {
    const res = await request(buildApp())
      .get("/health/dashboard")
      .set("X-Admin-API-Key", ADMIN_KEY.slice(0, 5));
    expect(res.status).toBe(401);
  });

  it("returns 503 when ADMIN_API_KEY is not configured", async () => {
    delete process.env.ADMIN_API_KEY;
    const res = await request(buildApp())
      .get("/health/dashboard")
      .set("X-Admin-API-Key", ADMIN_KEY);
    expect(res.status).toBe(503);
    expect(res.body.error).toBe("Admin API not configured");
    expect(dashboardSpy).not.toHaveBeenCalled();
  });

  it("accepts the key via the X-Admin-API-Key header", async () => {
    const res = await request(buildApp())
      .get("/health/dashboard")
      .set("X-Admin-API-Key", ADMIN_KEY);
    expect(res.status).toBe(200);
  });

  it("accepts the key via an Authorization Bearer header", async () => {
    const res = await request(buildApp())
      .get("/health/dashboard")
      .set("Authorization", `Bearer ${ADMIN_KEY}`);
    expect(res.status).toBe(200);
  });

  // ── Payload shape ──────────────────────────────────────────────────────────

  it("returns every metric family in the payload", async () => {
    const res = await request(buildApp())
      .get("/health/dashboard")
      .set("X-Admin-API-Key", ADMIN_KEY);

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("status", "healthy");
    expect(res.body).toHaveProperty("timestamp");
    expect(res.body).toHaveProperty("requests");
    expect(res.body).toHaveProperty("dependencies");
    expect(res.body).toHaveProperty("system");
    expect(res.body).toHaveProperty("agents");
    expect(res.body).toHaveProperty("tasks");
    expect(res.body).toHaveProperty("payments");
  });

  it("reports request rate, latency percentiles and error rate", async () => {
    const res = await request(buildApp())
      .get("/health/dashboard")
      .set("X-Admin-API-Key", ADMIN_KEY);

    expect(res.body.requests).toMatchObject({
      requestRatePerSecond: 0.05,
      avgResponseTimeMs: 12.5,
      p95ResponseTimeMs: 30,
      p99ResponseTimeMs: 40,
      errorRate: 0.33,
    });
  });

  it("reports the status of every tracked dependency", async () => {
    const res = await request(buildApp())
      .get("/health/dashboard")
      .set("X-Admin-API-Key", ADMIN_KEY);

    expect(Object.keys(res.body.dependencies).sort()).toEqual([
      "sqlite",
      "stellarHorizon",
      "venice",
      "websocket",
    ]);
    expect(res.body.dependencies.websocket.details.connections).toBe(2);
  });

  it("reports memory, CPU, uptime and GC statistics", async () => {
    const res = await request(buildApp())
      .get("/health/dashboard")
      .set("X-Admin-API-Key", ADMIN_KEY);

    expect(res.body.system.memory.heapUsedPercent).toBe(50);
    expect(res.body.system.cpu.usagePercent).toBe(1.5);
    expect(res.body.system.uptimeSeconds).toBe(120);
    expect(res.body.system.gc.avgPauseMs).toBe(2);
  });

  it("reports agent, task and payment counters", async () => {
    const res = await request(buildApp())
      .get("/health/dashboard")
      .set("X-Admin-API-Key", ADMIN_KEY);

    expect(res.body.agents).toEqual({
      total: 2,
      online: 1,
      offline: 1,
      avgResponseTimeMs: 42,
    });
    expect(res.body.tasks.active).toBe(1);
    expect(res.body.tasks.queued).toBe(1);
    expect(res.body.tasks.completed).toBe(1);
    expect(res.body.tasks.failed).toBe(1);
    expect(res.body.payments.locked.xlm).toBe(1);
    expect(res.body.payments.released.xlm).toBe(2);
    expect(res.body.payments.refunded.xlm).toBe(0);
  });

  // ── Caching ────────────────────────────────────────────────────────────────

  it("serves the cached snapshot by default", async () => {
    await request(buildApp())
      .get("/health/dashboard")
      .set("X-Admin-API-Key", ADMIN_KEY);
    expect(dashboardSpy).toHaveBeenCalledWith(false);
  });

  it("forces a refresh when ?refresh=true is supplied", async () => {
    await request(buildApp())
      .get("/health/dashboard?refresh=true")
      .set("X-Admin-API-Key", ADMIN_KEY);
    expect(dashboardSpy).toHaveBeenCalledWith(true);
  });

  // ── Failure handling ───────────────────────────────────────────────────────

  it("returns 500 with a structured body when collection fails", async () => {
    dashboardSpy.mockRejectedValue(new Error("collection exploded"));

    const res = await request(buildApp())
      .get("/health/dashboard")
      .set("X-Admin-API-Key", ADMIN_KEY);

    expect(res.status).toBe(500);
    expect(res.body.status).toBe("unhealthy");
    expect(res.body.error).toBe("Failed to collect metrics");
    expect(res.body.message).toBe("collection exploded");
  });
});
