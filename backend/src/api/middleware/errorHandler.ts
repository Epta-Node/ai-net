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
  const isDevelopment = getConfig().NODE_ENV === "development";
  const traceId: string =
    err instanceof AppError
      ? err.correlationId
      : (res.locals.traceId as string | undefined) ??
        (res.locals.correlationId as string | undefined) ??
        "unknown";
  const requestId = (res.locals.requestId as string | undefined) ?? "unknown";
  const log = createLogger({
    ...(res.locals.logContext as Record<string, unknown> | undefined),
    requestId,
    traceId,
    route: req.route?.path ? `${req.baseUrl}${req.route.path}` : req.path,
  });
  const statusCode =
    err instanceof AppError
      ? err.statusCode
      : (err as any)?.statusCode ?? (err as any)?.status ?? 500;
  const errorCode =
    err instanceof AppError
      ? err.code
      : isDevelopment
        ? (err as any)?.code ?? "INTERNAL_SERVER_ERROR"
        : "INTERNAL_SERVER_ERROR";

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
      event: "http.error",
      err,
      code: errorCode,
      statusCode,
      traceId,
      requestId,
      path: req.path,
      method: req.method,
      payload: req.body,
      stack: err instanceof Error ? err.stack : undefined,
    },
    "unhandled error",
  );

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
    requestId,
  };

  res.status(statusCode).json(response);
}