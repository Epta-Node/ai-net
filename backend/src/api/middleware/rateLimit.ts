import { LRUCache } from "lru-cache";
import type { Request, Response, NextFunction } from "express";
import { getConfig } from "../../config";
import { createLogger } from "../../utils/logger";
import type { RateLimitRule } from "../rateLimitRules";
import { RateLimitError } from "../../errors/RateLimitError";

const logger = createLogger({ module: "rateLimit" });

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

export interface TokenBucketState {
  tokens: number;
  lastRefill: number;
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

export { RateLimitRule };

interface Window {
  timestamps: number[];
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
 *
 * Several limiters can apply to one request (the app-wide limiter plus a
 * route-group limiter). Unless `force` is set, headers already written by an
 * earlier limiter are kept when they advertise fewer remaining requests, so
 * clients always see the most restrictive budget that applies to them.
 */
function setRateLimitHeaders(
  res: Response,
  limit: number,
  remaining: number,
  resetAtMs: number,
  force = false,
): void {
  const existing = Number(res.getHeader("X-RateLimit-Remaining"));
  if (!force && Number.isFinite(existing) && existing < Math.max(0, remaining)) {
    return;
  }
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
    updateAgeOnGet: false,
  });

  function middleware(req: Request, res: Response, next: NextFunction): void {
    const ip = req.ip ?? "unknown";
    const now = Date.now();
    const cutoff = now - windowMs;

    const win = windows.get(ip) ?? { timestamps: [] };
    win.timestamps = win.timestamps.filter((t) => t > cutoff);

    const oldest = win.timestamps[0];
    const resetAtMs = oldest !== undefined ? oldest + windowMs : now + windowMs;
    const remaining = maxRequests - win.timestamps.length;

    if (win.timestamps.length >= maxRequests) {
      const retryAfter = Math.ceil((resetAtMs - now) / 1000);
      setRateLimitHeaders(res, maxRequests, 0, resetAtMs, true);
      res.setHeader("Retry-After", String(retryAfter));
      res
        .status(429)
        .json({ error: { message: "Too many requests", code: "RATE_LIMITED" } });
      return;
    }

    win.timestamps.push(now);
    windows.set(ip, win);

    setRateLimitHeaders(res, maxRequests, remaining - 1, resetAtMs);
    next();
  }

  return {
    middleware,
    stop: () => windows.clear(),
    size: () => windows.size,
  };
}

// ── Redis-backed rate limiter ────────────────────────────────────────────────

/**
 * Redis-backed token-bucket rate limiter. Uses an atomic Lua script for
 * consume() so the check-and-decrement is a single round-trip. Falls back
 * to a conservative in-memory limiter on Redis errors (fail closed).
 */
export class RedisRateLimiter {
  private client: any; // ioredis instance
  private fallback: RateLimiter;

  constructor(redisUrl: string) {
    // Lazy-require ioredis so the module doesn't break when Redis is not used
    // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires
    const Redis = require("ioredis");
    this.client = new Redis(redisUrl);
    this.fallback = createRateLimiter({ maxRequests: 5, windowMs: 60_000 });
  }

  async getStatus(key: string, rule: RateLimitRule): Promise<{ remaining: number; resetTime: number } | null> {
    try {
      const state = await this.client.hmget(`ratelimit:${key}`, "tokens", "lastRefill");
      if (!state[0]) return null;

      const tokensState = Number(state[0]);
      const lastRefill = Number(state[1]);
      const now = Date.now();

      const timePassed = Math.max(0, now - lastRefill);
      const refillAmount = (timePassed / rule.windowMs) * rule.maxRequests;
      const tokens = Math.min(rule.maxRequests, tokensState + refillAmount);

      return { remaining: Math.floor(tokens), resetTime: now + rule.windowMs };
    } catch (err) {
      logger.error({ err }, "redis rate limiter getStatus failed");
      return null;
    }
  }

  async consume(key: string, rule: RateLimitRule): Promise<{ allowed: boolean; remaining: number; resetTime: number }> {
    const now = Date.now();
    const luaScript = `
      local key = KEYS[1]
      local maxRequests = tonumber(ARGV[1])
      local windowMs = tonumber(ARGV[2])
      local now = tonumber(ARGV[3])

      local state = redis.call("HMGET", key, "tokens", "lastRefill")
      local tokens = tonumber(state[1])
      local lastRefill = tonumber(state[2])

      if tokens == nil then
        tokens = maxRequests
        lastRefill = now
      else
        local timePassed = math.max(0, now - lastRefill)
        local refillAmount = (timePassed / windowMs) * maxRequests
        tokens = math.min(maxRequests, tokens + refillAmount)
        lastRefill = now
      end

      local allowed = false
      if tokens >= 1 then
        tokens = tokens - 1
        allowed = true
      end

      redis.call("HMSET", key, "tokens", tokens, "lastRefill", lastRefill)
      redis.call("PEXPIRE", key, windowMs)

      return { allowed and 1 or 0, tokens }
    `;

    try {
      const result = await this.client.eval(luaScript, 1, `ratelimit:${key}`, rule.maxRequests, rule.windowMs, now);
      const allowed = result[0] === 1;
      const tokens = Number(result[1]);

      if (allowed) {
        return { allowed, remaining: Math.floor(tokens), resetTime: now + rule.windowMs };
      }

      const timeUntilNextToken = (1 - tokens) * (rule.windowMs / rule.maxRequests);
      return { allowed, remaining: 0, resetTime: now + timeUntilNextToken };
    } catch (err) {
      logger.error({ err }, "redis rate limiter consume failed, failing closed");
      return { allowed: false, remaining: 0, resetTime: now + rule.windowMs };
    }
  }

  stop(): void {
    this.client?.disconnect();
  }
}

// ── Singleton limiter for Redis/in-memory switching ──────────────────────────

let limiterInstance: RedisRateLimiter | null = null;

export function getRateLimiter(): RedisRateLimiter {
  if (!limiterInstance) {
    const config = getConfig();
    if (config.CACHE_DRIVER === "redis") {
      limiterInstance = new RedisRateLimiter(config.REDIS_URL);
    } else {
      // In-memory fallback that implements the same interface
      const mem = createRateLimiter({ maxRequests: 20, windowMs: 60_000 });
      limiterInstance = {
        async getStatus() { return null; },
        async consume(_key: string, rule: RateLimitRule) {
          return { allowed: true, remaining: rule.maxRequests, resetTime: Date.now() + rule.windowMs };
        },
        stop() { mem.stop(); },
      } as unknown as RedisRateLimiter;
    }
  }
  return limiterInstance;
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

/**
 * Lazily-created group limiters. Using factory functions so tests can reset
 * config before the limiter is instantiated.
 */
export function createPublicLimiter(): RateLimiter {
  const cfg = getConfig();
  return createRateLimiter({
    windowMs: cfg.RATE_LIMIT_PUBLIC_WINDOW_MS,
    maxRequests: cfg.RATE_LIMIT_PUBLIC_MAX_REQUESTS,
  });
}

export function createAuthedLimiter(): RateLimiter {
  const cfg = getConfig();
  return createRateLimiter({
    windowMs: cfg.RATE_LIMIT_AUTHED_WINDOW_MS,
    maxRequests: cfg.RATE_LIMIT_AUTHED_MAX_REQUESTS,
  });
}

export function createAdminLimiter(): RateLimiter {
  const cfg = getConfig();
  return createRateLimiter({
    windowMs: cfg.RATE_LIMIT_ADMIN_WINDOW_MS,
    maxRequests: cfg.RATE_LIMIT_ADMIN_MAX_REQUESTS,
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
let defaultLimiter: RateLimiter | null = null;

function getDefaultLimiter(): RateLimiter {
  if (!defaultLimiter) {
    const config = getConfig();
    defaultLimiter = createRateLimiter({
      windowMs: config.RATE_LIMIT_WINDOW_MS,
      maxRequests: config.RATE_LIMIT_MAX_REQUESTS,
    });
  }
  return defaultLimiter;
}

export const rateLimitMiddleware = (
  req: Request,
  res: Response,
  next: NextFunction,
): void => getDefaultLimiter().middleware(req, res, next);

/**
 * Stricter rate limiter used by POST /api/agents/register.
 * 10 requests per minute per IP — registration is an expensive operation.
 */
let registerLimiter: RateLimiter | null = null;

function getRegisterLimiter(): RateLimiter {
  if (!registerLimiter) {
    const config = getConfig();
    registerLimiter = createRateLimiter({
      windowMs: config.RATE_LIMIT_WINDOW_MS,
      maxRequests: config.REGISTER_RATE_LIMIT_MAX_REQUESTS,
    });
  }
  return registerLimiter;
}

export const registerRateLimitMiddleware = (
  req: Request,
  res: Response,
  next: NextFunction,
): void => getRegisterLimiter().middleware(req, res, next);

/**
 * Rate limiter used by POST /api/agents/:id/heartbeat.
 * 60 requests per minute per IP to allow periodic agent pings while preventing abuse.
 */
const heartbeatLimiter = createRateLimiter({ windowMs: 60_000, maxRequests: 60 });
export const heartbeatRateLimitMiddleware = heartbeatLimiter.middleware;

/**
 * Rate limiter for POST /api/agents/challenge.
 * 30 requests per minute per IP — each call mints fresh entropy and stores an
 * entry, so it is deliberately tighter than the generic public limiter.
 */
const agentChallengeLimiter = createRateLimiter({ windowMs: 60_000, maxRequests: 30 });
export const agentChallengeRateLimitMiddleware = agentChallengeLimiter.middleware;

// ── Ownership-proof failure limiter (#558) ────────────────────────────────────
//
// Register / heartbeat / delete share a success-path limiter, so a caller who
// simply omits the signature would otherwise be able to probe for agent
// existence at that rate. This counter is incremented *only* when an ownership
// proof fails, which keeps a well-behaved agent off the limit while making
// guessing expensive.

interface FailureWindow {
  timestamps: number[];
}

const failureWindows = new LRUCache<string, FailureWindow>({
  max: 10_000,
  ttl: 60_000,
  updateAgeOnGet: false,
});

/** Record a failed ownership proof against `identifier` (normally the client IP). */
export function recordAuthFailure(identifier: string): void {
  const win = failureWindows.get(identifier) ?? { timestamps: [] };
  win.timestamps.push(Date.now());
  failureWindows.set(identifier, win);
}

/** Current failed-proof count for `identifier`. Exposed for tests. */
export function authFailureCount(identifier: string): number {
  return failureWindows.get(identifier)?.timestamps.length ?? 0;
}

/** Drop all recorded failures. Test-only escape hatch. */
export function resetAuthFailures(): void {
  failureWindows.clear();
}

/**
 * Guard the agent ownership-proof failure path (#558).
 *
 * Unlike {@link createRateLimiter} this only counts *unsigned* requests:
 * successful requests pass through untouched, and a request that does present
 * `x-signature` is always let through, because it has already paid for a real
 * Ed25519 verification and is therefore not a cheap probe. Without that carve
 * out, one attacker exhausting the budget could lock every correctly-signing
 * agent behind the same NAT egress IP out of its own heartbeat.
 */
export function agentAuthFailureGuard(req: Request, res: Response, next: NextFunction): void {
  const presented = req.headers["x-signature"];
  if (presented && (Array.isArray(presented) ? presented[0] : presented)) {
    next();
    return;
  }

  const ip = req.ip ?? "unknown";
  // Both limits are part of the validated config, which is itself built from
  // the environment (AGENT_AUTH_FAILURE_LIMIT_*), so there is no raw env read
  // to do here.
  const config = getConfig();
  const windowMs = config.AGENT_AUTH_FAILURE_LIMIT_WINDOW_MS;
  const maxFailures = config.AGENT_AUTH_FAILURE_LIMIT_MAX;

  const cutoff = Date.now() - windowMs;
  const timestamps = (failureWindows.get(ip)?.timestamps ?? []).filter((t) => t > cutoff);
  failureWindows.set(ip, { timestamps });

  if (timestamps.length < maxFailures) {
    next();
    return;
  }

  // The budget frees up as soon as the oldest recorded failure ages out.
  const now = Date.now();
  const resetAtMs = (timestamps[0] ?? now) + windowMs;
  const retryAfter = Math.max(1, Math.ceil((resetAtMs - now) / 1000));
  setRateLimitHeaders(res, maxFailures, 0, resetAtMs, true);
  res.setHeader("Retry-After", String(retryAfter));
  res.status(429).json({
    error: {
      message: "Too many failed agent authentication attempts",
      code: "RATE_LIMITED",
    },
  });
}
