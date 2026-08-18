import { Request, Response, NextFunction } from 'express';
import { randomUUID } from 'crypto';

/**
 * Express middleware that ensures every request has an X-Request-Id.
 *
 * - If the client sends an `X-Request-Id` header, that value is reused
 *   (for distributed tracing across services).
 * - Otherwise a new UUID v4 is generated.
 *
 * The ID is attached to `res.locals.requestId` and echoed back as the
 * `X-Request-Id` response header.
 */
export function requestId(req: Request, res: Response, next: NextFunction): void {
  const id = (req.headers['x-request-id'] as string) || randomUUID();
  res.locals.requestId = id;
  res.setHeader('X-Request-Id', id);
  next();
}
