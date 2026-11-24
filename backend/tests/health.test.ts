import request from "supertest";
import { createApp } from "../src/api/app";

describe("Health Router", () => {
  let app: ReturnType<typeof createApp>["httpServer"];
  let closeApp: () => void;

  beforeAll(() => {
    const instance = createApp();
    app = instance.httpServer;
    closeApp = instance.close;
  });

  afterAll((done) => {
    closeApp();
    done();
  });

  it("GET /health returns 200 with status ok and version", async () => {
    const res = await request(app).get("/health");
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("ok");
    expect(res.body).toHaveProperty("version");
    expect(res.body).toHaveProperty("uptime");
  });

  it("GET /health/live returns 200 with status ok", async () => {
    const res = await request(app).get("/health/live");
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("ok");
  });

  it("GET /health/deep handles timeouts and returns status", async () => {
    const res = await request(app).get("/health/deep");
    expect([200, 503]).toContain(res.status);
    expect(res.body).toHaveProperty("services");
  });
});

describe("GET /migrations", () => {
  const ADMIN_KEY = "test-admin-key-12345";
  let app: ReturnType<typeof createApp>["httpServer"];
  let closeApp: () => void;
  let previousAdminKey: string | undefined;

  beforeAll(() => {
    previousAdminKey = process.env.ADMIN_API_KEY;
    process.env.ADMIN_API_KEY = ADMIN_KEY;
    const instance = createApp();
    app = instance.httpServer;
    closeApp = instance.close;
  });

  afterAll((done) => {
    closeApp();
    if (previousAdminKey === undefined) delete process.env.ADMIN_API_KEY;
    else process.env.ADMIN_API_KEY = previousAdminKey;
    done();
  });

  it("returns 401 without the admin API key", async () => {
    const res = await request(app).get("/migrations");
    expect(res.status).toBe(401);
  });

  it("reports migration status with the admin API key", async () => {
    const res = await request(app).get("/migrations").set("X-Admin-API-Key", ADMIN_KEY);
    expect(res.status).toBe(200);

    expect(res.body).toHaveProperty("migrations");
    expect(Array.isArray(res.body.migrations)).toBe(true);
    expect(res.body).toHaveProperty("currentVersion");
    expect(res.body).toHaveProperty("pendingCount");
    expect(typeof res.body.upToDate).toBe("boolean");
    expect(typeof res.body.appliedCount).toBe("number");
    expect(typeof res.body.migrationCount).toBe("number");
    expect(Array.isArray(res.body.drift)).toBe(true);
  });

  it("labels each migration as applied or pending and never returns SQL bodies", async () => {
    const res = await request(app).get("/migrations").set("X-Admin-API-Key", ADMIN_KEY);
    expect(res.status).toBe(200);

    for (const migration of res.body.migrations) {
      expect(["applied", "pending"]).toContain(migration.state);
      expect(migration).toHaveProperty("id");
      expect(migration).toHaveProperty("filename");
      expect(migration).toHaveProperty("checksum");
      expect(migration).not.toHaveProperty("sql");
      expect(migration).not.toHaveProperty("downSql");
    }
    expect(JSON.stringify(res.body)).not.toContain("CREATE TABLE");
  });
});
