import type { Request, Response, NextFunction } from "express";
import { createLogger } from "../../utils/logger";
import { AppError } from "../../errors";

const log = createLogger();
const isProduction = process.env.NODE_ENV === "production";
const isDevelopment = process.env.NODE_ENV === "development";

/**
 * Central Express error-handling middleware.
 *
 * Behaviour:
 *  - AppError instances are serialized with their structured fields.
 *  - Unknown errors are treated as 500 and their internals are hidden in
 *    production.
 *  - Every response carries the correlationId (from AppError or from
 *    res.locals) so clients can correlate API errors with backend traces.
 *  - Unhandled (non-AppError) errors are always logged with a full stack
 *    trace so they can be investigated server-side.
 */
export function errorHandler(
  err: unknown,
  req: Request,
  res: Response,
  _next: NextFunction,
): void {
  // Resolve the correlationId from the error (preferred) or from the request.
  const correlationId: string =
    err instanceof AppError
      ? err.correlationId
      : (res.locals.correlationId as string | undefined) ??
        (res.locals.requestId as string | undefined) ??
        "unknown";

  if (err instanceof AppError) {
    if (!err.isOperational) {
      log.error(
        {
          err,
          error: err.message,
          code: err.code,
          statusCode: err.statusCode,
          stack: err.stack,
          method: req.method,
          path: req.path,
          requestId: res.locals.requestId,
          correlationId,
        },
        "non-operational error",
      );
    } else {
      log.warn(
        {
          err,
          error: err.message,
          code: err.code,
          statusCode: err.statusCode,
          method: req.method,
          path: req.path,
          requestId: res.locals.requestId,
          correlationId,
        },
        "operational error",
      );
    }

    const body: {
      error: {
        code: string;
        message: string;
        details?: unknown;
        correlationId: string;
      };
    } = {
      error: {
        code: err.code,
        message: err.message,
        correlationId,
      },
    };

    if (err.details !== undefined) {
      body.error.details = err.details;
    }

    res.status(err.statusCode).json(body);
    return;
  }

  // ── Unhandled / unknown error ────────────────────────────────────────────
  // Always log the full stack so it can be investigated.
  log.error(
    {
      err,
      correlationId,
      requestId: res.locals.requestId,
      path: req.path,
      method: req.method,
      stack: err instanceof Error ? err.stack : undefined,
    },
    "unhandled error",
  );

  const statusCode =
    (err as any)?.statusCode ?? (err as any)?.status ?? 500;

  const response: Record<string, unknown> = {
    error: {
      message: isProduction
        ? "Internal server error"
        : err instanceof Error
          ? err.message || "Internal server error"
          : "An unexpected error occurred",
      code: "INTERNAL_ERROR",
      correlationId,
      timestamp: new Date().toISOString(),
      ...(isDevelopment && err instanceof Error
        ? { stack: err.stack }
        : {}),
    },
    // Legacy fields kept for backward-compatibility with existing tests
    statusCode,
    path: req.path,
    requestId: res.locals.requestId,
  };

  res.status(statusCode).json(response);
}