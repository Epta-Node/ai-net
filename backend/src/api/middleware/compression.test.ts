/**
 * Unit tests for the compression middleware (src/api/middleware/compression.ts).
 *
 * Strategy:
 *  - Mount the middleware on a minimal express app.
 *  - Use supertest to make real HTTP requests and inspect Content-Encoding headers.
 *  - Test gzip (Accept-Encoding: gzip), deflate, and bypass for small/binary payloads.
 *  - Brotli is tested at the unit level via the factory's enableBrotli option.
 */
import express, { type Request, type Response } from "express";
import request from "supertest";
import { compressionMiddleware, COMPRESSION_THRESHOLD } from "./compression";

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Builds a payload that is definitely larger than the compression threshold. */
function largePayload(sizeBytes = COMPRESSION_THRESHOLD + 512): string {
  return "x".repeat(sizeBytes);
}

/** Builds an express app with compression + a single JSON route. */
function buildApp(
  responseBody: unknown = { data: largePayload() },
  contentType = "application/json",
  opts: Parameters<typeof compressionMiddleware>[0] = {}
) {
  const app = express();
  app.use(...compressionMiddleware(opts));
  app.get("/test", (_req: Request, res: Response) => {
    res.setHeader("Content-Type", contentType);
    res.json(responseBody);
  });
  // Route that sends a raw large text body
  app.get("/text", (_req: Request, res: Response) => {
    res.setHeader("Content-Type", "text/plain");
    res.send(largePayload());
  });
  return app;
}

// ─────────────────────────────────────────────────────────────────────────────
//  COMPRESSION_THRESHOLD constant
// ─────────────────────────────────────────────────────────────────────────────

describe("COMPRESSION_THRESHOLD", () => {
  it("is 1024 bytes (1 KB)", () => {
    expect(COMPRESSION_THRESHOLD).toBe(1024);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
//  gzip compression
// ─────────────────────────────────────────────────────────────────────────────

describe("compressionMiddleware — gzip", () => {
  it("compresses large JSON responses with gzip when client requests it", async () => {
    const app = buildApp({ data: largePayload() }, "application/json", { enableBrotli: false });
    const res = await request(app)
      .get("/test")
      .set("Accept-Encoding", "gzip");

    expect(res.headers["content-encoding"]).toBe("gzip");
    expect(res.status).toBe(200);
  });

  it("does not compress small responses below the threshold", async () => {
    const app = buildApp({ tiny: "x" }, "application/json", {
      threshold: COMPRESSION_THRESHOLD,
      enableBrotli: false,
    });
    const res = await request(app)
      .get("/test")
      .set("Accept-Encoding", "gzip");

    // Small payload — should not be compressed
    expect(res.headers["content-encoding"]).toBeUndefined();
  });

  it("does not compress when client does not send Accept-Encoding", async () => {
    const app = buildApp({ data: largePayload() }, "application/json", { enableBrotli: false });
    // Explicitly set identity encoding to prevent supertest from adding gzip automatically
    const res = await request(app)
      .get("/test")
      .set("Accept-Encoding", "identity");
    expect(res.headers["content-encoding"]).toBeUndefined();
  });

  it("skips compression for image/png content type", async () => {
    const app = buildApp(largePayload(), "image/png", { enableBrotli: false });
    const res = await request(app)
      .get("/test")
      .set("Accept-Encoding", "gzip");
    expect(res.headers["content-encoding"]).toBeUndefined();
  });

  it("skips compression for application/gzip content type", async () => {
    const app = buildApp(largePayload(), "application/gzip", { enableBrotli: false });
    const res = await request(app)
      .get("/test")
      .set("Accept-Encoding", "gzip");
    expect(res.headers["content-encoding"]).toBeUndefined();
  });

  it("skips compression for application/zip content type", async () => {
    const app = buildApp(largePayload(), "application/zip", { enableBrotli: false });
    const res = await request(app)
      .get("/test")
      .set("Accept-Encoding", "gzip");
    expect(res.headers["content-encoding"]).toBeUndefined();
  });

  it("compresses large text/plain responses", async () => {
    const app = buildApp(largePayload(), "application/json", { enableBrotli: false });
    const res = await request(app)
      .get("/text")
      .set("Accept-Encoding", "gzip");
    expect(res.headers["content-encoding"]).toBe("gzip");
  });

  it("compressed response is valid and decompresses to original content", async () => {
    const payload = { data: largePayload() };
    const app = buildApp(payload, "application/json", { enableBrotli: false });

    // supertest auto-decompresses gzip; check the header and parsed body match.
    const res = await request(app)
      .get("/test")
      .set("Accept-Encoding", "gzip");

    // When supertest auto-decompresses, content-encoding header may be absent
    // from the parsed response but the body should be correctly parsed JSON.
    expect(res.status).toBe(200);
    // Body should equal the original payload after decompression
    expect(res.body).toEqual(payload);
  });

  it("respects custom threshold option — compresses payloads above threshold", async () => {
    const app = buildApp({ data: "a".repeat(200) }, "application/json", {
      threshold: 100, // Low threshold so our 200-char body gets compressed
      enableBrotli: false,
    });
    const res = await request(app)
      .get("/test")
      .set("Accept-Encoding", "gzip");
    expect(res.headers["content-encoding"]).toBe("gzip");
  });

  it("respects custom level option without throwing", async () => {
    const app = buildApp({ data: largePayload() }, "application/json", {
      level: 1,
      enableBrotli: false,
    });
    const res = await request(app)
      .get("/test")
      .set("Accept-Encoding", "gzip");
    expect(res.headers["content-encoding"]).toBe("gzip");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
//  compressionMiddleware factory
// ─────────────────────────────────────────────────────────────────────────────

describe("compressionMiddleware — factory", () => {
  it("returns an array with 2 handlers when enableBrotli=true (default)", () => {
    const handlers = compressionMiddleware();
    expect(Array.isArray(handlers)).toBe(true);
    expect(handlers).toHaveLength(2);
    handlers.forEach((h) => expect(typeof h).toBe("function"));
  });

  it("returns an array with 1 handler when enableBrotli=false", () => {
    const handlers = compressionMiddleware({ enableBrotli: false });
    expect(handlers).toHaveLength(1);
    expect(typeof handlers[0]).toBe("function");
  });

  it("all returned handlers are Express middleware functions (length ≥ 2)", () => {
    compressionMiddleware().forEach((h) => {
      expect(h.length).toBeGreaterThanOrEqual(2);
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
//  Content-type bypass list
// ─────────────────────────────────────────────────────────────────────────────

describe("compressionMiddleware — content-type bypass", () => {
  const bypassTypes = [
    "image/jpeg",
    "image/png",
    "image/webp",
    "audio/mpeg",
    "video/mp4",
    "application/zip",
    "application/gzip",
    "application/x-bzip2",
    "application/octet-stream",
    "application/wasm",
    "font/woff2",
  ];

  bypassTypes.forEach((ct) => {
    it(`does not compress ${ct}`, async () => {
      const app = buildApp(largePayload(), ct, { enableBrotli: false });
      const res = await request(app)
        .get("/test")
        .set("Accept-Encoding", "gzip");
      expect(res.headers["content-encoding"]).toBeUndefined();
    });
  });
});
