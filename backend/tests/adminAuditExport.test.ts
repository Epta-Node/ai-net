/**
 * Admin audit-log export and retention (#755).
 *
 * Runs against a real in-memory SQLite audit database so streaming, batching,
 * CSV escaping and time-based pruning are exercised end to end.
 */
import express from "express";
import request from "supertest";

const ADMIN_KEY = "test-admin-key-12345";

process.env.ADMIN_API_KEY = ADMIN_KEY;
process.env.ADMIN_AUDIT_DB_PATH = ":memory:";

jest.mock("../src/services/reconciliation", () => ({
  createDefaultReconciliationService: jest.fn(() => ({})),
  ReconciliationService: jest.fn(),
}));

jest.mock("../src/queue", () => ({
  getGlobalJobQueue: jest.fn(() => ({})),
}));

import {
  listAdminAuditLog,
  pruneAdminAuditLog,
  recordAdminAudit,
} from "../src/services/adminControl";
import { createAdminRouter } from "../src/api/routes/admin";

const DAY_MS = 24 * 60 * 60 * 1000;

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/admin", createAdminRouter({ queue: {} as any }));
  return app;
}

function seed(actor: string, count: number, at = new Date().toISOString(), action = "POST /seed") {
  for (let i = 0; i < count; i += 1) {
    recordAdminAudit({ at, actor, action, statusCode: 200, details: { i } });
  }
}

function exportRequest(query = "") {
  return request(buildApp())
    .get(`/api/admin/audit-log/export${query}`)
    .set("X-Admin-API-Key", ADMIN_KEY)
    .buffer(true)
    .parse((res, done) => {
      let data = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => done(null, data));
    });
}

describe("GET /api/admin/audit-log/export", () => {
  it("requires admin authentication", async () => {
    const res = await request(buildApp()).get("/api/admin/audit-log/export");
    expect(res.status).toBe(401);
  });

  it("rejects an unknown format and an oversized limit", async () => {
    const app = buildApp();
    const badFormat = await request(app)
      .get("/api/admin/audit-log/export?format=xml")
      .set("X-Admin-API-Key", ADMIN_KEY);
    expect(badFormat.status).toBe(400);

    const badLimit = await request(app)
      .get("/api/admin/audit-log/export?limit=100001")
      .set("X-Admin-API-Key", ADMIN_KEY);
    expect(badLimit.status).toBe(400);
  });

  it("streams every entry across multiple batches as JSON", async () => {
    seed("bulk-json", 1200);
    const res = await exportRequest("?format=json");

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("application/json");
    expect(res.headers["content-disposition"]).toContain("audit-log.json");
    const body = JSON.parse(res.body as unknown as string) as { entries: Array<{ actor: string }> };
    expect(body.entries.filter((e) => e.actor === "bulk-json")).toHaveLength(1200);
  });

  it("bounds the export with limit and returns newest entries first", async () => {
    seed("limit-check", 5);
    const res = await exportRequest("?format=json&limit=3");

    const body = JSON.parse(res.body as unknown as string) as { entries: Array<{ id: number }> };
    expect(body.entries).toHaveLength(3);
    const ids = body.entries.map((e) => e.id);
    expect(ids).toEqual([...ids].sort((a, b) => b - a));
  });

  it("exports CSV with a header and neutralises formula injection", async () => {
    recordAdminAudit({
      at: new Date().toISOString(),
      actor: "=HYPERLINK(\"http://evil.example\")",
      action: "+SUM(1,1)",
      target: "@cmd",
      statusCode: 200,
      details: { note: "-1+1" },
    });

    const res = await exportRequest("?format=csv");
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("text/csv");
    expect(res.headers["content-disposition"]).toContain("audit-log.csv");

    const lines = (res.body as unknown as string).split("\n");
    const header = lines[0];
    const row = lines.find((line) => line.includes("@cmd")) as string;
    expect(header).toBe("id,at,actor,action,target,statusCode,requestId,details");
    expect(row).toBeDefined();
    expect(row).toContain(`"'=HYPERLINK(""http://evil.example"")"`);
    expect(row).toContain(`"'+SUM(1,1)"`);
    expect(row).toContain(`"'@cmd"`);
    // Every cell that began with a formula trigger is prefixed, none are emitted raw.
    expect(row).not.toMatch(/(^|,)"[=+\-@]/);
  });

  it("records the export request itself in the audit log", async () => {
    await exportRequest("?format=csv&limit=1");
    await new Promise((resolve) => setImmediate(resolve));

    const exportEntry = listAdminAuditLog(5).find(
      (entry) => entry.action === "GET /api/admin/audit-log/export",
    );
    expect(exportEntry).toBeDefined();
    expect(exportEntry?.statusCode).toBe(200);
  });
});

describe("pruneAdminAuditLog", () => {
  const now = new Date("2025-06-01T00:00:00.000Z");

  it("removes only entries older than the retention window", () => {
    seed("prune-old", 3, new Date(now.getTime() - 100 * DAY_MS).toISOString());
    seed("prune-edge", 2, new Date(now.getTime() - 30 * DAY_MS + 1000).toISOString());
    seed("prune-new", 2, new Date(now.getTime() - 1 * DAY_MS).toISOString());

    expect(pruneAdminAuditLog(30, now)).toBe(3);

    const remaining = listAdminAuditLog(1000).map((e) => e.actor);
    expect(remaining).not.toContain("prune-old");
    expect(remaining.filter((a) => a === "prune-edge")).toHaveLength(2);
    expect(remaining.filter((a) => a === "prune-new")).toHaveLength(2);
  });

  it("is idempotent and a no-op when retention is disabled", () => {
    seed("prune-disabled", 2, new Date(now.getTime() - 500 * DAY_MS).toISOString());

    expect(pruneAdminAuditLog(0, now)).toBe(0);
    expect(pruneAdminAuditLog(-5, now)).toBe(0);
    expect(listAdminAuditLog(1000).filter((e) => e.actor === "prune-disabled")).toHaveLength(2);

    expect(pruneAdminAuditLog(30, now)).toBeGreaterThanOrEqual(2);
    expect(pruneAdminAuditLog(30, now)).toBe(0);
  });
});
