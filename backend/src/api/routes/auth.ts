import { Router, Request, Response, NextFunction } from "express";
import { z } from "zod";
import { getAuthService, AuthService } from "../../services/auth";
import { sessionAuthMiddleware, optionalAuthMiddleware } from "../middleware/auth";
import { ValidationError } from "../../errors/ValidationError";

const createTokenSchema = z.object({
  walletPublicKey: z.string().min(1, "walletPublicKey is required"),
  deviceId: z.string().min(1, "deviceId is required"),
  deviceName: z.string().optional(),
});

const refreshTokenSchema = z.object({
  refreshToken: z.string().min(1, "refreshToken is required"),
});

const revokeSessionSchema = z.object({
  sessionId: z.string().optional(),
  reason: z.string().optional(),
});

export function createAuthRouter(authService?: AuthService): Router {
  const router = Router();
  const service = authService ?? getAuthService();

  /**
   * @openapi
   * /api/auth/token:
   *   post:
   *     summary: Issue access and refresh token pair
   *     description: Establishes a new authenticated session family for a wallet & device.
   *     tags: [Auth]
   *     requestBody:
   *       required: true
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *             required: [walletPublicKey, deviceId]
   *             properties:
   *               walletPublicKey:
   *                 type: string
   *               deviceId:
   *                 type: string
   *               deviceName:
   *                 type: string
   *     responses:
   *       200:
   *         description: Tokens issued successfully
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/AuthTokensResponse'
   */
  router.post("/token", (req: Request, res: Response, next: NextFunction) => {
    const parseResult = createTokenSchema.safeParse(req.body);
    if (!parseResult.success) {
      return next(new ValidationError("Invalid request body", { issues: parseResult.error.issues }));
    }

    try {
      const { walletPublicKey, deviceId, deviceName } = parseResult.data;
      const ipAddress = req.ip || req.socket.remoteAddress || "unknown";
      const userAgent = req.headers["user-agent"] || "unknown";

      const tokens = service.createSession({
        walletPublicKey,
        deviceId,
        deviceName,
        ipAddress,
        userAgent,
      });

      res.status(200).json(tokens);
    } catch (err) {
      next(err);
    }
  });

  /**
   * @openapi
   * /api/auth/refresh:
   *   post:
   *     summary: Rotate refresh token
   *     description: Exchanges an active refresh token for a new access/refresh pair. Replaying a consumed refresh token revokes the entire session family.
   *     tags: [Auth]
   *     requestBody:
   *       required: true
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *             required: [refreshToken]
   *             properties:
   *               refreshToken:
   *                 type: string
   *     responses:
   *       200:
   *         description: Refreshed token pair
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/TokenRefreshResponse'
   *       401:
   *         description: Invalid, expired, or reused refresh token
   */
  router.post("/refresh", (req: Request, res: Response, next: NextFunction) => {
    const parseResult = refreshTokenSchema.safeParse(req.body);
    if (!parseResult.success) {
      return next(new ValidationError("Invalid request body", { issues: parseResult.error.issues }));
    }

    try {
      const { refreshToken } = parseResult.data;
      const ipAddress = req.ip || req.socket.remoteAddress || "unknown";
      const userAgent = req.headers["user-agent"] || "unknown";

      const tokens = service.rotateRefreshToken({
        refreshToken,
        ipAddress,
        userAgent,
      });

      res.status(200).json(tokens);
    } catch (err) {
      next(err);
    }
  });

  /**
   * @openapi
   * /api/auth/revoke:
   *   post:
   *     summary: Revoke session
   *     description: Revokes the specified or current active session.
   *     tags: [Auth]
   *     security:
   *       - BearerAuth: []
   *     requestBody:
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *             properties:
   *               sessionId:
   *                 type: string
   *               reason:
   *                 type: string
   *     responses:
   *       200:
   *         description: Session revoked
   */
  router.post("/revoke", optionalAuthMiddleware, (req: Request, res: Response, next: NextFunction) => {
    const parseResult = revokeSessionSchema.safeParse(req.body || {});
    if (!parseResult.success) {
      return next(new ValidationError("Invalid request body", { issues: parseResult.error.issues }));
    }

    try {
      const targetSessionId = parseResult.data.sessionId || req.user?.sessionId;
      if (!targetSessionId) {
        return next(new ValidationError("sessionId is required or must authenticate via Bearer token"));
      }

      const ipAddress = req.ip || req.socket.remoteAddress || "unknown";
      const userAgent = req.headers["user-agent"] || "unknown";

      service.revokeSession(
        targetSessionId,
        parseResult.data.reason || "User requested revocation",
        ipAddress,
        userAgent
      );

      res.status(200).json({ success: true, message: "Session revoked successfully" });
    } catch (err) {
      next(err);
    }
  });

  /**
   * @openapi
   * /api/auth/revoke-all:
   *   post:
   *     summary: Revoke all user sessions
   *     description: Revokes all active sessions across all devices for the authenticated wallet.
   *     tags: [Auth]
   *     security:
   *       - BearerAuth: []
   *     responses:
   *       200:
   *         description: All sessions revoked
   */
  router.post("/revoke-all", sessionAuthMiddleware, (req: Request, res: Response, next: NextFunction) => {
    try {
      const walletPublicKey = req.user!.sub;
      const ipAddress = req.ip || req.socket.remoteAddress || "unknown";
      const userAgent = req.headers["user-agent"] || "unknown";

      const count = service.revokeAllUserSessions(
        walletPublicKey,
        "User logged out of all devices",
        ipAddress,
        userAgent
      );

      res.status(200).json({
        success: true,
        count,
        message: `Successfully revoked ${count} session(s)`,
      });
    } catch (err) {
      next(err);
    }
  });

  /**
   * @openapi
   * /api/auth/sessions:
   *   get:
   *     summary: List active sessions
   *     description: Returns all active devices/sessions for the authenticated wallet.
   *     tags: [Auth]
   *     security:
   *       - BearerAuth: []
   *     responses:
   *       200:
   *         description: List of active sessions
   */
  router.get("/sessions", sessionAuthMiddleware, (req: Request, res: Response, next: NextFunction) => {
    try {
      const walletPublicKey = req.user!.sub;
      const currentSessionId = req.user!.sessionId;
      const sessions = service.listUserSessions(walletPublicKey).map((s) => ({
        id: s.id,
        familyId: s.familyId,
        deviceId: s.deviceId,
        deviceName: s.deviceName,
        ipAddress: s.ipAddress,
        userAgent: s.userAgent,
        createdAt: s.createdAt,
        lastActiveAt: s.lastActiveAt,
        expiresAt: s.expiresAt,
        isCurrent: s.id === currentSessionId,
      }));

      res.status(200).json({ sessions });
    } catch (err) {
      next(err);
    }
  });

  /**
   * @openapi
   * /api/auth/audit-logs:
   *   get:
   *     summary: List auth audit logs
   *     description: Returns security audit trail for compliance and intrusion detection.
   *     tags: [Auth]
   *     security:
   *       - BearerAuth: []
   *     responses:
   *       200:
   *         description: Audit logs
   */
  router.get("/audit-logs", sessionAuthMiddleware, (req: Request, res: Response, next: NextFunction) => {
    try {
      const walletPublicKey = req.user!.sub;
      const limit = req.query.limit ? Number(req.query.limit) : 50;
      const offset = req.query.offset ? Number(req.query.offset) : 0;
      const action = typeof req.query.action === "string" ? req.query.action : undefined;

      const logs = service.getAuditLogs({
        walletPublicKey,
        action,
        limit,
        offset,
      });

      res.status(200).json({ logs });
    } catch (err) {
      next(err);
    }
  });

  return router;
}

export const authRouter = createAuthRouter();
