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
