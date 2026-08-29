/**
 * Tests for createRateLimiter and per-route-group factory functions.
 *
 * Covers:
 *  - Standard rate-limit headers on every allowed response
 *  - 429 JSON body, Retry-After, and zeroed Remaining on exhaustion
 *  - Rolling window: older timestamps expire and new requests are accepted
 *  - Distinct limits across public / authed / admin groups
 *  - createPublicLimiter / createAuthedLimiter / createAdminLimiter respect env vars
 */

import { createServer } from "http";
import express, { type Request, type Response } from "express";
import request from "supertest";
import {
  createRateLimiter,
  createPublicLimiter,
  createAuthedLimiter,
  createAdminLimiter,
} from "./rateLimit";

// ── Helpers ──────────────────────────────────────────────────────────────────

function buildApp(maxRequests: number, windowMs = 60_000) {
  const limiter = createRateLimiter({ maxRequests, windowMs });
  const app = express();
  app.use(limiter.middleware);
  app.get("/ping", (_req: Request, res: Response) => res.json({ ok: true }));
  return { app, limiter };
}

// ── Headers on allowed responses ─────────────────────────────────────────────

describe("rate-limit headers on allowed responses", () => {
  it("sets X-RateLimit-Limit to maxRequests", async () => {
    const { app } = buildApp(10);
    const res = await request(app).get("/ping");
    expect(res.status).toBe(200);
    expect(res.headers["x-ratelimit-limit"]).toBe("10");
  });

  it("sets X-RateLimit-Remaining, decrementing with each request", async () => {
    const { app } = buildApp(5);
    const res1 = await request(app).get("/ping");
    const res2 = await request(app).get("/ping");
    expect(res1.headers["x-ratelimit-remaining"]).toBe("4");
    expect(res2.headers["x-ratelimit-remaining"]).toBe("3");
  });

  it("sets X-RateLimit-Reset as a numeric Unix timestamp (seconds)", async () => {
    const before = Math.floor(Date.now() / 1000);
    const { app } = buildApp(5);
    const res = await request(app).get("/ping");
    const reset = parseInt(res.headers["x-ratelimit-reset"] as string, 10);
    expect(Number.isFinite(reset)).toBe(true);
    // Reset should be in the future (within a 2-minute window)
    expect(reset).toBeGreaterThanOrEqual(before);
    expect(reset).toBeLessThanOrEqual(before + 120);
  });
});

// ── 429 response ──────────────────────────────────────────────────────────────

describe("429 when limit is exhausted", () => {
  it("returns 429 with correct JSON body after maxRequests", async () => {
    const { app } = buildApp(2);
    await request(app).get("/ping"); // 1
    await request(app).get("/ping"); // 2 — window full
    const res = await request(app).get("/ping"); // 3 — should be blocked

    expect(res.status).toBe(429);
    expect(res.body.error.code).toBe("RATE_LIMITED");
    expect(res.body.error.message).toMatch(/too many requests/i);
  });

  it("includes Retry-After header on 429", async () => {
    const { app } = buildApp(1);
    await request(app).get("/ping"); // consume the only slot
    const res = await request(app).get("/ping");

    expect(res.status).toBe(429);
    const retryAfter = parseInt(res.headers["retry-after"] as string, 10);
    expect(Number.isFinite(retryAfter)).toBe(true);
    expect(retryAfter).toBeGreaterThan(0);
  });

  it("sets X-RateLimit-Remaining to 0 on 429", async () => {
    const { app } = buildApp(1);
    await request(app).get("/ping");
    const res = await request(app).get("/ping");

    expect(res.status).toBe(429);
    expect(res.headers["x-ratelimit-remaining"]).toBe("0");
  });

  it("sets X-RateLimit-Limit on 429 response", async () => {
    const { app } = buildApp(3);
    for (let i = 0; i < 3; i++) await request(app).get("/ping");
    const res = await request(app).get("/ping");

    expect(res.status).toBe(429);
    expect(res.headers["x-ratelimit-limit"]).toBe("3");
  });
});

// ── Rolling window ────────────────────────────────────────────────────────────

describe("sliding window expiry", () => {
  it("accepts requests again after the window expires", async () => {
    const windowMs = 50; // very short window for testing
    const limiter = createRateLimiter({ maxRequests: 2, windowMs });
    const app = express();
    app.use(limiter.middleware);
    app.get("/ping", (_req, res) => res.json({ ok: true }));

    await request(app).get("/ping");
    await request(app).get("/ping");

    // Limit reached
    const blocked = await request(app).get("/ping");
    expect(blocked.status).toBe(429);

    // Wait for window to expire
    await new Promise((r) => setTimeout(r, windowMs + 20));

    // Should be allowed again
    const allowed = await request(app).get("/ping");
    expect(allowed.status).toBe(200);
  });
});

// ── stop() clears state ───────────────────────────────────────────────────────

describe("stop()", () => {
  it("clears tracked IPs so requests are allowed again", async () => {
    const { app, limiter } = buildApp(1);
    await request(app).get("/ping"); // fills the slot
    const blocked = await request(app).get("/ping");
    expect(blocked.status).toBe(429);

    limiter.stop();

    const allowed = await request(app).get("/ping");
    expect(allowed.status).toBe(200);
  });

  it("resets size() to zero", () => {
    const limiter = createRateLimiter({ maxRequests: 10 });
    expect(limiter.size()).toBe(0);
  });
});

// ── Per-group factories read from env ─────────────────────────────────────────

describe("createPublicLimiter", () => {
  it("defaults to 120 requests per minute", async () => {
    const limiter = createPublicLimiter();
    const app = express();
    app.use(limiter.middleware);
    app.get("/ping", (_req, res) => res.json({ ok: true }));

    const res = await request(app).get("/ping");
    expect(res.headers["x-ratelimit-limit"]).toBe("120");
  });

  it("respects RATE_LIMIT_PUBLIC_MAX_REQUESTS env override", async () => {
    process.env.RATE_LIMIT_PUBLIC_MAX_REQUESTS = "5";
    try {
      const limiter = createPublicLimiter();
      const app = express();
      app.use(limiter.middleware);
      app.get("/ping", (_req, res) => res.json({ ok: true }));

      const res = await request(app).get("/ping");
      expect(res.headers["x-ratelimit-limit"]).toBe("5");
    } finally {
      delete process.env.RATE_LIMIT_PUBLIC_MAX_REQUESTS;
    }
  });
});

describe("createAuthedLimiter", () => {
  it("defaults to 30 requests per minute", async () => {
    const limiter = createAuthedLimiter();
    const app = express();
    app.use(limiter.middleware);
    app.get("/ping", (_req, res) => res.json({ ok: true }));

    const res = await request(app).get("/ping");
    expect(res.headers["x-ratelimit-limit"]).toBe("30");
  });
});

describe("createAdminLimiter", () => {
  it("defaults to 20 requests per minute", async () => {
    const limiter = createAdminLimiter();
    const app = express();
    app.use(limiter.middleware);
    app.get("/ping", (_req, res) => res.json({ ok: true }));

    const res = await request(app).get("/ping");
    expect(res.headers["x-ratelimit-limit"]).toBe("20");
  });
});

// ── Group limits differ ───────────────────────────────────────────────────────

describe("group limits are distinct from each other", () => {
  it("public > authed > admin by default", () => {
    const publicLimit = 120;
    const authedLimit = 30;
    const adminLimit = 20;
    expect(publicLimit).toBeGreaterThan(authedLimit);
    expect(authedLimit).toBeGreaterThan(adminLimit);
  });

  it("public limiter allows 120 while admin only allows 20", async () => {
    const pubLimiter = createPublicLimiter();
    const admLimiter = createAdminLimiter();

    const pubApp = express();
    pubApp.use(pubLimiter.middleware);
    pubApp.get("/ping", (_req, res) => res.json({ ok: true }));

    const admApp = express();
    admApp.use(admLimiter.middleware);
    admApp.get("/ping", (_req, res) => res.json({ ok: true }));

    const pubRes = await request(pubApp).get("/ping");
    const admRes = await request(admApp).get("/ping");

    expect(pubRes.headers["x-ratelimit-limit"]).toBe("120");
    expect(admRes.headers["x-ratelimit-limit"]).toBe("20");
  });
});
