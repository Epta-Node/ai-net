/**
 * Prometheus metrics endpoint.
 *
 * Exposes `GET /metrics` in the Prometheus text exposition format so that
 * Prometheus (or any compatible scraper) can poll it directly.
 *
 * No authentication is required — this endpoint is intended for internal
 * network scraping only.
 */

import { Router, Request, Response } from 'express';
import { generatePrometheusMetrics } from '../../services/prometheus';

const router = Router();

/**
 * @openapi
 * /metrics:
 *   get:
 *     summary: Prometheus-format metrics
 *     description: >
 *       Returns all application metrics in the Prometheus text exposition
 *       format.  Includes HTTP traffic (request count, latency histogram,
 *       error rates), WebSocket connections, task pipeline counters, agent
 *       population, payment amounts, queue status, LLM latency, and process
 *       health gauges.
 *     tags: [Metrics]
 *     security: []
 *     responses:
 *       200:
 *         description: Prometheus text exposition
 *         content:
 *           text/plain:
 *             schema:
 *               type: string
 *             example: |
 *               # HELP ainet_up Whether the ai-net backend is running
 *               # TYPE ainet_up gauge
 *               ainet_up 1
 */
router.get('/', (_req: Request, res: Response) => {
  try {
    const body = generatePrometheusMetrics();
    res.setHeader('Content-Type', 'text/plain; version=0.0.4; charset=utf-8');
    res.send(body);
  } catch (error) {
    res.status(500).send('# Error generating metrics\n');
  }
});

export { router as metricsRouter };
export default router;
