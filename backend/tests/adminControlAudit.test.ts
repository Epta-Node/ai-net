/**
 * Admin control operations are audited (#918): each mutating admin request is
 * recorded with its actor, action, target and status, and secret-looking
 * fields in the request body are redacted before they are stored.
 */
import express from "express";
import request from "supertest";

const ADMIN_KEY = "test-admin-key-audit-918";

process.env.ADMIN_API_KEY = ADMIN_KEY;
process.env.ADMIN_AUDIT_DB_PATH = ":memory:";

jest.mock("../src/services/reconciliation", () => ({
  createDefaultReconciliationService: jest.fn(() => ({})),
  ReconciliationService: jest.fn(),
}));

jest.mock("../src/queue", () => ({
  getGlobalJobQueue: jest.fn(() => ({})),
}));

import { listAdminAuditLog } from "../src/services/adminControl";
import { createAdminRouter } from "../src/api/routes/admin";

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/admin", createAdminRouter({ queue: {} as any }));
  return app;
}

async function settle() {
  await new Promise((resolve) => setImmediate(resolve));
}

describe("admin control operations are audited", () => {
  it("records a read-only toggle with the actor and the requested state", async () => {
    await request(buildApp())
      .put("/api/admin/read-only")
      .set("X-Admin-API-Key", ADMIN_KEY)
      .set("X-Admin-Actor", "ops-alice")
      .send({ enabled: true, reason: "maintenance window" });
    await settle();

    const entry = listAdminAuditLog(20).find((row) => row.action === "PUT /api/admin/read-only");
    expect(entry).toBeDefined();
    expect(entry?.actor).toBe("ops-alice");
    expect(entry?.details).toMatchObject({ body: { enabled: true, reason: "maintenance window" } });
  });

  it("records an agent pause with the agent id as the target, even when the agent is unknown", async () => {
    const response = await request(buildApp())
      .post("/api/admin/agents/agent-404/disable")
      .set("X-Admin-API-Key", ADMIN_KEY)
      .set("X-Admin-Actor", "ops-bob");
    await settle();

    const entry = listAdminAuditLog(20).find((row) => row.target === "agent-404");
    expect(entry).toBeDefined();
    expect(entry?.actor).toBe("ops-bob");
    expect(entry?.statusCode).toBe(response.status);
  });

  it("redacts secret-looking fields before storing the request body", async () => {
    await request(buildApp())
      .put("/api/admin/read-only")
      .set("X-Admin-API-Key", ADMIN_KEY)
      .send({ enabled: false, apiToken: "super-secret-token", password: "hunter2" });
    await settle();

    const entry = listAdminAuditLog(20).find((row) => row.action === "PUT /api/admin/read-only" && row.details !== undefined && JSON.stringify(row.details).includes("enabled"));
    expect(entry).toBeDefined();
    const stored = JSON.stringify(entry?.details);
    expect(stored).not.toContain("super-secret-token");
    expect(stored).not.toContain("hunter2");
    expect(stored).toContain("[redacted]");
  });
});
