/**
 * CORS hardening for production deployments (issue #810).
 *
 * Covers the three gaps the CORS review found: an opaque `Origin: null` was
 * reflected, preflights carried no max-age so browsers re-validated on every
 * request, and wildcard or empty origin lists were not rejected at startup.
 */
import express from "express";
import request from "supertest";
import { loadConfig } from "../src/config";

const TRUSTED = "http://trusted.com";

function appWithCors(): express.Express {
  // Required after resetModules so `allowedOrigins()` reads the env set above.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { createCorsMiddleware } = require("../src/api/middleware/cors");
  const app = express();
  app.use(createCorsMiddleware(app));
  app.get("/x", (_req, res) => res.json({ ok: true }));
  return app;
}

describe("CORS null origin (#810)", () => {
  beforeEach(() => {
    process.env.ALLOWED_ORIGINS = TRUSTED;
    jest.resetModules();
  });

  afterEach(() => {
    delete process.env.ALLOWED_ORIGINS;
  });

  it("rejects Origin: null with 403 on a simple request", async () => {
    const res = await request(appWithCors()).get("/x").set("Origin", "null");

    expect(res.status).toBe(403);
    expect(res.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("rejects Origin: null on a preflight", async () => {
    const res = await request(appWithCors())
      .options("/x")
      .set("Origin", "null")
      .set("Access-Control-Request-Method", "GET");

    expect(res.status).toBe(403);
    expect(res.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("still allows requests with no Origin header (server-to-server)", async () => {
    const res = await request(appWithCors()).get("/x");

    expect(res.status).toBe(200);
  });

  it("never answers with a wildcard Access-Control-Allow-Origin", async () => {
    const res = await request(appWithCors())
      .get("/x")
      .set("Origin", TRUSTED);

    expect(res.headers["access-control-allow-origin"]).toBe(TRUSTED);
    expect(res.headers["access-control-allow-origin"]).not.toBe("*");
  });
});

describe("CORS preflight cache (#810)", () => {
  beforeEach(() => {
    process.env.ALLOWED_ORIGINS = TRUSTED;
    jest.resetModules();
  });

  afterEach(() => {
    delete process.env.ALLOWED_ORIGINS;
  });

  it("returns 204 with Access-Control-Max-Age: 600 for an allowed preflight", async () => {
    const res = await request(appWithCors())
      .options("/x")
      .set("Origin", TRUSTED)
      .set("Access-Control-Request-Method", "GET");

    expect(res.status).toBe(204);
    expect(res.headers["access-control-max-age"]).toBe("600");
  });
});

describe("ALLOWED_ORIGINS startup validation (#810)", () => {
  const base = { NODE_ENV: "development", AUTH_JWT_SECRET: "x".repeat(32) } as NodeJS.ProcessEnv;

  it("rejects a wildcard origin entry in any environment", () => {
    expect(() =>
      loadConfig({ ...base, ALLOWED_ORIGINS: "https://*.example.com" }),
    ).toThrow(/ALLOWED_ORIGINS/);
  });

  it("rejects a literal null origin entry", () => {
    expect(() => loadConfig({ ...base, ALLOWED_ORIGINS: "null" })).toThrow(/ALLOWED_ORIGINS/);
  });

  it("fails to start in production when ALLOWED_ORIGINS is not set", () => {
    expect(() =>
      loadConfig({ ...base, NODE_ENV: "production", ALLOWED_ORIGINS: undefined }),
    ).toThrow(/ALLOWED_ORIGINS is required in production/);
  });

  it("fails to start in production when ALLOWED_ORIGINS is blank", () => {
    expect(() =>
      loadConfig({ ...base, NODE_ENV: "production", ALLOWED_ORIGINS: "   " }),
    ).toThrow(/ALLOWED_ORIGINS is required in production/);
  });
});
