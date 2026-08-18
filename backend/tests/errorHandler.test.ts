import { Request, Response, NextFunction } from "express";

// Helper to get a fresh module (so NODE_ENV changes take effect)
function freshErrorHandler(nodeEnv: string) {
  jest.resetModules();
  process.env.NODE_ENV = nodeEnv;
  return require("../src/api/middleware/errorHandler")
    .errorHandler as typeof import("../src/api/middleware/errorHandler").errorHandler;
}

function makeReq(path = "/api/test"): Request {
  return { path, method: "GET" } as unknown as Request;
}

function makeRes(requestId = "req-123"): {
  locals: { requestId: string };
  status: jest.Mock;
  json: jest.Mock;
  _body?: unknown;
} {
  const res = {
    locals: { requestId },
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
    expect(body.error).not.toContain("SQLITE_CONSTRAINT");
    expect(body.error).not.toBe(err.message);
    expect(body.message).toBe(
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
    expect(body.stack).toBeUndefined();
  });

  it("uses err.code when present", () => {
    const errorHandler = freshErrorHandler("production");
    const err: any = new Error("db is down");
    err.code = "DB_UNAVAILABLE";
    const res = makeRes();

    errorHandler(err, makeReq(), res as unknown as Response, jest.fn() as NextFunction);

    const body = res.json.mock.calls[0][0];
    expect(body.error).toBe("DB_UNAVAILABLE");
  });

  it("falls back to INTERNAL_SERVER_ERROR when err.code is absent", () => {
    const errorHandler = freshErrorHandler("production");
    const err = new Error("some unknown failure");
    const res = makeRes();

    errorHandler(err, makeReq(), res as unknown as Response, jest.fn() as NextFunction);

    const body = res.json.mock.calls[0][0];
    expect(body.error).toBe("INTERNAL_SERVER_ERROR");
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
});

// ── Development mode ──────────────────────────────────────────────────────────

describe("errorHandler — development mode", () => {
  it("includes the raw error message", () => {
    const errorHandler = freshErrorHandler("development");
    const err = new Error("SQLITE_CONSTRAINT: UNIQUE constraint failed");
    const res = makeRes();

    errorHandler(err, makeReq(), res as unknown as Response, jest.fn() as NextFunction);

    const body = res.json.mock.calls[0][0];
    expect(body.error).toBe(err.message);
  });

  it("includes the stack trace", () => {
    const errorHandler = freshErrorHandler("development");
    const err = new Error("boom");
    err.stack = "Error: boom\n    at Object.<anonymous> (/app/src/foo.ts:10:3)";
    const res = makeRes();

    errorHandler(err, makeReq(), res as unknown as Response, jest.fn() as NextFunction);

    const body = res.json.mock.calls[0][0];
    expect(body.stack).toBe(err.stack);
  });

  it("does not include a generic message field", () => {
    const errorHandler = freshErrorHandler("development");
    const res = makeRes();

    errorHandler(
      new Error("debug detail"),
      makeReq(),
      res as unknown as Response,
      jest.fn() as NextFunction,
    );

    const body = res.json.mock.calls[0][0];
    expect(body.message).toBeUndefined();
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
