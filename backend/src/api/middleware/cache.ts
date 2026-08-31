/**
 * Express response-caching middleware.
 *
 * Issue #263 — acceptance criteria:
 *  ✓ Cache middleware with configurable TTL
 *  ✓ Cache keys: api:{method}:{path}:{query_hash}
 *  ✓ Cache-aside: check cache → fallback to handler → populate cache
 *  ✓ Cache hit/miss logged via Pino
 *  ✓ X-Cache-Bypass header skips cache
 *  ✓ Configurable TTL per endpoint
 *
 * Usage:
 *   router.get('/agents', cacheMiddleware({ ttl: 60 }), handleGetAgents);
 *
 * The middleware intercepts `res.json()` to capture the response body before
 * it is sent to the client, stores it in the cache, then forwards normally.
 */

import type { Request, Response, NextFunction, RequestHandler } from 'express';
import { getCacheClient, buildCacheKey } from '../../cache/index';
import { logger } from '../logger';

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface CacheMiddlewareOptions {
  /**
   * Time-to-live in seconds for this endpoint's cached responses.
   * Pass 0 to disable caching (middleware becomes a no-op passthrough).
   */
  ttl: number;

  /**
   * Optional function to derive extra cache-key components from the request
   * (e.g. a user-specific segment).  Return '' to use no suffix.
   */
  keyExtra?: (req: Request) => string;
}

// ---------------------------------------------------------------------------
// Header constants
// ---------------------------------------------------------------------------

export const CACHE_BYPASS_HEADER = 'x-cache-bypass';
export const CACHE_STATUS_HEADER = 'x-cache'; // HIT | MISS | BYPASS

// ---------------------------------------------------------------------------
// Middleware factory
// ---------------------------------------------------------------------------

/**
 * Creates an Express middleware that caches JSON responses.
 *
 * @param options.ttl         TTL in seconds (0 = disable)
 * @param options.keyExtra    Optional per-request cache key suffix
 */
export function cacheMiddleware(options: CacheMiddlewareOptions): RequestHandler {
  const { ttl, keyExtra } = options;

  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    // ── 0. Short-circuit when TTL is 0 ───────────────────────────────────
    if (ttl === 0) {
      res.setHeader(CACHE_STATUS_HEADER, 'BYPASS');
      next();
      return;
    }

    // ── 1. Bypass header check ────────────────────────────────────────────
    if (req.headers[CACHE_BYPASS_HEADER]) {
      res.setHeader(CACHE_STATUS_HEADER, 'BYPASS');
      logger.debug({ path: req.path }, '[cache] bypass via header');
      next();
      return;
    }

    // ── 2. Build cache key ────────────────────────────────────────────────
    const extra = keyExtra ? keyExtra(req) : '';
    const baseKey = buildCacheKey(req.method, req.path, req.query as Record<string, unknown>);
    const cacheKey = extra ? `${baseKey}:${extra}` : baseKey;

    // ── 3. Cache lookup ───────────────────────────────────────────────────
    let cached: string | undefined;
    try {
      cached = await getCacheClient().get(cacheKey);
    } catch (err) {
      // Cache unavailability must never block the request
      logger.warn({ err, cacheKey }, '[cache] get error — falling through to handler');
    }

    if (cached !== undefined) {
      // ── HIT ──────────────────────────────────────────────────────────
      res.setHeader(CACHE_STATUS_HEADER, 'HIT');
      res.setHeader('Content-Type', 'application/json');
      logger.debug({ cacheKey }, '[cache] HIT');
      res.send(cached);
      return;
    }

    // ── 4. MISS — run handler, intercept response ─────────────────────────
    res.setHeader(CACHE_STATUS_HEADER, 'MISS');
    logger.debug({ cacheKey }, '[cache] MISS');

    // Patch res.json to capture the body before it's flushed
    const originalJson = res.json.bind(res);
    res.json = function (body: unknown): Response {
      // Restore original immediately to prevent double-patching
      res.json = originalJson;

      // Serialise and cache asynchronously — do not block the response
      const serialised = JSON.stringify(body);
      getCacheClient()
        .set(cacheKey, serialised, ttl)
        .catch((err) =>
          logger.warn({ err, cacheKey }, '[cache] set error — response served uncached'),
        );

      return originalJson(body);
    };

    next();
  };
}
