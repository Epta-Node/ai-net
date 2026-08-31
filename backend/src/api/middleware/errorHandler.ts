import type { Request, Response, NextFunction } from "express";
import { createLogger } from "../../utils/logger";
import { AppError } from "../../errors";

const log = createLogger();

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
    // ── Structured AppError ──────────────────────────────────────────────────
    log.error(
      {
        err,
        code: err.code,
        statusCode: err.statusCode,
        correlationId,
        requestId: res.locals.requestId,
        path: req.path,
        method: req.method,
      },
      `AppError: ${err.code}`,
    );

    const serialized = err.serialize(req.path, isDevelopment);

    res.status(err.statusCode).json({ error: serialized });
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
      code:
        isDevelopment
          ? (err as any)?.code ?? "INTERNAL_ERROR"
          : "INTERNAL_ERROR",
      message: isDevelopment
        ? (err instanceof Error ? err.message : "An unexpected error occurred")
        : "An unexpected error occurred. Please try again later.",
      correlationId,
      timestamp: new Date().toISOString(),
      path: req.path,
      ...(isDevelopment && err instanceof Error
        ? { stack: err.stack }
        : {}),
    },
    // Legacy fields kept for backward-compatibility with existing tests
    statusCode,
    requestId: res.locals.requestId,
  };

  res.status(statusCode).json(response);
}
