/**
 * Tests for issue #650: Admin job listing pageSize is unclamped and NaN-prone.
 * Route-level (AC3) tests — run with the default jest config (mocked SQLite).
 *
 * Store-level (AC1, AC2, AC4) clamp tests live in tests/sqlite/jobStore.pagination.test.ts
 * and run via `npm run test:sqlite` (real SQLite, no mock).
 *
 * Acceptance criteria covered here:
 *  AC3: pageSize=abc returns 400, not 500 (route-level Zod validation)
 *  AC1: pageSize=-1 returns 400 at the route boundary (.min(1) constraint)
 *  AC2: pageSize=1e9 returns 400 at the route boundary (.max(100) constraint)
 */

import express from "express";
import request from "supertest";

const ADMIN_KEY = "test-admin-key-650";

beforeAll(() => {
  process.env.ADMIN_API_KEY = ADMIN_KEY;
  process.env.VENICE_API_KEY = process.env.VENICE_API_KEY ?? "test-venice-key";
});

const mockJobQueue = {
  getStats: jest.fn(() => ({ queued: 0, active: 0, completed: 0, failed: 0, deadLetter: 0 })),
  getWorker: jest.fn(() => ({
    getStatus: () => ({ running: false, activeWorkers: 0, concurrency: 5, pollIntervalMs: 1000 }),
  })),
  listJobs: jest.fn(() => ({ jobs: [], total: 0, page: 1, pageSize: 50 })),
  getDeadLetterJobs: jest.fn(() => ({ jobs: [], total: 0, page: 1, pageSize: 50 })),
  retryDeadLetter: jest.fn(() => false),
};

jest.mock("../src/services/adminControl", () => ({
  getReadOnlyState: jest.fn(() => ({ enabled: false })),
  setReadOnlyState: jest.fn(),
  listAgentsForAdmin: jest.fn(() => []),
  setAgentEnabled: jest.fn(() => null),
  actorFromRequest: jest.fn(() => "test-actor"),
  recordAdminAudit: jest.fn(),
  vacuumDatabases: jest.fn(() => []),
  backupDatabases: jest.fn(async () => []),
  listAdminAuditLog: jest.fn(() => []),
  auditLogToCsv: jest.fn(() => ""),
}));

jest.mock("../src/services/reconciliation", () => ({
  createDefaultReconciliationService: jest.fn(() => ({
    run: jest.fn(async () => ({ status: "ok", discrepancies: [] })),
    getLatestReport: jest.fn(() => null),
    startDaily: jest.fn(),
    stop: jest.fn(),
  })),
}));

jest.mock("../src/services/featureFlags", () => ({
  getAllFlags: jest.fn(() => ({})),
  setFlag: jest.fn(),
  KNOWN_FLAGS: [] as const,
}));

jest.mock("../src/services/tracing", () => ({
  tracingService: {
    resolveRequestId: jest.fn(() => null),
    getTrace: jest.fn(() => null),
  },
}));

jest.mock("../src/queue", () => ({
  getGlobalJobQueue: jest.fn(() => mockJobQueue),
}));

function buildQueueApp() {
  const { createAdminQueueRouter } = require("../src/api/routes/admin");
  const app = express();
  app.use(express.json());
  app.use("/api/admin", createAdminQueueRouter(mockJobQueue as any));
  return app;
}

describe("Admin queue routes — input validation (AC3)", () => {
  describe("GET /api/admin/jobs", () => {
    // AC3: non-numeric pageSize must be rejected with 400, not crash with 500
    it("AC3: returns 400 for pageSize=abc (not 500)", async () => {
      const app = buildQueueApp();
      const res = await request(app)
        .get("/api/admin/jobs?pageSize=abc")
        .set("X-Admin-API-Key", ADMIN_KEY);
      expect(res.status).toBe(400);
    });

    it("AC3: returns 400 for page=abc", async () => {
      const app = buildQueueApp();
      const res = await request(app)
        .get("/api/admin/jobs?page=abc")
        .set("X-Admin-API-Key", ADMIN_KEY);
      expect(res.status).toBe(400);
    });

    it("AC3: returns 400 for pageSize=abc&page=abc (reports both errors)", async () => {
      const app = buildQueueApp();
      const res = await request(app)
        .get("/api/admin/jobs?pageSize=abc&page=abc")
        .set("X-Admin-API-Key", ADMIN_KEY);
      expect(res.status).toBe(400);
    });

    // AC1: negative pageSize at the route level is rejected before reaching the store
    it("AC1: returns 400 for pageSize=-1", async () => {
      const app = buildQueueApp();
      const res = await request(app)
        .get("/api/admin/jobs?pageSize=-1")
        .set("X-Admin-API-Key", ADMIN_KEY);
      expect(res.status).toBe(400);
    });

    // AC2: pageSize=1e9 is rejected by the Zod .max(100) constraint
    it("AC2: returns 400 for pageSize=1000000000", async () => {
      const app = buildQueueApp();
      const res = await request(app)
        .get("/api/admin/jobs?pageSize=1000000000")
        .set("X-Admin-API-Key", ADMIN_KEY);
      expect(res.status).toBe(400);
    });

    it("passes valid query parameters and calls listJobs with them", async () => {
      const app = buildQueueApp();
      mockJobQueue.listJobs.mockReturnValueOnce({ jobs: [], total: 0, page: 2, pageSize: 10 });
      const res = await request(app)
        .get("/api/admin/jobs?page=2&pageSize=10")
        .set("X-Admin-API-Key", ADMIN_KEY);
      expect(res.status).toBe(200);
      expect(mockJobQueue.listJobs).toHaveBeenCalledWith(
        expect.objectContaining({ page: 2, pageSize: 10 })
      );
    });

    it("uses defaults (page=1, pageSize=50) when no params are provided", async () => {
      const app = buildQueueApp();
      mockJobQueue.listJobs.mockReturnValueOnce({ jobs: [], total: 0, page: 1, pageSize: 50 });
      const res = await request(app)
        .get("/api/admin/jobs")
        .set("X-Admin-API-Key", ADMIN_KEY);
      expect(res.status).toBe(200);
      expect(mockJobQueue.listJobs).toHaveBeenCalledWith(
        expect.objectContaining({ page: 1, pageSize: 50 })
      );
    });
  });

  describe("GET /api/admin/dead-letter", () => {
    // AC3: non-numeric pageSize must return 400
    it("AC3: returns 400 for pageSize=abc", async () => {
      const app = buildQueueApp();
      const res = await request(app)
        .get("/api/admin/dead-letter?pageSize=abc")
        .set("X-Admin-API-Key", ADMIN_KEY);
      expect(res.status).toBe(400);
    });

    it("AC1: returns 400 for pageSize=-1", async () => {
      const app = buildQueueApp();
      const res = await request(app)
        .get("/api/admin/dead-letter?pageSize=-1")
        .set("X-Admin-API-Key", ADMIN_KEY);
      expect(res.status).toBe(400);
    });

    it("AC2: returns 400 for pageSize=1000000000", async () => {
      const app = buildQueueApp();
      const res = await request(app)
        .get("/api/admin/dead-letter?pageSize=1000000000")
        .set("X-Admin-API-Key", ADMIN_KEY);
      expect(res.status).toBe(400);
    });

    it("passes valid query parameters and calls getDeadLetterJobs", async () => {
      const app = buildQueueApp();
      mockJobQueue.getDeadLetterJobs.mockReturnValueOnce({ jobs: [], total: 0, page: 1, pageSize: 20 });
      const res = await request(app)
        .get("/api/admin/dead-letter?page=1&pageSize=20")
        .set("X-Admin-API-Key", ADMIN_KEY);
      expect(res.status).toBe(200);
      expect(mockJobQueue.getDeadLetterJobs).toHaveBeenCalledWith(1, 20);
    });
  });
});
