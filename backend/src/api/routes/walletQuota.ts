/**
 * Wallet quota routes.
 *
 *   GET  /api/wallet/:publicKey/quota      — returns remaining quotas
 *   POST /api/admin/quota/reset/:publicKey — admin: reset daily quota
 *
 * Issue #999
 */

import { Router, Request, Response } from "express";
import {
  getWalletQuota,
  resetWalletDailyQuota,
} from "../middleware/walletRateLimit";

export const walletQuotaRouter = Router();

/**
 * @openapi
 * /api/wallet/{publicKey}/quota:
 *   get:
 *     summary: Get remaining rate-limit quota for a wallet
 *     tags: [Wallet]
 *     parameters:
 *       - in: path
 *         name: publicKey
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Quota information
 */
walletQuotaRouter.get("/:publicKey/quota", (req: Request, res: Response) => {
  const { publicKey } = req.params;
  const quota = getWalletQuota(publicKey);
  res.json(quota);
});

// ── Admin quota reset router ─────────────────────────────────────────────────

export const adminQuotaRouter = Router();

/**
 * @openapi
 * /api/admin/quota/reset/{publicKey}:
 *   post:
 *     summary: Reset a wallet's daily task quota (admin only)
 *     tags: [Admin]
 *     security:
 *       - AdminJWT: []
 *     parameters:
 *       - in: path
 *         name: publicKey
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Quota reset successfully
 *       401:
 *         description: Unauthorized
 */
adminQuotaRouter.post(
  "/quota/reset/:publicKey",
  (req: Request, res: Response) => {
    const { publicKey } = req.params;
    resetWalletDailyQuota(publicKey);
    res.json({ success: true, wallet: publicKey, message: "Daily quota reset" });
  },
);
