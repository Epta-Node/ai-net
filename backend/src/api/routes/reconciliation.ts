import { Router } from 'express';
import {
  ReconciliationService,
  createDefaultReconciliationService,
} from '../../services/reconciliation';
import type { ReconciliationTrigger } from '../../services/reconciliation.types';
import { createLogger } from '../../utils/logger';

export interface ReconciliationRouterOptions {
  /** Service to use; defaults to the production service. */
  service?: ReconciliationService;
}

/**
 * @openapi
 * /api/reconciliation/run:
 *   post:
 *     summary: Trigger a payment reconciliation check
 *     operationId: runReconciliation
 *     tags: [Reconciliation]
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               triggeredBy:
 *                 type: string
 *                 enum: [manual, scheduled, release]
 *                 default: manual
 *     responses:
 *       200:
 *         description: Reconciliation report for this run
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ReconciliationReport'
 *       500:
 *         description: Reconciliation run failed
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 * /api/reconciliation/report:
 *   get:
 *     summary: Get the latest reconciliation report
 *     operationId: getLatestReconciliationReport
 *     tags: [Reconciliation]
 *     responses:
 *       200:
 *         description: Latest reconciliation report
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ReconciliationReport'
 *       404:
 *         description: No reconciliation report has been generated yet
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */
export function createReconciliationRouter(
  options: ReconciliationRouterOptions = {}
): Router {
  const router = Router();
  const logger = createLogger({ module: "reconciliation" });
  let service: ReconciliationService | null = null;
  const getService = (): ReconciliationService =>
    (service ??= options.service ?? createDefaultReconciliationService());

  router.post('/run', async (req, res) => {
    try {
      const requested = req.body?.triggeredBy as string | undefined;
      const triggeredBy: ReconciliationTrigger =
        requested === 'scheduled' || requested === 'release' ? requested : 'manual';

      const report = await getService().run(triggeredBy);
      return res.status(200).json(report);
    } catch (error) {
      logger.error({ err: error }, "reconciliation run failed");
      return res.status(500).json({ error: 'RECONCILIATION_FAILED' });
    }
  });

  router.get('/report', (_req, res) => {
    const report = getService().getLatestReport();
    if (!report) {
      return res.status(404).json({ error: 'NO_RECONCILIATION_REPORT' });
    }
    return res.status(200).json(report);
  });

  return router;
}