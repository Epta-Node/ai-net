import { Router } from 'express';
import { z } from 'zod';
import {
  ReconciliationService,
  createDefaultReconciliationService,
} from '../../services/reconciliation';
import type { ReconciliationTrigger } from '../../services/reconciliation.types';
import { adminAuthMiddleware } from '../middleware/auth';
import { createLogger } from '../../utils/logger';
import { NotFoundError, AppError, ValidationError } from '../../errors';

export interface ReconciliationRouterOptions {
  /** Service to use; defaults to the production service. */
  service?: ReconciliationService;
}

const runSchema = z.object({
  triggeredBy: z.enum(['manual', 'scheduled', 'release']).default('manual'),
});

const resolveSchema = z.object({
  status: z.enum(['released', 'refunded', 'orphaned']),
  txHash: z.string().min(1).max(256),
  by: z.string().min(1).max(128).default('operator'),
});

/**
 * Admin-only payment reconciliation API (issue #496).
 *
 * Every route sits behind `adminAuthMiddleware`, which fails closed: without
 * `ADMIN_API_KEY` configured the whole router answers `503`.
 *
 * @openapi
 * /api/reconciliation/run:
 *   post:
 *     summary: Run a payment reconciliation pass and remediate drift
 *     description: |
 *       Cross-references every local payment record against the on-chain claimable
 *       balances, classifies any divergence into a `driftType`, applies the
 *       remediation that is unambiguous, and parks the rest for manual review.
 *
 *       Drift scenarios covered:
 *         1. DB `locked` with no on-chain claimable balance -> `orphaned_locked`
 *         2. DB `released` with no release transaction in Horizon -> `missing_release_tx`
 *         3. DB `released` while the balance is still claimable -> `release_unconfirmed`
 *         4. Task terminal while the escrow is still locked -> `expired_escrow`
 *
 *       Remediation is idempotent: re-running never double-refunds or double-releases.
 *     operationId: runReconciliation
 *     tags: [Reconciliation]
 *     security:
 *       - adminApiKey: []
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
 *       400:
 *         description: Invalid request body
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/ValidationError' }
 *       401:
 *         description: Missing or invalid admin credentials
 *       500:
 *         description: Reconciliation run failed
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 * /api/reconciliation/report:
 *   get:
 *     summary: Get the latest reconciliation report
 *     operationId: getLatestReconciliationReport
 *     tags: [Reconciliation]
 *     security:
 *       - adminApiKey: []
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
 *               $ref: '#/components/schemas/ErrorResponse'
 * /api/reconciliation/drift:
 *   get:
 *     summary: List payment drifts awaiting manual review
 *     description: |
 *       Drifts the service could not remediate automatically. Records persist across
 *       restarts and are pruned automatically once they stop reproducing.
 *     operationId: listReconciliationDrift
 *     tags: [Reconciliation]
 *     parameters:
 *       - in: query
 *         name: includeAcknowledged
 *         schema: { type: boolean, default: false }
 *     responses:
 *       200:
 *         description: Pending drift records
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 drift:
 *                   type: array
 *                   items: { $ref: '#/components/schemas/ReconciliationDrift' }
 * /api/reconciliation/drift/{id}/resolve:
 *   post:
 *     summary: Mark a pending drift as resolved and patch the payment record
 *     operationId: resolveReconciliationDrift
 *     tags: [Reconciliation]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *         description: Drift id, `<taskId>:<nodeId>` when known, else the balance id.
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [status, txHash]
 *             properties:
 *               status: { type: string, enum: [released, refunded, orphaned] }
 *               txHash: { type: string }
 *               by: { type: string, default: operator }
 *     responses:
 *       200:
 *         description: The resolved drift record
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/ReconciliationDrift' }
 *       400:
 *         description: Invalid request body
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/ValidationError' }
 *       404:
 *         description: No pending drift with that id
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/ErrorResponse' }
 * /api/reconciliation/metrics:
 *   get:
 *     summary: Drift and remediation counters, plus Prometheus text format
 *     description: |
 *       Exposes the `reconcile.driftDetected` / `reconcile.remediated` counters from the
 *       issue, broken down by drift type, alongside a Prometheus rendering of the same
 *       values. The gap between `driftDetected` and `remediated` is the operational
 *       signal: a growing gap means drift is being detected but not acted upon.
 *     operationId: getReconciliationMetrics
 *     tags: [Reconciliation]
 *     responses:
 *       200:
 *         description: Reconciliation counters
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 driftDetected: { type: object, additionalProperties: { type: integer } }
 *                 remediated: { type: object, additionalProperties: { type: integer } }
 *                 remediationFailed: { type: object, additionalProperties: { type: integer } }
 *                 runs: { type: integer }
 *                 runsWithDrift: { type: integer }
 *                 runsWithRemediation: { type: integer }
 *                 prometheus:
 *                   type: string
 *                   description: The same counters in Prometheus text exposition format.
 */
export function createReconciliationRouter(
  options: ReconciliationRouterOptions = {}
): Router {
  const router = Router();
  const logger = createLogger({ module: "reconciliation" });

  router.use(adminAuthMiddleware);

  let service: ReconciliationService | null = null;
  const getService = (): ReconciliationService =>
    (service ??= options.service ?? createDefaultReconciliationService());

  router.post('/run', async (req, res, next) => {
    try {
      const parsed = runSchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        next(new ValidationError(
          'Invalid request body',
          { issues: parsed.error.flatten() },
          res.locals.correlationId as string | undefined,
        ));
        return;
      }
      const triggeredBy = parsed.data.triggeredBy as ReconciliationTrigger;

      const report = await getService().run(triggeredBy);
      return res.status(200).json(report);
    } catch (error) {
      logger.error({ err: error }, "reconciliation run failed");
      next(new AppError('Reconciliation run failed', 500, 'INTERNAL_ERROR'));
    }
  });

  router.get('/report', (_req, res, next) => {
    const report = getService().getLatestReport();
    if (!report) {
      next(new NotFoundError('Reconciliation Report'));
      return;
    }
    return res.status(200).json(report);
  });

  router.get('/drift', (req, res) => {
    const includeAcknowledged = req.query?.includeAcknowledged === 'true';
    return res.status(200).json({ drift: getService().listPendingDrift(includeAcknowledged) });
  });

  router.post('/drift/:id/resolve', (req, res, next) => {
    const parsed = resolveSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      next(new ValidationError(
        'Invalid request body',
        { issues: parsed.error.flatten() },
        res.locals.correlationId as string | undefined,
      ));
      return;
    }
    const id = String(req.params.id ?? '');
    const resolved = getService().resolvePendingDrift(
      id,
      parsed.data.status,
      parsed.data.txHash,
      parsed.data.by,
    );
    if (!resolved) {
      next(new NotFoundError('Reconciliation Drift', id));
      return;
    }
    return res.status(200).json(resolved);
  });

  router.get('/metrics', (_req, res) => {
    const metrics = getService().getMetrics();
    return res.status(200).json({
      ...metrics.snapshot(),
      prometheus: metrics.toPrometheus(),
    });
  });

  return router;
}
