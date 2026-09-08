import { Request, Response, NextFunction } from "express";

// Helper to get a fresh module (so NODE_ENV changes take effect)
function setTestConfigEnv(nodeEnv: string) {
  process.env.NODE_ENV = nodeEnv;
  process.env.VENICE_API_KEY = "test-venice-key";
  process.env.DATABASE_URL = ":memory:";
}

function freshErrorHandler(nodeEnv: string) {
  jest.resetModules();
  setTestConfigEnv(nodeEnv);
  return require("../src/api/middleware/errorHandler")
    .errorHandler as typeof import("../src/api/middleware/errorHandler").errorHandler;
}

function makeReq(path = "/api/test"): Request {
  return { path, method: "GET" } as unknown as Request;
}

function makeRes(requestId = "req-123", correlationId = "corr-123"): {
  locals: { requestId: string; correlationId: string };
  status: jest.Mock;
  json: jest.Mock;
  _body?: unknown;
} {
  const res = {
    locals: { requestId, correlationId },
    status: jest.fn().mockReturnThis(),
    json: jest.fn().mockReturnThis(),
  };
  return res;
}

// Silence pino output during tests
jest.mock("../src/utils/logger", () => ({
  createLogger: () => ({
    error: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    debug: jest.fn(),
  }),
}));

afterEach(() => {
  delete process.env.NODE_ENV;
  delete process.env.VENICE_API_KEY;
  delete process.env.DATABASE_URL;
  jest.resetModules();
});

// ── Production mode ───────────────────────────────────────────────────────────

describe("errorHandler — production mode", () => {
  it("returns a generic error message (no raw err.message)", () => {
    const errorHandler = freshErrorHandler("production");
    const err = new Error("SQLITE_CONSTRAINT: UNIQUE constraint failed: users.email");
    const req = makeReq();
    const res = makeRes();

    errorHandler(err, req, res as unknown as Response, jest.fn() as NextFunction);

    expect(res.status).toHaveBeenCalledWith(500);
    const body = res.json.mock.calls[0][0];
    // error is now a structured object — message must not leak internals
    expect(body.error.message).not.toContain("SQLITE_CONSTRAINT");
    expect(body.error.message).toBe(
      "An unexpected error occurred. Please try again later.",
    );
  });

  it("does not include a stack trace", () => {
    const errorHandler = freshErrorHandler("production");
    const err = new Error("something internal");
    err.stack = "Error: something internal\n    at /app/src/services/foo.ts:42";
    const res = makeRes();

    errorHandler(err, makeReq(), res as unknown as Response, jest.fn() as NextFunction);

    const body = res.json.mock.calls[0][0];
    expect(body.error.stack).toBeUndefined();
    expect(body.stack).toBeUndefined();
  });

  it("always uses INTERNAL_ERROR code in production (no leaking err.code)", () => {
    const errorHandler = freshErrorHandler("production");
    const err: any = new Error("db is down");
    err.code = "DB_UNAVAILABLE";
    const res = makeRes();

    errorHandler(err, makeReq(), res as unknown as Response, jest.fn() as NextFunction);

    const body = res.json.mock.calls[0][0];
    expect(body.error.code).toBe("INTERNAL_ERROR");
  });

  it("falls back to INTERNAL_ERROR when err.code is absent", () => {
    const errorHandler = freshErrorHandler("production");
    const err = new Error("some unknown failure");
    const res = makeRes();

    errorHandler(err, makeReq(), res as unknown as Response, jest.fn() as NextFunction);

    const body = res.json.mock.calls[0][0];
    expect(body.error.code).toBe("INTERNAL_ERROR");
  });

  it("respects err.statusCode", () => {
    const errorHandler = freshErrorHandler("production");
    const err: any = new Error("not found");
    err.statusCode = 404;
    const res = makeRes();

    errorHandler(err, makeReq(), res as unknown as Response, jest.fn() as NextFunction);

    expect(res.status).toHaveBeenCalledWith(404);
  });

  it("always includes requestId in the response", () => {
    const errorHandler = freshErrorHandler("production");
    const res = makeRes("abc-999");

    errorHandler(
      new Error("oops"),
      makeReq(),
      res as unknown as Response,
      jest.fn() as NextFunction,
    );

    const body = res.json.mock.calls[0][0];
    expect(body.requestId).toBe("abc-999");
  });

  it("always includes path in the response", () => {
    const errorHandler = freshErrorHandler("production");
    const res = makeRes();

    errorHandler(
      new Error("oops"),
      makeReq("/api/agents"),
      res as unknown as Response,
      jest.fn() as NextFunction,
    );

    const body = res.json.mock.calls[0][0];
    expect(body.path).toBe("/api/agents");
  });

  it("error response includes correlationId and timestamp", () => {
    const errorHandler = freshErrorHandler("production");
    const res = makeRes("req-1", "corr-1");

    errorHandler(
      new Error("oops"),
      makeReq(),
      res as unknown as Response,
      jest.fn() as NextFunction,
    );

    const body = res.json.mock.calls[0][0];
    expect(body.error.correlationId).toBe("corr-1");
    expect(body.error.timestamp).toBeDefined();
  });
});

// ── Development mode ──────────────────────────────────────────────────────────

describe("errorHandler — development mode", () => {
  it("includes the raw error message", () => {
    const errorHandler = freshErrorHandler("development");
    const err = new Error("SQLITE_CONSTRAINT: UNIQUE constraint failed");
    const res = makeRes();

    errorHandler(err, makeReq(), res as unknown as Response, jest.fn() as NextFunction);

    const body = res.json.mock.calls[0][0];
    expect(body.error.message).toBe(err.message);
  });

  it("includes the stack trace", () => {
    const errorHandler = freshErrorHandler("development");
    const err = new Error("boom");
    err.stack = "Error: boom\n    at Object.<anonymous> (/app/src/foo.ts:10:3)";
    const res = makeRes();

    errorHandler(err, makeReq(), res as unknown as Response, jest.fn() as NextFunction);

    const body = res.json.mock.calls[0][0];
    expect(body.error.stack).toBe(err.stack);
  });

  it("always includes requestId in the response", () => {
    const errorHandler = freshErrorHandler("development");
    const res = makeRes("dev-req-42");

    errorHandler(
      new Error("oops"),
      makeReq(),
      res as unknown as Response,
      jest.fn() as NextFunction,
    );

    const body = res.json.mock.calls[0][0];
    expect(body.requestId).toBe("dev-req-42");
  });
});

// ── AppError instances ────────────────────────────────────────────────────────

describe("errorHandler — AppError instances", () => {
  it("uses AppError.statusCode, code, and message", () => {
    jest.resetModules();
    setTestConfigEnv("production");
    const { errorHandler } = require("../src/api/middleware/errorHandler");
    const { NotFoundError } = require("../src/errors");
    const res = makeRes();

    const err = new NotFoundError("Task", "task-123");
    errorHandler(err, makeReq(), res as unknown as Response, jest.fn() as NextFunction);

    expect(res.status).toHaveBeenCalledWith(404);
    const body = res.json.mock.calls[0][0];
    expect(body.error.code).toBe("NOT_FOUND");
    expect(body.error.message).toBe("Task 'task-123' not found");
    expect(body.error.correlationId).toBe(err.correlationId);
  });

  it("does not include details in production for AppError", () => {
    jest.resetModules();
    setTestConfigEnv("production");
    const { errorHandler } = require("../src/api/middleware/errorHandler");
    const { ValidationError } = require("../src/errors");
    const res = makeRes();

    const err = new ValidationError("Bad input", { field: "prompt" });
    errorHandler(err, makeReq(), res as unknown as Response, jest.fn() as NextFunction);

    const body = res.json.mock.calls[0][0];
    expect(body.error.details).toBeUndefined();
  });

  it("includes details in development for AppError", () => {
    jest.resetModules();
    setTestConfigEnv("development");
    const { errorHandler } = require("../src/api/middleware/errorHandler");
    const { ValidationError } = require("../src/errors");
    const res = makeRes();

    const details = { field: "prompt", reason: "too long" };
    const err = new ValidationError("Bad input", details);
    errorHandler(err, makeReq(), res as unknown as Response, jest.fn() as NextFunction);

    const body = res.json.mock.calls[0][0];
    expect(body.error.details).toEqual(details);
  });
});
