import { Router, Request, Response } from "express";
import { getRateLimiter } from "../middleware/rateLimit";
import { RATE_LIMIT_RULES } from "../rateLimitRules";

export function createRateLimitRouter(): Router {
  const router = Router();

  /**
   * @openapi
   * /api/ratelimit/status:
   *   get:
   *     summary: Get rate limit status for a key
   *     description: Admin endpoint to view current token bucket usage for a given key and endpoint prefix.
   *     tags: [Admin, RateLimit]
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
  router.get("/status", async (req: Request, res: Response) => {
    const key = req.query.key as string;
    const ruleName = (req.query.rule as keyof typeof RATE_LIMIT_RULES) || "GLOBAL";

    if (!key) {
      res.status(400).json({ error: { code: "VALIDATION_ERROR", message: "Missing 'key' query parameter" } });
      return;
    }

    const rule = RATE_LIMIT_RULES[ruleName];
    if (!rule) {
      res.status(400).json({ error: { code: "VALIDATION_ERROR", message: `Invalid rule name: ${ruleName}` } });
      return;
    }

    try {
      const limiter = getRateLimiter();
      const status = await limiter.getStatus(key, rule);

      if (!status) {
        res.status(404).json({ error: { code: "NOT_FOUND", message: `Key '${key}' not found in rate limiter cache` } });
        return;
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
      res.status(500).json({ error: { code: "INTERNAL_ERROR", message: "Failed to get rate limit status" } });
    }
  });

  return router;
}
