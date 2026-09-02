/**
 * Idempotency middleware — intercepts POST requests carrying an
 * `Idempotency-Key` header and either replays a cached response or captures
 * the outgoing response for future replays.
 *
 * ## Usage
 *
 * ```ts
 * import { idempotencyMiddleware } from './middleware/idempotency';
 *
 * router.post('/', idempotencyMiddleware, handler);
 * ```
 *
 * The middleware reads `Idempotency-Key` from the request headers (case-
 * insensitive).  When present:
 *
 * 1. It queries the idempotency store for a matching key.
 * 2. If found **and not expired**, the stored response is replayed and the
 *    handler is never called.
 * 3. If not found, the middleware monkey-patches `res.json()` to capture the
 *    response body, then calls `next()`.  After the handler writes its
 *    response the captured body is persisted to the store.
 *
 * ## Key format
 *
 * Any non-empty string is accepted.  The issue suggests UUID v4 keys; this
 * middleware does not enforce format so callers can use nanoids, UUIDs, or
 * other schemes.
 */

import { Request, Response, NextFunction } from 'express';
import type { IdempotencyStore } from '../../services/idempotency';
import { getDefaultIdempotencyStore } from '../../services/idempotency';
import { createLogger } from '../../utils/logger';

const log = createLogger({ component: 'idempotency-middleware' });

/**
 * Create an idempotency middleware bound to a specific store.
 *
 * @param store  Optional store instance.  When omitted the default singleton
 *               is used.
 */
export function createIdempotencyMiddleware(store?: IdempotencyStore) {
  const resolvedStore = store ?? getDefaultIdempotencyStore();

  return function idempotencyMiddleware(
    req: Request,
    res: Response,
    next: NextFunction,
  ): void {
    const key = req.headers['idempotency-key'] as string | undefined;

    // No key → pass through transparently.
    if (!key || key.trim() === '') {
      return next();
    }

    const trimmedKey = key.trim();

    // ── Lookup ─────────────────────────────────────────────────────────────
    const existing = resolvedStore.get(trimmedKey);
    if (existing) {
      log.debug({ key: trimmedKey }, 'replaying idempotent response');
      res.status(existing.statusCode);
      try {
        const body = JSON.parse(existing.responseBody);
        res.json(body);
      } catch {
        // Fallback: send raw string if JSON parsing fails.
        res.status(existing.statusCode).send(existing.responseBody);
      }
      return;
    }

    // ── Capture ────────────────────────────────────────────────────────────
    // Intercept res.json() to capture the outgoing body, then persist.
    const originalJson = res.json.bind(res);
    let capturedBody: unknown = undefined;

    res.json = function patchedJson(body: unknown): Response {
      capturedBody = body;

      // Persist after the response has been sent so we capture the final shape.
      res.on('finish', () => {
        try {
          // Only store successful (2xx/3xx) responses; errors are not
          // idempotent-safe to replay (e.g. transient 500s).
          const status = res.statusCode;
          if (status >= 200 && status < 400) {
            resolvedStore.storeResponse(trimmedKey, status, capturedBody);
          }
        } catch (err) {
          log.error({ err, key: trimmedKey }, 'failed to store idempotent response');
        }
      });

      return originalJson(body);
    };

    next();
  };
}

/**
 * Convenience middleware using the default singleton store.
 * Suitable for most production usages where a single store suffices.
 */
export const idempotencyMiddleware = createIdempotencyMiddleware();
