export interface RateLimitRule {
  windowMs: number;
  maxRequests: number;
}

export const RATE_LIMIT_RULES = {
  // Global limit applied across all endpoints if not overridden
  GLOBAL: {
    windowMs: 60 * 1000,
    maxRequests: 100,
  } as RateLimitRule,

  // Endpoint-specific rules
  TASKS: {
    windowMs: 60 * 1000,
    maxRequests: 30, // 30/min per wallet
  } as RateLimitRule,

  AGENTS_REGISTER: {
    windowMs: 60 * 60 * 1000, // 1 hour
    maxRequests: 10, // 10/hour per wallet
  } as RateLimitRule,

  PAYMENTS: {
    windowMs: 60 * 1000,
    maxRequests: 30, // 30/min per wallet/IP
  } as RateLimitRule,
};
