/**
 * Idempotency middleware — intercepts POST requests carrying an
 * `Idempotency-Key` header and either replays a cached response or reserves the
 * key before the handler is allowed to run.
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
 * 1. The key is trimmed and rejected with **400** when it exceeds
 *    {@link IDEMPOTENCY_KEY_MAX_LENGTH} characters, so a caller cannot push an
 *    arbitrarily large value into the primary-key index.
 * 2. The `(wallet, key)` slot is **reserved before `next()` is called**:
 *    - **reserved** → the handler runs, and the slot is promoted to a completed
 *      record once a 2xx/3xx response is written.
 *    - **replay** → the stored response is returned and the handler never runs.
 *    - **conflict** → a reservation for the same `(wallet, key)` is still in
 *      flight, so the caller gets **409** and the handler never runs.
 * 3. If the handler produces a 4xx/5xx the reservation is released again, so a
 *    genuine retry is not blocked by the previous failure.
 *
 * Reserving *before* dispatch is what makes this safe: the previous
 * check-then-execute version let two concurrent requests with the same key both
 * miss the lookup and both run the handler, so a double-clicked payment button
 * charged twice while the store still looked correct.
 *
 * ## Key format
 *
 * Any non-empty string of at most {@link IDEMPOTENCY_KEY_MAX_LENGTH} characters
 * is accepted — UUIDs, nanoids, and other schemes all work.  Keys are scoped
 * per wallet, so two wallets may independently use the same key value.
 */

import { Request, Response, NextFunction } from 'express';
import type { IdempotencyStore } from '../../services/idempotency';
import { getDefaultIdempotencyStore } from '../../services/idempotency';
import { ValidationError, AppError } from '../../errors';
import { createLogger } from '../../utils/logger';

const log = createLogger({ component: 'idempotency-middleware' });

/**
 * Maximum accepted length of the `Idempotency-Key` header, in characters.
 * Longer keys are rejected with 400 before they reach the store.
 */
export const IDEMPOTENCY_KEY_MAX_LENGTH = 128;

/** Error code returned when a duplicate arrives while the original is in flight. */
export const IDEMPOTENCY_IN_PROGRESS_CODE = 'REQUEST_IN_PROGRESS';

/** Seconds advertised in `Retry-After` when a duplicate is still in flight. */
const IN_FLIGHT_RETRY_AFTER_SECONDS = 1;

/**
 * Resolve the wallet a key is scoped to.
 *
 * Mirrors how the task routers derive `walletPublicKey`, so the reservation is
 * always attributed to the same identity the handler charges.  Unparseable or
 * missing wallets fall back to the shared `anonymous` bucket, which keeps
 * first-party anonymous callers working while still denying one anonymous
 * client another anonymous client's response when they pick distinct keys.
 */
function resolveWallet(req: Request): string {
  const fromBody = (req.body as { walletPublicKey?: unknown } | undefined)?.walletPublicKey;
  if (typeof fromBody === 'string' && fromBody.trim() !== '') return fromBody.trim();

  const fromHeader = req.headers['walletpublickey'];
  if (typeof fromHeader === 'string' && fromHeader.trim() !== '') return fromHeader.trim();

  return 'anonymous';
}

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
    const header = req.headers['idempotency-key'];
    const rawKey = Array.isArray(header) ? header[0] : header;

    // No key → pass through transparently.
    if (!rawKey || rawKey.trim() === '') {
      return next();
    }

    const key = rawKey.trim();

    // ── Bound the key before it ever reaches the primary-key index ──────────
    if (key.length > IDEMPOTENCY_KEY_MAX_LENGTH) {
      return next(
        new ValidationError(
          `Idempotency-Key too long (max ${IDEMPOTENCY_KEY_MAX_LENGTH} characters)`,
          { field: 'Idempotency-Key', maxLength: IDEMPOTENCY_KEY_MAX_LENGTH, actual: key.length },
        ),
      );
    }

    const wallet = resolveWallet(req);

    // ── Reserve before dispatch ─────────────────────────────────────────────
    let reservation;
    try {
      reservation = resolvedStore.reserve(wallet, key);
    } catch (err) {
      // Never fail a request because the idempotency store is unavailable —
      // degrade to the previous (unprotected) behaviour rather than 500.
      log.error({ err, key, wallet }, 'idempotency reservation failed');
      return next();
    }

    if (reservation.status === 'replay' && reservation.entry) {
      log.debug({ key, wallet }, 'replaying idempotent response');
      const entry = reservation.entry;
      res.status(entry.statusCode ?? 200);
      res.setHeader('Idempotency-Key', key);
      res.setHeader('X-Idempotent-Replay', 'true');
      try {
        res.json(JSON.parse(entry.responseBody ?? 'null'));
      } catch {
        // Fallback: send raw string if JSON parsing fails.
        res.status(entry.statusCode ?? 200).send(entry.responseBody ?? '');
      }
      return;
    }

    if (reservation.status === 'conflict') {
      // A concurrent duplicate: the side effect is already under way, so the
      // handler must not run a second time.
      log.info({ key, wallet }, 'rejecting concurrent duplicate idempotency key');
      res.setHeader('Retry-After', String(IN_FLIGHT_RETRY_AFTER_SECONDS));
      return next(
        new AppError(
          'A request with this Idempotency-Key is still in progress',
          409,
          IDEMPOTENCY_IN_PROGRESS_CODE,
          { idempotencyKey: key, status: 'in_flight' },
        ),
      );
    }

    // ── Reserved: this caller owns the slot ────────────────────────────────
    const { reservationId } = reservation;
    if (!reservationId) {
      return next();
    }

    const finalize = (store: 'complete' | 'release', statusCode?: number, body?: unknown): void => {
      try {
        if (store === 'complete') {
          resolvedStore.complete(wallet, key, reservationId, statusCode as number, body);
        } else {
          resolvedStore.release(wallet, key, reservationId);
        }
      } catch (err) {
        log.error({ err, key, wallet }, 'failed to finalize idempotency reservation');
      }
    };

    // Intercept res.json()/res.send() to capture the outgoing body. The
    // response is only persisted for 2xx/3xx: errors are not safe to replay
    // (e.g. a transient 500), so their reservation is released instead.
    const originalJson = res.json.bind(res);
    const originalSend = res.send.bind(res);
    let capturedBody: unknown = undefined;

    res.json = function patchedJson(body: unknown): Response {
      capturedBody = body;
      return originalJson(body);
    };

    res.send = function patchedSend(body: unknown): Response {
      if (typeof body === 'string' || Buffer.isBuffer(body)) {
        try {
          capturedBody = JSON.parse(body.toString());
        } catch {
          capturedBody = body.toString();
        }
      } else if (body !== undefined) {
        capturedBody = body;
      }
      return originalSend(body);
    };

    res.on('finish', () => {
      const status = res.statusCode;
      if (status >= 200 && status < 400) {
        finalize('complete', status, capturedBody);
      } else {
        finalize('release');
      }
    });

    try {
      next();
    } catch (err) {
      // The handler threw synchronously before writing a response. Drop the
      // reservation so the client can retry the key.
      finalize('release');
      throw err;
    }
  };
}

/**
 * Convenience middleware using the default singleton store.
 * Suitable for most production usages where a single store suffices.
 */
export const idempotencyMiddleware = createIdempotencyMiddleware();
