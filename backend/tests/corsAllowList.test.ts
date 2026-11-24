/**
 * CORS allow-list guard (issue #659).
 *
 * `src/api/middleware/cors.ts` used to hardcode its `allowedHeaders`, and the
 * list had drifted: the middleware stack reads `idempotency-key`,
 * `x-request-id`, `x-trace-id`, `x-correlation-id`, `traceparent`, `x-user-id`,
 * `x-admin-api-key` and `api-version`, none of which were allowed. A browser
 * preflight rejects the whole request, so those headers could not be sent from a
 * web client at all.
 *
 * Rather than trusting a literal list to stay correct, this suite *derives* the
 * set of headers the middleware stack reads by scanning the source and asserts
 * that every one of them is CORS-allowed. A future middleware that reads a new
 * header therefore fails CI until the allow list is updated, which is what stops
 * the list from drifting again.
 *
 * Scanning is done over the source text because the reads are not observable at
 * runtime — a request without the header takes the same path as one that never
 * could have sent it. The same approach is already used by
 * `tests/orphanModules.test.ts` and `tests/taskEventsSchema.test.ts`.
 */

import fs from "fs";
import path from "path";
import express from "express";
import {
  CORS_ALLOWED_REQUEST_HEADERS,
  CORS_BASE_METHODS,
  allowedMethods,
  buildCorsOptions,
  collectRegisteredMethods,
  createCorsMiddleware,
} from "../src/api/middleware/cors";

const SRC_DIR = path.resolve(__dirname, "../src");
const MIDDLEWARE_DIR = path.join(SRC_DIR, "api", "middleware");

/**
 * Headers a browser sets on its own or that are otherwise not subject to
 * preflight filtering. None of these need to appear in `allowedHeaders`.
 *
 * `accept-encoding` is listed even though it is a forbidden header name, so
 * that the scan assertion can stay a simple "every read is allowed" with no
 * per-header exceptions; the middleware reads it in `compression.ts`.
 */
const CORS_SAFELISTED = new Set([
  "accept",
  "accept-encoding",
  "accept-language",
  "content-language",
  "content-type",
  "origin",
  "range",
  // Forbidden header name: the browser sets it itself and `fetch` cannot
  // override it, so it is never named in a preflight. Read in routes/auth.ts
  // purely for audit logging.
  "user-agent",
]);

/**
 * Headers deliberately excluded from the assertion, with the reason each one
 * is not CORS-governed. Each is still a real `req.headers` read, so the
 * exclusion has to be explicit rather than silent.
 */
const NOT_CORS_GOVERNED = new Map<string, string>([
  [
    "x-forwarded-for",
    "read only in the WebSocket `upgrade` handler (routes/stream.ts, on an " +
      "IncomingMessage). A WebSocket handshake is not a CORS request and never " +
      "carries a preflight; the header is also set by the reverse proxy, not the " +
      "browser.",
  ],
]);

/** Every `.ts` file the header scan should cover. */
function sourceFilesToScan(): string[] {
  const files: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (
        entry.name.endsWith(".ts") &&
        // Test files construct synthetic `req.headers`; they are not part of
        // the served request path.
        !entry.name.endsWith(".d.ts") &&
        !entry.name.endsWith(".test.ts") &&
        !entry.name.endsWith(".spec.ts")
      ) {
        files.push(full);
      }
    }
  };
  walk(SRC_DIR);
  return files;
}

/**
 * Extract the header names a source file reads off `req.headers`.
 *
 * Handles the three forms used in this codebase:
 *   req.headers["x-trace-id"]        // quoted literal
 *   req.headers['idempotency-key']
 *   req.headers[CACHE_BYPASS_HEADER] // named constant
 *
 * The named-constant form is resolved by also collecting `const NAME = 'value'`
 * declarations from the same file, so `cache.ts` yields `x-cache-bypass`.
 */
function headersReadIn(source: string): Set<string> {
  const reads = new Set<string>();

  const constantValues = new Map<string, string>();
  const constPattern = /(?:export\s+)?const\s+([A-Z0-9_]+)\s*=\s*['"]([^'"]+)['"]/g;
  let constMatch: RegExpExecArray | null;
  while ((constMatch = constPattern.exec(source)) !== null) {
    constantValues.set(constMatch[1], constMatch[2]);
  }

  const readPattern = /req\.headers\[\s*(?:['"]([^'"]+)['"]|([A-Z0-9_]+))\s*\]/g;
  let readMatch: RegExpExecArray | null;
  while ((readMatch = readPattern.exec(source)) !== null) {
    const literal = readMatch[1];
    if (literal) {
      reads.add(literal.toLowerCase());
      continue;
    }
    const named = constantValues.get(readMatch[2]);
    if (named) reads.add(named.toLowerCase());
  }

  // `req.get("...")` / `req.header("...")` are the Express-idiomatic equivalent.
  const getPattern = /req\.(?:get|header)\(\s*['"]([^'"]+)['"]\s*\)/g;
  let getMatch: RegExpExecArray | null;
  while ((getMatch = getPattern.exec(source)) !== null) {
    reads.add(getMatch[1].toLowerCase());
  }

  return reads;
}

const allowedLower = new Set(CORS_ALLOWED_REQUEST_HEADERS.map((h) => h.toLowerCase()));

// ---------------------------------------------------------------------------
// AC2 + AC3 — every header the middleware reads is allowed, and the test
// enumerates those reads rather than trusting a hand-written list.
// ---------------------------------------------------------------------------

describe("CORS allowedHeaders covers every header the stack reads", () => {
  const files = sourceFilesToScan();

  it("finds request-header reads in the source to scan (guard against a broken scan)", () => {
    const all = new Set<string>();
    for (const file of files) {
      for (const header of headersReadIn(fs.readFileSync(file, "utf8"))) all.add(header);
    }

    // If this ever empties, the scan silently stopped matching and every
    // assertion below would pass vacuously.
    expect(all.size).toBeGreaterThan(0);
    // Spot-check the headers the issue calls out.
    for (const expected of ["idempotency-key", "x-request-id", "x-trace-id", "x-correlation-id", "traceparent"]) {
      expect(all.has(expected)).toBe(true);
    }
  });

  it("allows every non-safelisted header read anywhere under src/ (AC2)", () => {
    const missing: string[] = [];

    for (const file of files) {
      for (const header of headersReadIn(fs.readFileSync(file, "utf8"))) {
        if (CORS_SAFELISTED.has(header) || NOT_CORS_GOVERNED.has(header)) continue;
        if (!allowedLower.has(header)) {
          missing.push(`${path.relative(SRC_DIR, file)}: ${header}`);
        }
      }
    }

    expect(missing).toEqual([]);
  });

  it("documents every exclusion it makes from the header scan", () => {
    // An undocumented exclusion would let a genuinely broken header slip
    // through, so each one has to state why it is not CORS-governed.
    for (const [header, reason] of NOT_CORS_GOVERNED) {
      expect(reason.length).toBeGreaterThan(20);
    }
  });

  it("covers every header the middleware directory specifically reads (AC2)", () => {
    const middlewareFiles = fs
      .readdirSync(MIDDLEWARE_DIR)
      .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"))
      .map((f) => path.join(MIDDLEWARE_DIR, f));

    const read = new Set<string>();
    for (const file of middlewareFiles) {
      for (const header of headersReadIn(fs.readFileSync(file, "utf8"))) read.add(header);
    }

    const unguarded = [...read].filter(
      (h) => !CORS_SAFELISTED.has(h) && !NOT_CORS_GOVERNED.has(h) && !allowedLower.has(h),
    );
    expect(unguarded).toEqual([]);
  });

  it("declares no allowed header that nothing reads (keeps the list honest both ways)", () => {
    const read = new Set<string>();
    for (const file of files) {
      for (const header of headersReadIn(fs.readFileSync(file, "utf8"))) read.add(header);
    }

    // `Content-Type`/`Authorization` are set by fetch and read via `req.headers`
    // in auth.ts, so they are covered; anything unaccounted for would be dead
    // configuration.
    const unused = [...allowedLower].filter(
      (h) => !read.has(h) && !CORS_SAFELISTED.has(h) && !NOT_CORS_GOVERNED.has(h),
    );
    expect(unused).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// AC1 — PATCH + Idempotency-Key preflight
// ---------------------------------------------------------------------------

describe("CORS preflight for PATCH with Idempotency-Key (AC1)", () => {
  let app: express.Express;

  beforeEach(() => {
    jest.resetModules();
    process.env.ALLOWED_ORIGINS = "http://trusted.com";
    const createCors = require("../src/api/middleware/cors").createCorsMiddleware;
    app = express();
    app.use(createCors());
    app.patch("/api/tasks/:id", (_req, res) => res.json({ ok: true }));
  });

  afterEach(() => {
    delete process.env.ALLOWED_ORIGINS;
  });

  it("advertises both PATCH and Idempotency-Key in the preflight response", async () => {
    const request = (await import("supertest")).default;
    const res = await request(app)
      .options("/api/tasks/task_1")
      .set("Origin", "http://trusted.com")
      .set("Access-Control-Request-Method", "PATCH")
      .set("Access-Control-Request-Headers", "idempotency-key, content-type");

    expect(res.status).toBeLessThan(300);
    expect(String(res.headers["access-control-allow-methods"])).toContain("PATCH");
    expect(String(res.headers["access-control-allow-headers"]).toLowerCase()).toContain(
      "idempotency-key",
    );
  });

  it("advertises PATCH even with no PATCH route registered (AC1)", async () => {
    const request = (await import("supertest")).default;
    // Same middleware, but no app passed, so nothing is derived from routes.
    const bare = express();
    bare.use(require("../src/api/middleware/cors").createCorsMiddleware());
    bare.get("/health", (_req, res) => res.json({ ok: true }));

    const res = await request(bare)
      .options("/health")
      .set("Origin", "http://trusted.com")
      .set("Access-Control-Request-Method", "PATCH")
      .set("Access-Control-Request-Headers", "idempotency-key");

    expect(res.status).toBeLessThan(300);
    expect(String(res.headers["access-control-allow-methods"])).toContain("PATCH");
    expect(String(res.headers["access-control-allow-headers"]).toLowerCase()).toContain(
      "idempotency-key",
    );
  });
});

// ---------------------------------------------------------------------------
// AC4 — methods derived from the registered routes
// ---------------------------------------------------------------------------

describe("Access-Control-Allow-Methods is derived from the route table (AC4)", () => {
  it("collects methods from directly registered routes", () => {
    const app = express();
    app.get("/a", (_req, res) => res.json({}));
    app.post("/a", (_req, res) => res.json({}));
    app.delete("/a/:id", (_req, res) => res.json({}));

    const methods = collectRegisteredMethods(app);
    expect(methods).toEqual(expect.arrayContaining(["GET", "POST", "DELETE"]));
  });

  it("descends into mounted sub-routers", () => {
    const app = express();
    const router = express.Router();
    router.put("/flag/:name", (_req, res) => res.json({}));
    router.patch("/nested", (_req, res) => res.json({}));
    app.use("/api/admin", router);

    const methods = collectRegisteredMethods(app);
    expect(methods).toEqual(expect.arrayContaining(["PUT", "PATCH"]));
  });

  it("ignores bare middleware layers that register no route", () => {
    const app = express();
    app.use(express.json());
    app.get("/a", (_req, res) => res.json({}));

    expect(collectRegisteredMethods(app)).toEqual(["GET"]);
  });

  it("returns an empty list for something that is not an Express app", () => {
    expect(collectRegisteredMethods(undefined)).toEqual([]);
    expect(collectRegisteredMethods({})).toEqual([]);
    expect(collectRegisteredMethods({ _router: {} })).toEqual([]);
  });

  it("reflects newly registered routes that the base list omits", () => {
    // REPORT is not in CORS_BASE_METHODS, so it can only appear if the route
    // table really is consulted.
    const app = express();
    const router = express.Router();
    router.report("/metrics", (_req, res) => res.json({}));
    app.use("/api", router);

    expect(allowedMethods(app)).toContain("REPORT");
    expect(CORS_BASE_METHODS).not.toContain("REPORT");
  });

  it("unions the base methods with the route table and stays de-duplicated", () => {
    const app = express();
    app.get("/a", (_req, res) => res.json({}));

    const methods = allowedMethods(app);
    expect(methods).toEqual(expect.arrayContaining([...CORS_BASE_METHODS]));
    expect(new Set(methods).size).toBe(methods.length);
    expect([...methods]).toEqual([...methods].sort());
  });

  it("serves a preflight reflecting a route registered after the middleware mounted", async () => {
    const request = (await import("supertest")).default;
    process.env.ALLOWED_ORIGINS = "http://trusted.com";
    try {
      // Mount CORS first, exactly as app.ts does...
      const app = express();
      app.use(require("../src/api/middleware/cors").createCorsMiddleware(app));
      // ...then register routes, as app.ts does.
      const router = express.Router();
      router.report("/late", (_req, res) => res.json({}));
      app.use("/api", router);

      const res = await request(app)
        .options("/api/late")
        .set("Origin", "http://trusted.com")
        .set("Access-Control-Request-Method", "REPORT");

      expect(res.status).toBeLessThan(300);
      expect(String(res.headers["access-control-allow-methods"])).toContain("REPORT");
    } finally {
      delete process.env.ALLOWED_ORIGINS;
    }
  });
});

// ---------------------------------------------------------------------------
// Wiring in app.ts
//
// A true end-to-end check would import `createApp`, but `src/api/app.ts`
// transitively imports `src/events/eventStore.ts`, which currently has a
// duplicate `const validation` declaration and therefore fails to parse — a
// pre-existing break unrelated to CORS. So instead of importing the app, these
// tests assert the two things that actually matter: that `app.ts` hands the
// express app to the factory, and that the mount ordering used there (CORS
// first, routers after) still yields route-derived methods on a preflight.
// ---------------------------------------------------------------------------

describe("CORS wiring in app.ts", () => {
  const appSource = fs.readFileSync(path.join(SRC_DIR, "api", "app.ts"), "utf8");

  it("passes the express app to createCorsMiddleware so methods can be derived", () => {
    expect(appSource).toMatch(/createCorsMiddleware\(\s*app\s*\)/);
  });

  it("mounts CORS before the routers, which the per-request derivation relies on", () => {
    const corsAt = appSource.indexOf("createCorsMiddleware(app)");
    const firstRouteAt = appSource.indexOf("app.post(");
    expect(corsAt).toBeGreaterThan(-1);
    expect(firstRouteAt).toBeGreaterThan(corsAt);
  });

  it("derives the real app's method set when routers are mounted after CORS", async () => {
    const request = (await import("supertest")).default;
    process.env.ALLOWED_ORIGINS = "http://trusted.com";
    try {
      // Mirrors app.ts: CORS mounted first, then the routers.
      const app = express();
      app.use(require("../src/api/middleware/cors").createCorsMiddleware(app));

      const tasks = express.Router();
      tasks.post("/", (_req, res) => res.json({}));
      tasks.get("/", (_req, res) => res.json({}));
      tasks.delete("/:id", (_req, res) => res.json({}));
      app.use("/api/tasks", tasks);

      const flags = express.Router();
      flags.put("/:name", (_req, res) => res.json({}));
      app.use("/api/admin/flags", flags);

      const res = await request(app)
        .options("/api/tasks")
        .set("Origin", "http://trusted.com")
        .set("Access-Control-Request-Method", "POST");

      expect(res.status).toBeLessThan(300);
      const methods = String(res.headers["access-control-allow-methods"]).toUpperCase();
      for (const method of ["GET", "POST", "PUT", "DELETE", "PATCH", "OPTIONS"]) {
        expect(methods).toContain(method);
      }
    } finally {
      delete process.env.ALLOWED_ORIGINS;
    }
  });

  it("does not regress origin checking for an untrusted preflight", async () => {
    const request = (await import("supertest")).default;
    process.env.ALLOWED_ORIGINS = "http://trusted.com";
    jest.resetModules();
    try {
      const app = express();
      app.use(require("../src/api/middleware/cors").createCorsMiddleware());
      app.get("/x", (_req, res) => res.json({}));

      const res = await request(app)
        .options("/x")
        .set("Origin", "http://evil.com")
        .set("Access-Control-Request-Method", "GET");

      expect(res.headers["access-control-allow-origin"]).toBeUndefined();
    } finally {
      delete process.env.ALLOWED_ORIGINS;
    }
  });
});

// ---------------------------------------------------------------------------
// Configuration shape
// ---------------------------------------------------------------------------

describe("buildCorsOptions", () => {
  it("exposes the same configuration the middleware serves", () => {
    const options = buildCorsOptions();
    expect(options.credentials).toBe(true);
    expect(options.methods).toEqual(allowedMethods());
    expect(options.allowedHeaders).toEqual([...CORS_ALLOWED_REQUEST_HEADERS]);
  });

  it("accepts a trusted origin and rejects an untrusted one", () => {
    process.env.ALLOWED_ORIGINS = "http://trusted.com";
    jest.resetModules();
    try {
      const { buildCorsOptions: build } = require("../src/api/middleware/cors");
      const options = build();

      const allow = jest.fn();
      options.origin("http://trusted.com", allow);
      expect(allow).toHaveBeenCalledWith(null, true);

      const deny = jest.fn();
      options.origin("http://evil.com", deny);
      expect(deny.mock.calls[0][0]).toBeInstanceOf(Error);

      // No Origin header (server-to-server) is allowed through.
      const none = jest.fn();
      options.origin(undefined, none);
      expect(none).toHaveBeenCalledWith(null, true);
    } finally {
      delete process.env.ALLOWED_ORIGINS;
    }
  });

  it("keeps the allow list free of duplicates and empty entries", () => {
    const list = CORS_ALLOWED_REQUEST_HEADERS;
    expect(list.every((h) => typeof h === "string" && h.trim() !== "")).toBe(true);
    expect(new Set(list.map((h) => h.toLowerCase())).size).toBe(list.length);
  });
});
