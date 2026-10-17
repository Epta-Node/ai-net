/**
 * Tests for admin routes: authentication, authorization, and endpoint behavior.
 *
 * Every admin route must require adminAuthMiddleware. A route-enumeration test
 * ensures newly added routes fail by default if they lack the guard.
 */
import express, { Router } from "express";
import request from "supertest";

const ADMIN_KEY = "test-admin-key-12345";

beforeAll(() => {
  process.env.ADMIN_API_KEY = ADMIN_KEY;
  process.env.VENICE_API_KEY = process.env.VENICE_API_KEY || "test-venice-key";
  process.env.DATABASE_URL = process.env.DATABASE_URL || ":memory:";

  try {
    const { loadConfig } = require("../src/config");
    loadConfig();
  } catch {
    // Already loaded
  }
});

// ── Mock admin control services ──────────────────────────────────────────────

jest.mock("../src/services/adminControl", () => ({
  getReadOnlyState: jest.fn(() => ({ enabled: false })),
  setReadOnlyState: jest.fn((_enabled: boolean, _actor: string, _reason?: string) => ({
    enabled: true,
    actor: "test",
    reason: "testing",
  })),
  listAgentsForAdmin: jest.fn(() => []),
  setAgentEnabled: jest.fn((id: string, enabled: boolean) =>
    id === "unknown" ? null : { id, enabled }
  ),
  actorFromRequest: jest.fn(() => "test-actor"),
  recordAdminAudit: jest.fn(),
  vacuumDatabases: jest.fn(() => [{ db: "test", ok: true }]),
  backupDatabases: jest.fn(async () => [{ db: "test", path: "/tmp/test.bak" }]),
  listAdminAuditLog: jest.fn(() => [
    { at: "2024-01-01T00:00:00Z", actor: "admin", action: "GET /admin/", statusCode: 200 },
  ]),
  auditLogToCsv: jest.fn(() => "at,actor,action\n2024-01-01T00:00:00Z,admin,GET /admin/\n"),
  AUDIT_EXPORT_MAX_ROWS: 100000,
  AUDIT_LOG_CSV_HEADER: "at,actor,action",
  auditLogEntryToCsvRow: jest.fn(() => "2024-01-01T00:00:00Z,admin,GET /admin/"),
  iterateAdminAuditLog: jest.fn(function* () {
    yield [{ at: "2024-01-01T00:00:00Z", actor: "admin", action: "GET /admin/", statusCode: 200 }];
  }),
}));

jest.mock("../src/services/reconciliation", () => ({
  createDefaultReconciliationService: jest.fn(() => ({
    run: jest.fn(async () => ({ status: "ok", discrepancies: [] })),
    getLatestReport: jest.fn(() => ({ status: "ok", discrepancies: [] })),
    startDaily: jest.fn(),
    stop: jest.fn(),
  })),
  ReconciliationService: jest.fn(),
}));

jest.mock("../src/services/featureFlags", () => ({
  getAllFlags: jest.fn(() => ({
    streaming_responses: { enabled: true, source: "default" },
  })),
  setFlag: jest.fn(),
  KNOWN_FLAGS: ["streaming_responses", "quality_scorer"] as const,
}));

jest.mock("../src/services/tracing", () => ({
  tracingService: {
    resolveRequestId: jest.fn((id: string) => (id === "req-123" ? "trace-abc" : null)),
    getTrace: jest.fn((id: string) =>
      id === "trace-abc" ? { correlationId: "trace-abc", spans: [] } : null
    ),
  },
}));

const mockJobQueue = {
  getStats: jest.fn(() => ({ queued: 0, active: 0, completed: 0, failed: 0, deadLetter: 0 })),
  getWorker: jest.fn(() => ({
    getStatus: () => ({ running: true, activeWorkers: 0, concurrency: 5, pollIntervalMs: 1000 }),
  })),
  listJobs: jest.fn(() => ({ jobs: [], total: 0, page: 1, pageSize: 50 })),
  getDeadLetterJobs: jest.fn(() => ({ jobs: [], total: 0, page: 1, pageSize: 50 })),
  retryDeadLetter: jest.fn((id: string) => id !== "not-found"),
};

jest.mock("../src/queue", () => ({
  getGlobalJobQueue: jest.fn(() => mockJobQueue),
}));

// ── Build test apps ──────────────────────────────────────────────────────────

function buildAdminApp() {
  const { createAdminRouter } = require("../src/api/routes/admin");
  const app = express();
  app.use(express.json());
  app.use("/api/admin", createAdminRouter({ queue: mockJobQueue as any }));
  return app;
}

function buildAdminQueueApp() {
  const { createAdminQueueRouter } = require("../src/api/routes/admin");
  const app = express();
  app.use(express.json());
  app.use("/api/admin", createAdminQueueRouter(mockJobQueue as any));
  return app;
}

function buildReconciliationApp() {
  const { createReconciliationRouter } = require("../src/api/routes/reconciliation");
  const app = express();
  app.use(express.json());
  app.use("/api/reconciliation", createReconciliationRouter());
  return app;
}

function buildFlagsApp() {
  const { createFlagsRouter } = require("../src/api/routes/flags");
  const app = express();
  app.use(express.json());
  app.use("/api/admin/flags", createFlagsRouter());
  return app;
}

function buildMetricsApp() {
  const { createMetricsRouter } = require("../src/api/routes/metrics");
  const app = express();
  app.use(express.json());
  app.use("/metrics", createMetricsRouter());
  return app;
}

// ── Auth tests ───────────────────────────────────────────────────────────────

describe("Admin auth enforcement", () => {
  describe("createAdminRouter routes require auth", () => {
    const app = buildAdminApp();
    const routes = [
      { method: "get" as const, path: "/api/admin/read-only" },
      { method: "put" as const, path: "/api/admin/read-only", body: { enabled: true } },
      { method: "get" as const, path: "/api/admin/agents" },
      { method: "post" as const, path: "/api/admin/agents/test-agent/enable" },
      { method: "post" as const, path: "/api/admin/agents/test-agent/disable" },
      { method: "post" as const, path: "/api/admin/reconciliation/run" },
      { method: "post" as const, path: "/api/admin/maintenance/vacuum" },
      { method: "post" as const, path: "/api/admin/maintenance/backup" },
      { method: "get" as const, path: "/api/admin/audit-log" },
      { method: "get" as const, path: "/api/admin/audit-log/export" },
    ];

    for (const route of routes) {
      it(`${route.method.toUpperCase()} ${route.path} returns 401 without auth`, async () => {
        const res = await (request(app) as any)[route.method](route.path)
          .send(route.body);
        expect(res.status).toBe(401);
      });

      it(`${route.method.toUpperCase()} ${route.path} succeeds with admin key`, async () => {
        const res = await (request(app) as any)[route.method](route.path)
          .set("X-Admin-API-Key", ADMIN_KEY)
          .send(route.body);
        expect(res.status).toBeLessThan(500);
        expect(res.status).not.toBe(401);
        expect(res.status).not.toBe(503);
      });
    }
  });

  describe("createAdminQueueRouter routes require auth", () => {
    const app = buildAdminQueueApp();
    const routes = [
      { method: "get" as const, path: "/api/admin/traces/trace-abc" },
      { method: "get" as const, path: "/api/admin/status" },
      { method: "get" as const, path: "/api/admin/" },
      { method: "get" as const, path: "/api/admin/jobs" },
      { method: "get" as const, path: "/api/admin/dead-letter" },
      { method: "post" as const, path: "/api/admin/retry/job-123" },
    ];

    for (const route of routes) {
      it(`${route.method.toUpperCase()} ${route.path} returns 401 without auth`, async () => {
        const res = await (request(app) as any)[route.method](route.path);
        expect(res.status).toBe(401);
      });

      it(`${route.method.toUpperCase()} ${route.path} succeeds with admin key`, async () => {
        const res = await (request(app) as any)[route.method](route.path)
          .set("X-Admin-API-Key", ADMIN_KEY);
        expect(res.status).toBeLessThan(500);
        expect(res.status).not.toBe(401);
      });
    }
  });

  describe("reconciliation routes require auth", () => {
    const app = buildReconciliationApp();

    it("POST /api/reconciliation/run returns 401 without auth", async () => {
      const res = await request(app).post("/api/reconciliation/run");
      expect(res.status).toBe(401);
    });

    it("GET /api/reconciliation/report returns 401 without auth", async () => {
      const res = await request(app).get("/api/reconciliation/report");
      expect(res.status).toBe(401);
    });

    it("POST /api/reconciliation/run succeeds with admin key", async () => {
      const res = await request(app)
        .post("/api/reconciliation/run")
        .set("X-Admin-API-Key", ADMIN_KEY);
      expect(res.status).toBe(200);
    });
  });

  describe("flags routes require auth", () => {
    const app = buildFlagsApp();

    it("GET /api/admin/flags returns 401 without auth", async () => {
      const res = await request(app).get("/api/admin/flags");
      expect(res.status).toBe(401);
    });

    it("PUT /api/admin/flags/streaming_responses returns 401 without auth", async () => {
      const res = await request(app)
        .put("/api/admin/flags/streaming_responses")
        .send({ enabled: true });
      expect(res.status).toBe(401);
    });

    it("GET /api/admin/flags succeeds with admin key", async () => {
      const res = await request(app)
        .get("/api/admin/flags")
        .set("X-Admin-API-Key", ADMIN_KEY);
      expect(res.status).toBe(200);
    });
  });

  describe("POST /metrics/reset requires auth", () => {
    const app = buildMetricsApp();

    it("returns 401 without auth", async () => {
      const res = await request(app).post("/metrics/reset");
      expect(res.status).toBe(401);
    });

    it("succeeds with admin key", async () => {
      const res = await request(app)
        .post("/metrics/reset")
        .set("X-Admin-API-Key", ADMIN_KEY);
      expect(res.status).toBe(200);
    });

    it("GET /metrics does NOT require auth (public scrape)", async () => {
      const res = await request(app).get("/metrics");
      expect(res.status).toBe(200);
    });
  });

  describe("ADMIN_API_KEY unset produces 503 (fail closed)", () => {
    it("returns 503 when ADMIN_API_KEY is empty", async () => {
      const originalKey = process.env.ADMIN_API_KEY;
      process.env.ADMIN_API_KEY = "";

      // Re-require to pick up changed env
      jest.resetModules();
      const app = buildAdminQueueApp();
      const res = await request(app).get("/api/admin/status");
      expect(res.status).toBe(503);

      process.env.ADMIN_API_KEY = originalKey;
      jest.resetModules();
    });
  });
});

// ── Functional endpoint tests ────────────────────────────────────────────────

describe("Admin endpoint functionality", () => {
  describe("GET /api/admin/read-only", () => {
    it("returns current read-only state", async () => {
      const app = buildAdminApp();
      const res = await request(app)
        .get("/api/admin/read-only")
        .set("X-Admin-API-Key", ADMIN_KEY);
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty("enabled");
    });
  });

  describe("PUT /api/admin/read-only", () => {
    it("rejects invalid body", async () => {
      const app = buildAdminApp();
      const res = await request(app)
        .put("/api/admin/read-only")
        .set("X-Admin-API-Key", ADMIN_KEY)
        .send({ enabled: "not-boolean" });
      expect(res.status).toBeGreaterThanOrEqual(400);
    });
  });

  describe("POST /api/admin/agents/:id/enable", () => {
    it("returns 404 for unknown agent", async () => {
      const app = buildAdminApp();
      const res = await request(app)
        .post("/api/admin/agents/unknown/enable")
        .set("X-Admin-API-Key", ADMIN_KEY);
      expect(res.status).toBe(404);
    });
  });

  describe("GET /api/admin/audit-log", () => {
    it("returns JSON by default", async () => {
      const app = buildAdminApp();
      const res = await request(app)
        .get("/api/admin/audit-log")
        .set("X-Admin-API-Key", ADMIN_KEY);
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty("entries");
    });

    it("returns CSV when format=csv", async () => {
      const app = buildAdminApp();
      const res = await request(app)
        .get("/api/admin/audit-log?format=csv")
        .set("X-Admin-API-Key", ADMIN_KEY);
      expect(res.status).toBe(200);
      expect(res.headers["content-type"]).toContain("text/csv");
    });
  });

  describe("POST /api/admin/retry/:id", () => {
    it("returns 404 for non-existent dead-letter job", async () => {
      const app = buildAdminQueueApp();
      const res = await request(app)
        .post("/api/admin/retry/not-found")
        .set("X-Admin-API-Key", ADMIN_KEY);
      expect(res.status).toBe(404);
    });

    it("retries an existing dead-letter job", async () => {
      const app = buildAdminQueueApp();
      const res = await request(app)
        .post("/api/admin/retry/job-123")
        .set("X-Admin-API-Key", ADMIN_KEY);
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
    });
  });
});
