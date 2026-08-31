import { LRUCache } from "lru-cache";
import type { Request, Response, NextFunction } from "express";
import { RateLimitError } from "../../errors";
import { RATE_LIMIT_RULES, type RateLimitRule } from "../rateLimitRules";
import { EventEmitter } from "events";
import { config } from "../../config";

export const rateLimitEvents = new EventEmitter();

export interface TokenBucketState {
  tokens: number;
  lastRefill: number;
}

export interface RateLimiter {
  consume(key: string, rule: RateLimitRule): Promise<{ allowed: boolean; remaining: number; resetTime: number }>;
  getStatus(key: string, rule: RateLimitRule): Promise<{ remaining: number; resetTime: number } | null>;
}

class InMemoryRateLimiter implements RateLimiter {
  private buckets = new LRUCache<string, TokenBucketState>({
    max: 10_000,
    ttl: 24 * 60 * 60 * 1000, // 24 hours max lifetime
  });

  async consume(key: string, rule: RateLimitRule): Promise<{ allowed: boolean; remaining: number; resetTime: number }> {
    const now = Date.now();
    let state = this.buckets.get(key);

    if (!state) {
      state = { tokens: rule.maxRequests, lastRefill: now };
    } else {
      const timePassed = now - state.lastRefill;
      const refillAmount = (timePassed / rule.windowMs) * rule.maxRequests;
      
      state.tokens = Math.min(rule.maxRequests, state.tokens + refillAmount);
      state.lastRefill = now;
    }

    if (state.tokens >= 1) {
      state.tokens -= 1;
      this.buckets.set(key, state);
      return { allowed: true, remaining: Math.floor(state.tokens), resetTime: now + rule.windowMs };
    }

    const timeUntilNextToken = (1 - state.tokens) * (rule.windowMs / rule.maxRequests);
    return { allowed: false, remaining: 0, resetTime: now + timeUntilNextToken };
  }

  async getStatus(key: string, rule: RateLimitRule): Promise<{ remaining: number; resetTime: number } | null> {
    const state = this.buckets.get(key);
    if (!state) return null;

    const now = Date.now();
    const timePassed = now - state.lastRefill;
    const refillAmount = (timePassed / rule.windowMs) * rule.maxRequests;
    const tokens = Math.min(rule.maxRequests, state.tokens + refillAmount);

    return { remaining: Math.floor(tokens), resetTime: now + rule.windowMs };
  }
}

class RedisRateLimiter implements RateLimiter {
  private client: any;
  
  constructor(redisUrl: string) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { Redis } = require("ioredis");
      this.client = new Redis(redisUrl, { lazyConnect: true });
    } catch {
      throw new Error("[rateLimit] CACHE_DRIVER=redis requires ioredis: run `npm install ioredis`");
    }
  }

  async getStatus(key: string, rule: RateLimitRule): Promise<{ remaining: number; resetTime: number } | null> {
    const state = await this.client.hmget(`ratelimit:${key}`, "tokens", "lastRefill");
    if (!state[0]) return null;

    const tokensState = Number(state[0]);
    const lastRefill = Number(state[1]);
    const now = Date.now();
    
    const timePassed = Math.max(0, now - lastRefill);
    const refillAmount = (timePassed / rule.windowMs) * rule.maxRequests;
    const tokens = Math.min(rule.maxRequests, tokensState + refillAmount);

    return { remaining: Math.floor(tokens), resetTime: now + rule.windowMs };
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

    const result = await this.client.eval(luaScript, 1, `ratelimit:${key}`, rule.maxRequests, rule.windowMs, now);
    const allowed = result[0] === 1;
    const tokens = Number(result[1]);
    
    if (allowed) {
      return { allowed, remaining: Math.floor(tokens), resetTime: now + rule.windowMs };
    }
    
    const timeUntilNextToken = (1 - tokens) * (rule.windowMs / rule.maxRequests);
    return { allowed, remaining: 0, resetTime: now + timeUntilNextToken };
  }
}

let limiterInstance: RateLimiter | null = null;

export function getRateLimiter(): RateLimiter {
  if (!limiterInstance) {
    if (config.CACHE_DRIVER === "redis") {
      limiterInstance = new RedisRateLimiter(config.REDIS_URL);
    } else {
      limiterInstance = new InMemoryRateLimiter();
    }
  }
  return limiterInstance;
}

export function createMiddleware(rule: RateLimitRule, keyPrefix: string = "global", useIpOnly: boolean = false) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const limiter = getRateLimiter();
      // Prefer walletPublicKey if present in headers, otherwise fallback to IP
      // If useIpOnly is true, strict IP limit (Global limit)
      const walletPublicKey = req.headers["walletpublickey"] as string | undefined;
      const id = useIpOnly ? (req.ip || "unknown") : (walletPublicKey || req.ip || "unknown");
      const key = `${keyPrefix}:${id}`;

      const { allowed, remaining, resetTime } = await limiter.consume(key, rule);

      const retryAfterSeconds = Math.ceil(Math.max(0, resetTime - Date.now()) / 1000);
      res.setHeader(`X-RateLimit-Limit-${keyPrefix}`, rule.maxRequests);
      res.setHeader(`X-RateLimit-Remaining-${keyPrefix}`, remaining);
      res.setHeader(`X-RateLimit-Reset-${keyPrefix}`, Math.ceil(resetTime / 1000));

      if (!allowed) {
        res.setHeader("Retry-After", String(retryAfterSeconds));
        rateLimitEvents.emit("RATE_LIMITED", { key, prefix: keyPrefix, rule });
        
        const correlationId = res.locals.correlationId as string | undefined;
        next(new RateLimitError("Too many requests", { remaining, resetTime }, correlationId));
        return;
      }

      next();
    } catch (err) {
      // Fail open on rate limiter cache errors to not break the API
      console.error("[rateLimit] Error executing rate limit:", err);
      next();
    }
  };
}

// Default instances
export const globalRateLimitMiddleware = createMiddleware(RATE_LIMIT_RULES.GLOBAL, "global", true);
export const rateLimitMiddleware = createMiddleware(RATE_LIMIT_RULES.TASKS, "tasks");
export const registerRateLimitMiddleware = createMiddleware(RATE_LIMIT_RULES.AGENTS_REGISTER, "agents:register");
export const heartbeatRateLimitMiddleware = createMiddleware(RATE_LIMIT_RULES.GLOBAL, "heartbeat");

