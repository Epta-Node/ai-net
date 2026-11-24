import { Request, Response, NextFunction } from 'express';
import { randomUUID } from 'crypto';
import { tracingService } from '../../services/tracing';
import { runWithTraceContext } from '../../services/traceContext';

/**
 * Parse a W3C Trace Context `traceparent` header value.
 *
 * Format: `00-<traceId>-<parentTraceId>-<traceFlags>`
 * Example: `00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01`
 *
 * Returns the traceId and parentSpanId when valid, or undefined.
 */
function parseTraceparent(header: string): { traceId: string; parentSpanId: string } | undefined {
  const parts = header.split('-');
  if (parts.length !== 4) return undefined;
  const [version, traceId, parentSpanId, _flags] = parts;
  if (version !== '00') return undefined;
  if (!/^[0-9a-f]{32}$/.test(traceId)) return undefined;
  if (!/^[0-9a-f]{32}$/.test(parentSpanId)) return undefined;
  return { traceId, parentSpanId };
}

/**
 * Express middleware that ensures every request carries both an X-Request-Id
 * and a trace identifier (via X-Trace-Id, X-Correlation-ID, or W3C
 * traceparent).
 *
 * ### X-Request-Id (unchanged behaviour)
 * - If the client sends an `X-Request-Id` header, that value is reused.
 * - Otherwise a new UUID v4 is generated.
 * - Attached to `res.locals.requestId` and echoed as the `X-Request-Id`
 *   response header.
 *
 * ### Trace identity (extended for Issue #407)
 * The trace ID (correlationId) is resolved from, in priority order:
 *   1. W3C `traceparent` header — parsed for the traceId field
 *   2. `X-Trace-Id` header — used as-is
 *   3. `X-Correlation-ID` header — used as-is
 *   4. Auto-generated UUID v4
 *
 * The resolved traceId is attached to `res.locals.traceId`,
 * `res.locals.correlationId`, `req.traceId`, `req.correlationId` and echoed as
 * the `X-Trace-Id` / `X-Correlation-ID` response headers so downstream
 * services can forward it.
 *
 * ### AsyncLocalStorage
 * After resolving the trace identity, the middleware enters an
 * `AsyncLocalStorage` context so downstream code (route handlers,
 * coordinator, payment, logging) can access the traceId/spanId without
 * manual parameter threading.
 *
 * A tracing span is opened for the lifetime of the request and closed (with
 * status `'completed'` or `'failed'`) when the response finishes.
 */
export function requestId(req: Request, res: Response, next: NextFunction): void {
  const id = (req.headers["x-request-id"] as string | undefined) || randomUUID();
  res.locals.requestId = id;
  req.requestId = id;
  res.setHeader("X-Request-Id", id);

  // ── Trace identity ────────────────────────────────────────────────────────
  let traceId: string | undefined;
  let parentSpanId: string | undefined;

  // 1. W3C traceparent
  const traceparent = req.headers['traceparent'] as string | undefined;
  if (traceparent) {
    const parsed = parseTraceparent(traceparent);
    if (parsed) {
      traceId = parsed.traceId;
      parentSpanId = parsed.parentSpanId;
    }
  }

  // 2. X-Trace-Id / X-Correlation-ID (backward compatible)
  if (!traceId) {
    traceId =
      (req.headers['x-trace-id'] as string | undefined) ||
      (req.headers['x-correlation-id'] as string | undefined);
  }

  // 3. Generate fresh
  if (!traceId) {
    traceId = randomUUID();
  }

  res.locals.traceId = traceId;
  res.locals.correlationId = traceId;
  req.traceId = traceId;
  req.correlationId = traceId;
  res.setHeader("X-Trace-Id", traceId);
  res.setHeader('X-Correlation-ID', traceId);

  // ── Tracing span ──────────────────────────────────────────────────────────
  const span = tracingService.startSpan(
    traceId,
    'backend',
    'http_request',
    { method: req.method, path: req.path, requestId: id, ...(parentSpanId ? { parentSpanId } : {}) }
  );

  if (typeof res.on === "function") {
    res.on("finish", () => {
      const status = res.statusCode < 400 ? "completed" : "failed";
      tracingService.endSpan(span.spanId, status, { statusCode: res.statusCode });
    });
  }

  // ── AsyncLocalStorage context ─────────────────────────────────────────────
  // Enter the trace context so every downstream call (route handlers,
  // coordinator, payment, logger) can access traceId/spanId implicitly.
  runWithTraceContext(
    { traceId, spanId: span.spanId, requestId: id, ...(parentSpanId ? { parentSpanId } : {}) },
    () => next(),
  );
}