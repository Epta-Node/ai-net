import type { Request, Response, NextFunction } from "express";

export interface RateLimitOptions {
  /** Rolling window in milliseconds. Default: 60 000 (1 minute). */
  windowMs?: number;
  /** Maximum number of requests allowed within the window. Default: 20. */
  maxRequests?: number;
}

interface Window {
  timestamps: number[];
}

/**
 * Create a configurable in-memory sliding-window rate limiter.
 *
 * Improvements over the original implementation:
 *  - Accepts `windowMs` / `maxRequests` options so callers can tune limits
 *    per-route (e.g. stricter limits for agent registration).
 *  - Runs a background eviction interval that removes stale entries so the
 *    internal `windows` Map does not grow without bound when many unique IPs
 *    visit (fixes the memory-leak identified in issue #181).
 *  - The eviction interval is returned via `stop()` so tests and the server
 *    shutdown path can clear it cleanly.
 */
export function createRateLimiter(opts: RateLimitOptions = {}): {
  middleware: (req: Request, res: Response, next: NextFunction) => void;
  stop: () => void;
} {
  const windowMs = opts.windowMs ?? 60_000;
  const maxRequests = opts.maxRequests ?? 20;

  const windows = new Map<string, Window>();

  // Evict entries whose entire timestamp window has expired.
  // Running every minute keeps memory bounded for long-lived processes.
  const evictionInterval = setInterval(() => {
    const cutoff = Date.now() - windowMs;
    for (const [ip, win] of windows) {
      win.timestamps = win.timestamps.filter((t) => t > cutoff);
      if (win.timestamps.length === 0) {
        windows.delete(ip);
      }
    }
  }, 60_000);

  // Allow the Node.js process to exit even if the interval is still active
  // (important for test environments and long-running servers that call stop()).
  if (evictionInterval.unref) evictionInterval.unref();

  function middleware(req: Request, res: Response, next: NextFunction): void {
    const ip = req.ip ?? "unknown";
    const now = Date.now();
    const cutoff = now - windowMs;

    let win = windows.get(ip);
    if (!win) {
      win = { timestamps: [] };
      windows.set(ip, win);
    }

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
    next();
  }

  function stop(): void {
    clearInterval(evictionInterval);
  }

  return { middleware, stop };
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
