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

const mockDlq = {
  list: jest.fn(() => ({
    deadLetters: [
      {
        jobId: "job-dlq-1",
        taskId: "task-dlq-1",
        failureReason: "max attempts exceeded (3/3): boom",
        failedAt: "2026-10-17T10:00:00.000Z",
        retryCount: 3,
        originalPayload: { taskId: "task-dlq-1" },
      },
    ],
    total: 1,
    page: 1,
    pageSize: 50,
  })),
  replay: jest.fn((id: string) => id === "job-dlq-1"),
};

const mockJobQueue = {
  getStats: jest.fn(() => ({ queued: 0, active: 0, completed: 0, failed: 0, deadLetter: 0 })),
  getWorker: jest.fn(() => ({
    getStatus: () => ({ running: true, activeWorkers: 0, concurrency: 5, pollIntervalMs: 1000 }),
  })),
  listJobs: jest.fn(() => ({ jobs: [], total: 0, page: 1, pageSize: 50 })),
  getDeadLetterJobs: jest.fn(() => ({ jobs: [], total: 0, page: 1, pageSize: 50 })),
  retryDeadLetter: jest.fn((id: string) => id !== "not-found"),
  getDeadLetterQueue: jest.fn(() => mockDlq),
  purgeDeadLetters: jest.fn(() => 3),
};

jest.mock("../src/queue", () => ({
  getGlobalJobQueue: jest.fn(() => mockJobQueue),
}));

// ── Build test apps ──────────────────────────────────────────────────────────

// Earlier tests in this file call jest.resetModules(), which makes subsequent
// requires load fresh module instances. Always resolve the audit mock lazily
// (AFTER the app under test is built) so the assertion sees the same instance
// the route handlers call.
function auditMock(): { recordAdminAudit: jest.Mock } {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  return require("../src/services/adminControl");
}

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

  describe("Dead-letter queue routes (issue #802)", () => {
    beforeEach(() => {
      jest.clearAllMocks();
    });

    it("GET /dlq lists parked jobs", async () => {
      const app = buildAdminQueueApp();
      const res = await request(app)
        .get("/api/admin/dlq")
        .set("X-Admin-API-Key", ADMIN_KEY);

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        total: 1,
        page: 1,
        deadLetters: [expect.objectContaining({ jobId: "job-dlq-1", taskId: "task-dlq-1" })],
      });
    });

    it("GET /dlq rejects an invalid page size", async () => {
      const app = buildAdminQueueApp();
      const res = await request(app)
        .get("/api/admin/dlq?pageSize=9999")
        .set("X-Admin-API-Key", ADMIN_KEY);
      expect(res.status).toBe(400);
    });

    it("POST /dlq/:jobId/replay requeues a parked job with 202", async () => {
      const app = buildAdminQueueApp();
      const res = await request(app)
        .post("/api/admin/dlq/job-dlq-1/replay")
        .set("X-Admin-API-Key", ADMIN_KEY);

      expect(res.status).toBe(202);
      expect(res.body).toMatchObject({ success: true, status: "requeued", jobId: "job-dlq-1" });
      expect(mockDlq.replay).toHaveBeenCalledWith("job-dlq-1");
      expect(auditMock().recordAdminAudit).toHaveBeenCalledWith(
        expect.objectContaining({ action: "queue.dlq.replay", target: "job-dlq-1" }),
      );
    });

    it("POST /dlq/:jobId/replay returns 404 when the job is not parked", async () => {
      const app = buildAdminQueueApp();
      const res = await request(app)
        .post("/api/admin/dlq/job-elsewhere/replay")
        .set("X-Admin-API-Key", ADMIN_KEY);
      expect(res.status).toBe(404);
    });

    it("DELETE /dlq purges with the requested retention and audits it", async () => {
      const app = buildAdminQueueApp();
      const res = await request(app)
        .delete("/api/admin/dlq?days=7")
        .set("X-Admin-API-Key", ADMIN_KEY);

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ success: true, purged: 3, days: 7 });
      expect(mockJobQueue.purgeDeadLetters).toHaveBeenCalledWith(7);
      expect(auditMock().recordAdminAudit).toHaveBeenCalledWith(
        expect.objectContaining({ action: "queue.dlq.purge" }),
      );
    });

    it("DELETE /dlq without days purges everything", async () => {
      const app = buildAdminQueueApp();
      const res = await request(app).delete("/api/admin/dlq").set("X-Admin-API-Key", ADMIN_KEY);

      expect(res.status).toBe(200);
      expect(mockJobQueue.purgeDeadLetters).toHaveBeenCalledWith(0);
    });

    it("rejects an out-of-range days parameter", async () => {
      const app = buildAdminQueueApp();
      const res = await request(app)
        .delete("/api/admin/dlq?days=-1")
        .set("X-Admin-API-Key", ADMIN_KEY);
      expect(res.status).toBe(400);
    });
  });
});
