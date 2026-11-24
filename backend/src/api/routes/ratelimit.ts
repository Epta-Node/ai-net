import { Router, Request, Response, NextFunction } from "express";
import { getRateLimiter } from "../middleware/rateLimit";
import { adminAuthMiddleware } from "../middleware/auth";
import { RATE_LIMIT_RULES } from "../rateLimitRules";
import { ValidationError, NotFoundError, AppError } from "../../errors";

export function createRateLimitRouter(): Router {
  const router = Router();

  // Exposes per-key token bucket state, so it fails closed behind the same
  // admin credential as every other operational endpoint.
  router.use(adminAuthMiddleware);

  /**
   * @openapi
   * /api/ratelimit/status:
   *   get:
   *     summary: Get rate limit status for a key
   *     description: Admin endpoint to view current token bucket usage for a given key and endpoint prefix.
   *     tags: [Admin, RateLimit]
   *     security:
   *       - adminApiKey: []
   *     parameters:
   *       - in: query
   *         name: key
   *         required: true
   *         schema: { type: string }
   *         description: The rate limit key (e.g. "tasks:wallet_abc123" or "global:127.0.0.1")
   *       - in: query
   *         name: rule
   *         schema: { type: string, enum: ["GLOBAL", "TASKS", "AGENTS_REGISTER", "PAYMENTS"] }
   *         default: "GLOBAL"
   *     responses:
   *       200:
   *         description: Rate limit status
   *       400:
   *         description: Missing key parameter
   *       404:
   *         description: Key not found in rate limiter cache
   */
  router.get("/status", async (req: Request, res: Response, next: NextFunction) => {
    try {
      const key = req.query.key as string;
      const ruleName = (req.query.rule as keyof typeof RATE_LIMIT_RULES) || "GLOBAL";
      const correlationId = res.locals.correlationId as string | undefined;

      if (!key) {
        throw new ValidationError("Missing 'key' query parameter", undefined, correlationId);
      }

      const rule = RATE_LIMIT_RULES[ruleName];
      if (!rule) {
        throw new ValidationError(`Invalid rule name: ${ruleName}`, { rule: ruleName }, correlationId);
      }

      const limiter = getRateLimiter();
      const status = await limiter.getStatus(key, rule);

      if (!status) {
        throw new NotFoundError("Rate limit key", key, undefined, correlationId);
      }

      res.json({
        key,
        rule: ruleName,
        limit: rule.maxRequests,
        remaining: status.remaining,
        resetTime: new Date(status.resetTime).toISOString(),
        resetTimeMs: status.resetTime,
      });
    } catch (err) {
      next(err instanceof AppError ? err : new AppError("Failed to get rate limit status", 500, "INTERNAL_ERROR"));
    }
  });

  return router;
}
