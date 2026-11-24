import type { Request, Response, NextFunction } from "express";
import { createLogger } from "../../utils/logger";
import { AppError, QuotaExceededError } from "../../errors";
import { getConfig } from "../../config";
import { HTTP_STATUS_FOR_CODE, type ErrorCode } from "../../errors/ErrorCode";

const isProduction = process.env.NODE_ENV === "production";

/**
 * Build the canonical error envelope for every API response.
 *
 * Schema: { error: { code, message, details?, path, correlationId, timestamp? } }
 */
function buildErrorEnvelope({
  code,
  message,
  statusCode,
  path,
  correlationId,
  requestId,
  details,
  stack,
  includeTimestamp = true,
}: {
  code: string;
  message: string;
  statusCode: number;
  path: string;
  correlationId: string;
  /** Per-request id, when the request middleware assigned one. */
  requestId?: string;
  details?: unknown;
  /** Development-only stack trace, surfaced at `error.stack`. */
  stack?: string;
  includeTimestamp?: boolean;
}): Record<string, unknown> {
  const envelope: Record<string, unknown> = {
    error: {
      code,
      message,
      path,
      correlationId,
    },
  };

  const error = envelope.error as Record<string, unknown>;

  if (details !== undefined) {
    error.details = details;
  }

  if (stack !== undefined) {
    error.stack = stack;
  }

  if (includeTimestamp) {
    error.timestamp = new Date().toISOString();
  }

  // Legacy top-level fields kept for backward compatibility with older clients/tests
  return {
    ...envelope,
    statusCode,
    path,
    requestId: requestId ?? correlationId,
    message,
  };
}

/**
 * Resolve the HTTP status for an unknown error that may carry a code/status.
 */
function resolveStatusCode(err: unknown): number {
  if (err instanceof AppError) return err.statusCode;
  return (
    (err as any)?.statusCode ??
    (err as any)?.status ??
    HTTP_STATUS_FOR_CODE[(err as any)?.code as ErrorCode] ??
    500
  );
}

/**
 * Resolve the machine-readable error code for an unknown error.
 */
function resolveErrorCode(err: unknown, isDevelopment: boolean): string {
  if (err instanceof AppError) return err.code;
  return isDevelopment ? ((err as any)?.code ?? "INTERNAL_ERROR") : "INTERNAL_ERROR";
}

/**
 * Central Express error-handling middleware.
 *
 * Every response conforms to the canonical envelope:
 *   { error: { code, message, details?, path, correlationId, timestamp } }
 *
 * AppError instances preserve their structured fields. Unknown errors are
 * treated as 500 INTERNAL_ERROR and their internals are hidden in production.
 * Every response carries the correlationId so clients can correlate API errors
 * with backend traces.
 */
export function errorHandler(
  err: unknown,
  req: Request,
  res: Response,
  _next: NextFunction,
): void {
  const config = getConfig();
  const isDevelopment = config.NODE_ENV === "development";

  const correlationId: string =
    (err instanceof AppError
      ? err.correlationId
      : (res.locals.traceId as string | undefined) ??
        (res.locals.correlationId as string | undefined)) ??
    "unknown";

  const requestId = (res.locals.requestId as string | undefined) ?? "unknown";
  const path = req.path;

  const log = createLogger({
    ...(res.locals.logContext as Record<string, unknown> | undefined),
    requestId,
    traceId: correlationId,
    route: req.route?.path ? `${req.baseUrl}${req.route.path}` : path,
  });

  const statusCode = resolveStatusCode(err);
  const errorCode = resolveErrorCode(err, isDevelopment);

  if (err instanceof AppError) {
    const logPayload: Record<string, unknown> = {
      err,
      error: err.message,
      code: err.code,
      statusCode: err.statusCode,
      method: req.method,
      path,
      requestId,
      correlationId,
    };

    if (!err.isOperational) {
      log.error({ ...logPayload, stack: err.stack }, "non-operational error");
    } else {
      log.warn(logPayload, "operational error");
    }

    // 429s that know when their budget resets advertise it, so an automated
    // client can back off until then instead of hammering a closed window.
    const retryAfterSeconds =
      err instanceof QuotaExceededError
        ? err.retryAfterSeconds
        : typeof (err.details as { retryAfterSeconds?: unknown } | undefined)
            ?.retryAfterSeconds === "number"
          ? ((err.details as { retryAfterSeconds: number }).retryAfterSeconds)
          : undefined;
    if (err.statusCode === 429 && retryAfterSeconds !== undefined) {
      res.setHeader("Retry-After", String(Math.max(0, Math.ceil(retryAfterSeconds))));
    }

    const body = buildErrorEnvelope({
      code: err.code,
      message: err.message,
      statusCode: err.statusCode,
      path,
      correlationId,
      requestId,
      // Structured details are a debugging aid: production responses keep the
      // code/message contract and nothing else.
      details: isProduction ? undefined : err.details,
    });

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
      correlationId,
      requestId,
      path,
      method: req.method,
      payload: req.body,
      stack: err instanceof Error ? err.stack : undefined,
    },
    "unhandled error",
  );

  const message = isProduction
    ? "An unexpected error occurred. Please try again later."
    : err instanceof Error
      ? err.message || "Internal server error"
      : "An unexpected error occurred";

  const body = buildErrorEnvelope({
    code: errorCode,
    message,
    statusCode,
    path,
    correlationId,
    requestId,
    stack: isDevelopment && err instanceof Error ? err.stack : undefined,
  });

  res.status(statusCode).json(body);
}
