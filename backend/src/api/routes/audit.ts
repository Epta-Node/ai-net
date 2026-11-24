/**
 * Audit routes — Issue #1004
 *
 * GET /api/admin/audit/verify — verifies the SHA-256 hash chain is intact.
 * Requires admin JWT (checked via authMiddleware).
 */
import { Router, Request, Response } from "express";
import { getAuditLogger } from "../../utils/auditLogger";
import { authMiddleware } from "../middleware/auth";

export const auditRouter = Router();

/**
 * @openapi
 * /api/admin/audit/verify:
 *   get:
 *     summary: Verify the tamper-evident audit log hash chain
 *     tags: [Admin, Audit]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Chain is intact
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 valid:
 *                   type: boolean
 *       409:
 *         description: Chain is broken — tamper detected
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 valid:
 *                   type: boolean
 *                 firstBreak:
 *                   type: integer
 */
auditRouter.get("/verify", authMiddleware, (_req: Request, res: Response) => {
  const result = getAuditLogger().verifyChain();
  const statusCode = result.valid ? 200 : 409;
  res.status(statusCode).json(result);
});
