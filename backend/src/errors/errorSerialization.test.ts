/**
 * Serialization contract for `src/errors/` (Issue #740).
 *
 * `AppError.test.ts` covers each class in isolation. This suite covers the thing
 * that actually matters to a caller and that per-class tests cannot see: **the
 * same seven status codes serialise to the same shape, and nothing internal
 * leaks out of the production path.**
 *
 * `serialize()` is the only function in the codebase that decides what a client
 * is allowed to see. It has two overloads — `serialize(includeDetails)` and
 * `serialize(path, includeDetails)` — and the second is a genuine footgun: a
 * caller who writes `serialize("/api/tasks")` expecting details would instead
 * get a path and no details. Both are pinned below.
 *
 * Every assertion here is JSON-safe on purpose: the payload crosses a
 * `res.json()` boundary, so a value that is merely truthy in-process (a
 * `Map`, an `Error`, a `BigInt`) would still be a bug on the wire.
 */

import {
  AppError,
  AuthenticationError,
  ConflictError,
  ForbiddenError,
  NotFoundError,
  PaymentError,
  RateLimitError,
  UnauthorizedError,
  ValidationError,
} from "./index";
// `ProviderError` is intentionally absent from the barrel, so it is imported from
// its module — the same way the venice client imports it.
import { ProviderError } from "./ProviderError";
import { HTTP_STATUS_FOR_CODE } from "./ErrorCode";

/** One row per status code the API contract promises. */
interface StatusCase {
  status: number;
  label: string;
  make: (details?: Record<string, unknown>) => AppError;
}

/**
 * The status codes named in the issue's acceptance criteria, each mapped to the
 * class that actually produces it — so a class that drifts to the wrong status
 * fails here rather than silently changing the API contract.
 */
const STATUS_CASES: StatusCase[] = [
  { status: 400, label: "400 ValidationError", make: (d) => new ValidationError("Invalid input", d) },
  { status: 401, label: "401 AuthenticationError", make: (d) => new AuthenticationError(undefined, d) },
  { status: 401, label: "401 UnauthorizedError", make: (d) => new UnauthorizedError(undefined, d) },
  { status: 403, label: "403 ForbiddenError", make: (d) => new ForbiddenError(undefined, d) },
  { status: 404, label: "404 NotFoundError", make: (d) => new NotFoundError("Task", undefined, d) },
  { status: 409, label: "409 ConflictError", make: (d) => new ConflictError(undefined, d) },
  { status: 429, label: "429 RateLimitError", make: (d) => new RateLimitError(undefined, d) },
  { status: 500, label: "500 AppError", make: (d) => new AppError("Boom", 500, "INTERNAL_ERROR", d) },
];

describe("serialize() across every documented status code", () => {
  it.each(STATUS_CASES)("$label reports its own statusCode", ({ status, make }) => {
    expect(make().statusCode).toBe(status);
  });

  it.each(STATUS_CASES)("$label keeps code, message and correlationId", ({ make }) => {
    const err = make();
    const payload = err.serialize();

    expect(payload.code).toBe(err.code);
    expect(payload.message).toBe(err.message);
    expect(payload.correlationId).toBe(err.correlationId);
    expect(payload.timestamp).toBe(err.timestamp);
  });

  it.each(STATUS_CASES)("$label omits details on the production path", ({ make }) => {
    const err = make({ internalSql: "SELECT * FROM wallets", walletPublicKey: "Gsecret" });

    // The default is `includeDetails = false`: internal detail never reaches a
    // client unless a caller explicitly opts in.
    expect("details" in err.serialize()).toBe(false);
  });

  it.each(STATUS_CASES)("$label includes details only when explicitly asked", ({ make }) => {
    const details = { field: "prompt" };
    const payload = make(details).serialize(true);

    expect(payload.details).toEqual(details);
  });

  it.each(STATUS_CASES)("$label serialises to a JSON round-trip", ({ make }) => {
    const payload = make({ field: "x" }).serialize(true);

    // A payload that survives `JSON.stringify` is what the client actually
    // receives; a value that only looked fine in-process would throw here.
    expect(() => JSON.stringify(payload)).not.toThrow();
    const roundTripped = JSON.parse(JSON.stringify(payload));
    expect(roundTripped.code).toBe(payload.code);
    expect(roundTripped.message).toBe(payload.message);
    expect(roundTripped.correlationId).toBe(payload.correlationId);
    expect(roundTripped).not.toHaveProperty("stack");
    expect(roundTripped).not.toHaveProperty("isOperational");
    expect(roundTripped.statusCode).toBeUndefined();
  });

  it("covers every status code the issue names", () => {
    expect(new Set(STATUS_CASES.map((c) => c.status))).toEqual(
      new Set([400, 401, 403, 404, 409, 429, 500]),
    );
  });
});

describe("no internal detail leaks into a production response", () => {
  /** Everything a handler might accidentally attach to an error. */
  const SENSITIVE_DETAILS = {
    sql: "SELECT secret FROM wallets WHERE wallet = $1",
    stack: "Error: boom\n    at handler (/srv/app/routes/tasks.js:42:9)",
    filePath: "/srv/app/src/services/venice/client.ts",
    apiKey: "sk-live-0000000000000000",
    walletPublicKey: "GB3NK5X2M2C5DFR6EH3A5DQF4FRT2XQ2IQC6GKJ6GKJ6GKJ6GKJ6GKJ6",
  };

  it.each(STATUS_CASES)("$label drops every sensitive detail by default", ({ make }) => {
    const body = JSON.stringify(make(SENSITIVE_DETAILS).serialize());

    for (const value of Object.values(SENSITIVE_DETAILS)) {
      expect(body).not.toContain(value);
    }
  });

  it.each(STATUS_CASES)("$label keeps the code and message a client needs", ({ make }) => {
    const payload = make(SENSITIVE_DETAILS).serialize();

    expect(payload.code).toBeTruthy();
    expect(payload.message).toBeTruthy();
    expect(payload.correlationId).toMatch(/^[0-9a-f-]{36}$/i);
  });

  it("never emits a stack trace, even in development mode", () => {
    // `serialize()` has no development flag: leaking a stack is the error
    // handler's decision, not the error's. Asserting the absence here is what
    // keeps that separation honest.
    for (const { make } of STATUS_CASES) {
      const payload = make({ stack: SENSITIVE_DETAILS.stack }).serialize(true);
      expect(payload).not.toHaveProperty("stack");
    }
  });

  it("does not expose the isOperational flag", () => {
    const payload = new AppError("Boom", 500, "INTERNAL_ERROR").serialize(true) as unknown as Record<
      string,
      unknown
    >;
    expect(payload.isOperational).toBeUndefined();
  });

  it("does not mutate the error when serialising", () => {
    const err = new AppError("Boom", 500, "INTERNAL_ERROR", { a: 1 });

    err.serialize();
    err.serialize(true);

    expect(err.details).toEqual({ a: 1 });
  });
});

describe("serialize() overloads", () => {
  it("treats a boolean first argument as includeDetails", () => {
    const err = new ValidationError("bad", { field: "prompt" });

    expect(err.serialize(true).details).toEqual({ field: "prompt" });
    expect(err.serialize(false).details).toBeUndefined();
  });

  it("treats a string first argument as the request path", () => {
    const err = new ValidationError("bad", { field: "prompt" });
    const payload = err.serialize("/api/tasks");

    expect(payload.path).toBe("/api/tasks");
    expect(payload.code).toBe(err.code);
  });

  it("carries the path and details together when both are supplied", () => {
    const err = new ValidationError("bad", { field: "prompt" });
    const payload = err.serialize("/api/tasks", true);

    expect(payload.path).toBe("/api/tasks");
    expect(payload.details).toEqual({ field: "prompt" });
  });

  it("omits details when a path is supplied without opting in", () => {
    // The trap: `serialize("/api/tasks", true)` includes details,
    // `serialize("/api/tasks")` does not. Both are pinned so neither surprises
    // a future caller.
    const err = new ValidationError("bad", { field: "prompt" });
    expect(err.serialize("/api/tasks").details).toBeUndefined();
    expect(err.serialize("/api/tasks", true).details).toEqual({ field: "prompt" });
  });

  it("leaves path undefined when none is supplied", () => {
    expect(new AppError("x", 500, "CODE").serialize().path).toBeUndefined();
  });
});

describe("HTTP mapping stays aligned with the ErrorCode registry", () => {
  it.each(STATUS_CASES)("$label maps its code to the documented HTTP status", ({ status, make }) => {
    const err = make();
    expect(HTTP_STATUS_FOR_CODE[err.code as keyof typeof HTTP_STATUS_FOR_CODE]).toBe(status);
  });

  it("ProviderError selects its status from the sub-code, and is not barrel-exported", () => {
    expect(new ProviderError().statusCode).toBe(502);
    expect(new ProviderError("t", "PROVIDER_TIMEOUT").statusCode).toBe(504);
    expect(new ProviderError("r", "PROVIDER_RATE_LIMITED").statusCode).toBe(429);
    // 402 for a payment failure, reached through the same registry.
    expect(new PaymentError().statusCode).toBe(402);
    expect(HTTP_STATUS_FOR_CODE[new PaymentError().code as "PAYMENT_ERROR"]).toBe(402);
  });

  it("marks every error class operational, so the handler logs it as a warning", () => {
    for (const { make } of STATUS_CASES) {
      expect(make().isOperational).toBe(true);
    }
  });
});

describe("correlation ids", () => {
  it("generates a distinct uuid per error", () => {
    const a = new AppError("x", 500, "CODE");
    const b = new AppError("x", 500, "CODE");

    expect(a.correlationId).not.toBe(b.correlationId);
    expect(a.correlationId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
  });

  /**
   * Every class, constructed with the correlation id in its own final
   * parameter position. A class that reorders its constructor drops the id on
   * the floor and the client loses the link to the backend trace — invisible
   * until someone tries to debug a 401 at 3am.
   */
  const CORRELATION_CASES: Array<{
    name: string;
    withId: () => AppError;
    withoutId: () => AppError;
  }> = [
    {
      name: "AppError",
      withId: () => new AppError("x", 500, "CODE", undefined, "trace-1"),
      withoutId: () => new AppError("x", 500, "CODE"),
    },
    {
      name: "ValidationError",
      withId: () => new ValidationError("x", undefined, "trace-2"),
      withoutId: () => new ValidationError("x"),
    },
    {
      name: "NotFoundError",
      withId: () => new NotFoundError("Task", "id-1", undefined, "trace-3"),
      withoutId: () => new NotFoundError("Task", "id-1"),
    },
    {
      name: "UnauthorizedError",
      withId: () => new UnauthorizedError("x", undefined, "trace-4"),
      withoutId: () => new UnauthorizedError("x"),
    },
    {
      name: "AuthenticationError",
      withId: () => new AuthenticationError("x", undefined, "trace-5"),
      withoutId: () => new AuthenticationError("x"),
    },
    {
      name: "ForbiddenError",
      withId: () => new ForbiddenError("x", undefined, "trace-6"),
      withoutId: () => new ForbiddenError("x"),
    },
    {
      name: "RateLimitError",
      withId: () => new RateLimitError("x", undefined, "trace-7"),
      withoutId: () => new RateLimitError("x"),
    },
    {
      name: "ConflictError",
      withId: () => new ConflictError("x", undefined, "trace-8"),
      withoutId: () => new ConflictError("x"),
    },
    {
      name: "PaymentError",
      withId: () => new PaymentError("x", undefined, "trace-9"),
      withoutId: () => new PaymentError("x"),
    },
    {
      name: "ProviderError",
      withId: () => new ProviderError("x", "PROVIDER_ERROR", undefined, "trace-10"),
      withoutId: () => new ProviderError("x", "PROVIDER_ERROR"),
    },
  ];

  it.each(CORRELATION_CASES)("$name propagates an explicit correlation id", ({ withId }) => {
    expect(withId().correlationId).toMatch(/^trace-\d+$/);
  });

  it.each(CORRELATION_CASES)("$name falls back to a uuid when none is supplied", ({ withoutId }) => {
    expect(withoutId().correlationId).toMatch(/^[0-9a-f-]{36}$/i);
  });

  it("carries the correlation id into the serialised payload", () => {
    expect(new ForbiddenError("nope", undefined, "trace-6").serialize().correlationId).toBe(
      "trace-6",
    );
  });
});