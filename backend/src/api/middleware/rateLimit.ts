import { LRUCache } from "lru-cache";
import type { Request, Response, NextFunction } from "express";

export interface RateLimitOptions {
  /** Rolling window in milliseconds. Default: 60 000 (1 minute). */
  windowMs?: number;
  /** Maximum number of requests allowed within the window. Default: 20. */
  maxRequests?: number;
  /**
   * Maximum number of distinct IPs tracked simultaneously per limiter instance.
   * When the limit is reached the least-recently-used IP is evicted on the
   * next accepted request. Defaults to 10 000 (issue #154).
   */
  maxEntries?: number;
}

interface Window {
  timestamps: number[];
}

export interface RateLimiter {
  middleware: (req: Request, res: Response, next: NextFunction) => void;
  /**
   * Fully clears tracked state. Kept for API compatibility and graceful
   * shutdown hooks.
   */
  stop: () => void;
  /**
   * Current number of tracked IPs. Exposed for tests and operational
   * debugging — not part of the rate-limiting contract.
   * @internal
   */
  size: () => number;
}

/**
 * Attach standard rate-limit headers to the response.
 *
 * Headers emitted on **every** response so clients can track their quota
 * without waiting for a 429:
 *  - `X-RateLimit-Limit`     — max requests allowed per window
 *  - `X-RateLimit-Remaining` — requests remaining in the current window
 *  - `X-RateLimit-Reset`     — Unix timestamp (seconds) when the window resets
 *
 * On 429 responses `Retry-After` is also set (seconds until reset).
 */
function setRateLimitHeaders(
  res: Response,
  limit: number,
  remaining: number,
  resetAtMs: number,
): void {
  const resetSec = Math.ceil(resetAtMs / 1000);
  res.setHeader("X-RateLimit-Limit", String(limit));
  res.setHeader("X-RateLimit-Remaining", String(Math.max(0, remaining)));
  res.setHeader("X-RateLimit-Reset", String(resetSec));
}

/**
 * Create a configurable in-memory sliding-window rate limiter.
 *
 * Backing store is `lru-cache`, which provides:
 *  - a hard cap on entry count (`maxEntries`) bounding memory under IP floods
 *    (issue #154); and
 *  - TTL-based eviction so quiet IPs drop out automatically.
 *
 * Standard rate-limit headers are emitted on every response so clients can
 * proactively back off rather than only learning about limits on 429.
 */
export function createRateLimiter(opts: RateLimitOptions = {}): RateLimiter {
  const windowMs = opts.windowMs ?? 60_000;
  const maxRequests = opts.maxRequests ?? 20;
  const maxEntries = opts.maxEntries ?? 10_000;

  const windows = new LRUCache<string, Window>({
    max: maxEntries,
    ttl: windowMs,
    // Don't refresh age on read: a 429 must not let stale IPs linger.
    updateAgeOnGet: false,
  });

  function middleware(req: Request, res: Response, next: NextFunction): void {
    // NOTE: req.ip depends on Express's `trust proxy` setting. Until trust
    // proxy is configured every untrusted request collapses to "unknown",
    // making this effectively a global cap.
    const ip = req.ip ?? "unknown";
    const now = Date.now();
    const cutoff = now - windowMs;

    let win = windows.get(ip) ?? { timestamps: [] };
    win.timestamps = win.timestamps.filter((t) => t > cutoff);

    const oldest = win.timestamps[0];
    const resetAtMs = oldest !== undefined ? oldest + windowMs : now + windowMs;
    const remaining = maxRequests - win.timestamps.length;

    if (win.timestamps.length >= maxRequests) {
      const retryAfter = Math.ceil((resetAtMs - now) / 1000);
      setRateLimitHeaders(res, maxRequests, 0, resetAtMs);
      res.setHeader("Retry-After", String(retryAfter));
      res
        .status(429)
        .json({ error: { message: "Too many requests", code: "RATE_LIMITED" } });
      return;
    }

    win.timestamps.push(now);
    windows.set(ip, win);

    // Emit headers on every allowed response so clients can track quota.
    setRateLimitHeaders(res, maxRequests, remaining - 1, resetAtMs);

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

// ── Route-group limiters ─────────────────────────────────────────────────────
//
// Three groups with distinct limits, all configurable via env vars:
//
//   public    — unauthenticated endpoints (/api/stats, /api/agents GET, /health)
//   authed    — authenticated task creation (/api/tasks)
//   admin     — admin-only endpoints (/api/admin/*)
//
// Limits are intentionally conservative; operators should tune via env.

function readEnvInt(key: string, fallback: number): number {
  const raw = process.env[key];
  if (!raw) return fallback;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function readEnvWindowMs(key: string, fallback: number): number {
  const raw = process.env[key];
  if (!raw) return fallback;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/**
 * Lazily-created group limiters.  Using factory functions so tests can reset
 * process.env before the limiter is instantiated.
 */
export function createPublicLimiter(): RateLimiter {
  return createRateLimiter({
    windowMs: readEnvWindowMs("RATE_LIMIT_PUBLIC_WINDOW_MS", 60_000),
    maxRequests: readEnvInt("RATE_LIMIT_PUBLIC_MAX_REQUESTS", 120),
  });
}

export function createAuthedLimiter(): RateLimiter {
  return createRateLimiter({
    windowMs: readEnvWindowMs("RATE_LIMIT_AUTHED_WINDOW_MS", 60_000),
    maxRequests: readEnvInt("RATE_LIMIT_AUTHED_MAX_REQUESTS", 30),
  });
}

export function createAdminLimiter(): RateLimiter {
  return createRateLimiter({
    windowMs: readEnvWindowMs("RATE_LIMIT_ADMIN_WINDOW_MS", 60_000),
    maxRequests: readEnvInt("RATE_LIMIT_ADMIN_MAX_REQUESTS", 20),
  });
}

// ── Module-level singleton instances ─────────────────────────────────────────

/** Public routes: generous limit for read-heavy unauthenticated traffic. */
export const publicLimiter = createPublicLimiter();

/** Authenticated routes: tighter limit for task creation. */
export const authedLimiter = createAuthedLimiter();

/** Admin routes: conservative limit for privileged operations. */
export const adminLimiter = createAdminLimiter();

// ── Legacy named exports (kept for backward compatibility) ───────────────────

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
