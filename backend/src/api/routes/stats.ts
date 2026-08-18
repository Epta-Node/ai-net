import { Router } from 'express';
import { getStats, type DbClient } from '../../db/stats';
import { StatsCache } from '../../utils/statsCache';

export function createStatsRouter(db: DbClient) {
  const router = Router();
  const cache = new StatsCache({
    ttlMs: 60_000,
    computeStats: () => getStats(db)
  });

  /**
   * @openapi
   * /api/stats:
   *   get:
   *     summary: Get network statistics
   *     operationId: getStats
   *     tags: [Stats]
   *     security: []
   *     responses:
   *       200:
   *         description: Current network statistics
   *         content:
   *           application/json:
   *             schema:
   *               type: object
   *               properties:
   *                 totalAgents: { type: integer }
   *                 totalTasks: { type: integer }
   *                 uptimePercent: { type: number }
   *                 totalXLMTransacted: { type: number }
   *                 tasksLast24h:
   *                   type: array
   *                   items:
   *                     type: object
   *                     properties:
   *                       timestamp: { type: string, format: date-time }
   *                       value: { type: number }
   *                 xlmLast24h:
   *                   type: array
   *                   items:
   *                     type: object
   *                     properties:
   *                       timestamp: { type: string, format: date-time }
   *                       value: { type: number }
   *       500:
   *         description: Unable to load stats
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/Error'
   */
  router.get('/', async (req, res) => {
    try {
      const stats = await cache.get();
      return res.status(200).json(stats);
    } catch (error) {
      console.error('Failed to load stats', error);
      return res.status(500).json({ error: 'Unable to load stats' });
    }
  });

  return router;
}
