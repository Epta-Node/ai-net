import { Router } from 'express';
import { getStats, type DbClient } from '../../db/stats';
import { StatsCache } from '../../utils/statsCache';
import { createLogger } from '../../utils/logger';

export function createStatsRouter(db: DbClient) {
  const router = Router();
  const logger = createLogger({ module: 'stats' });
  const cache = new StatsCache({
    ttlMs: 60_000,
    computeStats: () => getStats(db)
  });

  /**
   * @openapi
   * /api/stats:
   *   get:
   *     summary: Get network statistics and analytics
   *     description: Returns aggregated network performance metrics including total registered agents, completed tasks, system uptime percentage, XLM transacted, and 24-hour activity time series.
   *     operationId: getStats
   *     tags: [Stats]
   *     security: []
   *     responses:
   *       200:
   *         description: Current network statistics retrieved successfully
   *         headers:
   *           X-RateLimit-Limit:
   *             $ref: '#/components/headers/X-RateLimit-Limit'
   *           X-RateLimit-Remaining:
   *             $ref: '#/components/headers/X-RateLimit-Remaining'
   *           X-RateLimit-Reset:
   *             $ref: '#/components/headers/X-RateLimit-Reset'
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/StatsResponse'
   *             example:
   *               totalAgents: 12
   *               totalTasks: 348
   *               uptimePercent: 99.98
   *               totalXLMTransacted: 1250.75
   *               tasksLast24h:
   *                 - timestamp: "2026-08-25T12:00:00.000Z"
   *                   value: 45
   *               xlmLast24h:
   *                 - timestamp: "2026-08-25T12:00:00.000Z"
   *                   value: 120.5
   *       500:
   *         description: Unable to load stats
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/InternalServerError'
   */
  router.get('/', async (req, res) => {
    try {
      const stats = await cache.get();
      return res.status(200).json(stats);
    } catch (error) {
      logger.error({ err: error }, "failed to load stats");
      return res.status(500).json({ error: 'Unable to load stats' });
    }
  });

  return router;
}
