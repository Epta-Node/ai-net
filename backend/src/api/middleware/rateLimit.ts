import { LRUCache } from "lru-cache";
import type { Request, Response, NextFunction } from "express";

export interface RateLimitOptions {
  /** Rolling window in milliseconds. Default: 60 000 (1 minute). */
  windowMs?: number;
  /** Maximum number of requests allowed within the window. Default: 20. */
  maxRequests?: number;
  /**
   * Maximum number of distinct IPs tracked simultaneously **per limiter
   * instance**. When this many entries are present, the least-recently-used
   * IP is evicted on the next accepted request. Defaults to 10 000, which
   * keeps the worst-case memory footprint predictable under IP-flood
   * attacks (issue #154). Note: the module-instantiated default limiters
   * (`rateLimitMiddleware` and `registerRateLimitMiddleware`) are separate
   * instances, so two requests in flight can touch up to 2 × maxEntries
   * entries combined.
   */
  maxEntries?: number;
}

interface Window {
  timestamps: number[];
}

export interface RateLimiter {
  middleware: (req: Request, res: Response, next: NextFunction) => void;
  /**
   * Fully clears tracked state. In this implementation there is no
   * background eviction interval to halt, so `stop()` is essentially
   * `cache.clear()` — kept for API compatibility with the original
   * implementation and for tests / graceful shutdown hooks.
   *
   * **Behavior change vs the original implementation** (issue #154): the
   * old `stop()` called `clearInterval()` on a background eviction sweep;
   * the new `stop()` clears the cache. Anything that stored the factory
   * return value and relied on the old semantic should migrate.
   */
  stop: () => void;
  /**
   * Current number of tracked IPs. Exposed primarily for tests and
   * operational debugging — not part of the rate-limiting contract.
   * @internal
   */
  size: () => number;
}

/**
 * Create a configurable in-memory sliding-window rate limiter.
 *
 * Backing store is `lru-cache`, which provides both:
 *  - a hard cap on entry count (`max` / `maxEntries`) so the worst-case
 *    memory footprint is bounded against IP-flood attacks (issue #154 —
 *    the previous `Map`-only implementation grew unboundedly between the
 *    once-per-minute TTL sweeps); and
 *  - TTL-based eviction (`ttl` / `windowMs`) so quiet IPs drop out
 *    automatically after their window passes.
 *
 * Active IPs stay cached because every accepted request calls
 * `windows.set(ip, win)`, which refreshes the entry's age; the
 * least-recently-used entry is evicted only when inserting past `max`.
 */
export function createRateLimiter(opts: RateLimitOptions = {}): RateLimiter {
  const windowMs = opts.windowMs ?? 60_000;
  const maxRequests = opts.maxRequests ?? 20;
  const maxEntries = opts.maxEntries ?? 10_000;

  const windows = new LRUCache<string, Window>({
    max: maxEntries,
    ttl: windowMs,
    // Don't refresh the age on read: a 429 must not let stale IPs linger.
    updateAgeOnGet: false,
  });

  function middleware(req: Request, res: Response, next: NextFunction): void {
    // NOTE: `req.ip` depends on Express's `trust proxy` setting. If the app
    // ever sets `trust proxy = true`, attackers can rotate `X-Forwarded-For`
    // to cheaply produce synthetic IPs; the cache remains bounded by
    // `maxEntries` but each request still costs LRU insert/refresh work.
    // Until trust proxy is configured, every untrusted request collapses to
    // a single `"unknown"` entry, so the rate limiter is effectively a
    // global cap — consider raising `maxRequests` or skipping rate-limiting
    // for `ip === "unknown"` if you ever turn trust proxy on.
    const ip = req.ip ?? "unknown";
    const now = Date.now();
    const cutoff = now - windowMs;

    let win = windows.get(ip) ?? { timestamps: [] };
    // Always trim the timestamps for this IP — even when the entry was
    // pulled from the cache — so partial windows decay correctly across
    // the rolling boundary.
    win.timestamps = win.timestamps.filter((t) => t > cutoff);

    if (win.timestamps.length >= maxRequests) {
      const oldest = win.timestamps[0]!;
      const retryAfter = Math.ceil((oldest + windowMs - now) / 1000);
      res.setHeader("Retry-After", String(retryAfter));
      res
        .status(429)
        .json({ error: { message: "Too many requests", code: "RATE_LIMITED" } });
      return;
    }

    win.timestamps.push(now);
    // Re-set the entry to refresh its age so active IPs persist; this
    // also keeps the LRU recency ordering accurate for eviction.
    windows.set(ip, win);
    next();
  }

  function stop(): void {
    windows.clear();
  }

  return {
    middleware,
    stop,
    size: () => windows.size,
  };
}

// ── Default instances ────────────────────────────────────────────────────────

/**
 * Default rate limiter used by POST /api/tasks.
 * 20 requests per minute per IP.
 */
const defaultLimiter = createRateLimiter({ windowMs: 60_000, maxRequests: 20 });
export const rateLimitMiddleware = defaultLimiter.middleware;

/**
 * Stricter rate limiter used by POST /api/agents/register.
 * 10 requests per minute per IP — registration is an expensive operation.
 */
const registerLimiter = createRateLimiter({ windowMs: 60_000, maxRequests: 10 });
export const registerRateLimitMiddleware = registerLimiter.middleware;

/**
 * Rate limiter used by POST /api/agents/:id/heartbeat.
 * 60 requests per minute per IP to allow periodic agent pings while preventing abuse.
 */
const heartbeatLimiter = createRateLimiter({ windowMs: 60_000, maxRequests: 60 });
export const heartbeatRateLimitMiddleware = heartbeatLimiter.middleware;

