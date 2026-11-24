/**
 * GET /api/admin/audit — returns last 100 audit log entries.
 * Requires admin JWT (enforced by adminAuthMiddleware upstream).
 *
 * Issue #1001
 */

import { Router, Request, Response } from "express";
import { getAuthDb } from "./adminAuth";

export const adminAuditRouter = Router();

/**
 * @openapi
 * /api/admin/audit:
 *   get:
 *     summary: List last 100 admin audit log entries
 *     tags: [Admin]
 *     security:
 *       - AdminJWT: []
 *     responses:
 *       200:
 *         description: Audit log entries
 *       401:
 *         description: Unauthorized
 */
adminAuditRouter.get("/", (_req: Request, res: Response) => {
  const db = getAuthDb();
  const rows = db
    .prepare(
      "SELECT id, action, public_key, ip, detail, created_at FROM admin_audit_log ORDER BY id DESC LIMIT 100",
    )
    .all();
  res.json({ entries: rows, count: rows.length });
});
