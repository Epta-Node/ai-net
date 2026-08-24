import { Request, Response, NextFunction } from 'express';
import { randomUUID } from 'crypto';
import { tracingService } from '../../services/tracing';

/**
 * Express middleware that ensures every request carries both an X-Request-Id
 * and an X-Correlation-ID.
 *
 * ### X-Request-Id (unchanged behaviour)
 * - If the client sends an `X-Request-Id` header, that value is reused.
 * - Otherwise a new UUID v4 is generated.
 * - Attached to `res.locals.requestId` and echoed as the `X-Request-Id`
 *   response header.
 *
 * ### X-Correlation-ID (distributed tracing)
 * - If the client sends an `X-Correlation-ID` header, that value is propagated
 *   unchanged, so a caller can link its own trace to this service's spans.
 * - Otherwise a new UUID v4 is generated, establishing a new trace root.
 * - Attached to `res.locals.correlationId` and echoed as the
 *   `X-Correlation-ID` response header so downstream services can forward it.
 *
 * A tracing span is opened for the lifetime of the request and closed (with
 * status `'completed'` or `'failed'`) when the response finishes.
 */
export function requestId(req: Request, res: Response, next: NextFunction): void {
  // ── X-Request-Id ──────────────────────────────────────────────────────────
  const id = (req.headers['x-request-id'] as string) || randomUUID();
  res.locals.requestId = id;
  res.setHeader('X-Request-Id', id);

  // ── X-Correlation-ID ──────────────────────────────────────────────────────
  const correlationId =
    (req.headers['x-correlation-id'] as string) || randomUUID();
  res.locals.correlationId = correlationId;
  res.setHeader('X-Correlation-ID', correlationId);

  // Open a tracing span for this HTTP request.
  const span = tracingService.startSpan(
    correlationId,
    'backend',
    'http_request',
    { method: req.method, path: req.path, requestId: id }
  );

  if (typeof res.on === 'function') {
    res.on('finish', () => {
      const status = res.statusCode < 400 ? 'completed' : 'failed';
      tracingService.endSpan(span.spanId, status, {
        statusCode: res.statusCode,
      });
    });
  }

  next();
}
