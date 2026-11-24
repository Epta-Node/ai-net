/**
 * AdminAuthMiddleware — validates the short-lived JWT on all /api/admin/* routes.
 *
 * Issue #1001
 */

import type { Request, Response, NextFunction } from "express";
import { verifyJwt } from "../routes/adminAuth";

export function adminAuthMiddleware(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const auth = req.headers["authorization"] ?? "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";

  if (!token) {
    res.status(401).json({ error: "Unauthorized — admin JWT required" });
    return;
  }

  const claims = verifyJwt(token);
  if (!claims) {
    res.status(401).json({ error: "Unauthorized — invalid or expired JWT" });
    return;
  }

  // Attach admin identity to request locals for downstream handlers.
  res.locals.adminPublicKey = claims.sub;
  next();
}
