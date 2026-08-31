import crypto from "crypto";
import {
  AuthDb,
  AuthSession,
  AuthRefreshToken,
  AuthAuditLog,
  getAuthDb,
  createAuthDb,
} from "../../db/auth";
import { TokenService, AccessTokenPayload } from "./tokenService";
import { RevocationRegistry, globalRevocationRegistry } from "./revocationRegistry";
import { AuthenticationError } from "../../errors/AuthenticationError";
import { createLogger } from "../../utils/logger";

const logger = createLogger({ component: "auth-service" });

export interface CreateSessionParams {
  walletPublicKey: string;
  deviceId: string;
  deviceName?: string;
  ipAddress: string;
  userAgent: string;
}

export interface RotateTokenParams {
  refreshToken: string;
  ipAddress: string;
  userAgent: string;
}

export interface AuthTokensResponse {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  tokenType: "Bearer";
  session: {
    id: string;
    familyId: string;
    deviceId: string;
    deviceName: string | null;
    expiresAt: string;
  };
}

export interface TokenRefreshResponse {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  tokenType: "Bearer";
}

export class AuthService {
  private authDb: AuthDb;
  private tokenService: TokenService;
  private revocationRegistry: RevocationRegistry;

  constructor(options?: {
    authDb?: AuthDb;
    tokenService?: TokenService;
    revocationRegistry?: RevocationRegistry;
  }) {
    this.authDb = options?.authDb ?? createAuthDb(getAuthDb());
    this.tokenService = options?.tokenService ?? new TokenService();
    this.revocationRegistry = options?.revocationRegistry ?? globalRevocationRegistry;
  }

  /**
   * Issues a new access token and refresh token pair, creating a new session family.
   */
  public createSession(params: CreateSessionParams): AuthTokensResponse {
    const now = new Date();
    const nowIso = now.toISOString();
    const nowEpoch = Math.floor(now.getTime() / 1000);

    const sessionId = `sess_${crypto.randomUUID()}`;
    const familyId = `fam_${crypto.randomUUID()}`;

    const slidingTtl = this.tokenService.getRefreshTtlSeconds();
    const maxTtl = this.tokenService.getSessionMaxTtlSeconds();

    const expiresAtDate = new Date(now.getTime() + slidingTtl * 1000);
    const expiresAtIso = expiresAtDate.toISOString();

    // Create session record
    const session: AuthSession = {
      id: sessionId,
      familyId,
      walletPublicKey: params.walletPublicKey,
      deviceId: params.deviceId,
      deviceName: params.deviceName ?? null,
      ipAddress: params.ipAddress,
      userAgent: params.userAgent,
      createdAt: nowIso,
      lastActiveAt: nowIso,
      expiresAt: expiresAtIso,
      isRevoked: 0,
      revokedAt: null,
      revokedReason: null,
    };
    this.authDb.createSession(session);

    // Generate tokens
    const rawRefreshToken = this.tokenService.generateRefreshToken();
    const tokenHash = this.tokenService.hashRefreshToken(rawRefreshToken);
    const tokenId = `tok_${crypto.randomUUID()}`;

    const refreshTokenRecord: AuthRefreshToken = {
      id: tokenId,
      tokenHash,
      sessionId,
      familyId,
      walletPublicKey: params.walletPublicKey,
      createdAt: nowIso,
      expiresAt: expiresAtIso,
      isConsumed: 0,
      consumedAt: null,
      isRevoked: 0,
      revokedAt: null,
      replacedByTokenHash: null,
    };
    this.authDb.createRefreshToken(refreshTokenRecord);

    const { token: accessToken, expiresIn } = this.tokenService.generateAccessToken({
      walletPublicKey: params.walletPublicKey,
      sessionId,
      familyId,
      deviceId: params.deviceId,
    });

    // Record audit log
    this.authDb.insertAuditLog({
      timestamp: nowIso,
      action: "SESSION_CREATED",
      walletPublicKey: params.walletPublicKey,
      familyId,
      sessionId,
      deviceId: params.deviceId,
      ipAddress: params.ipAddress,
      userAgent: params.userAgent,
      status: "SUCCESS",
      reason: null,
      metadata: JSON.stringify({ deviceName: params.deviceName }),
    });

    return {
      accessToken,
      refreshToken: rawRefreshToken,
      expiresIn,
      tokenType: "Bearer",
      session: {
        id: sessionId,
        familyId,
        deviceId: params.deviceId,
        deviceName: params.deviceName ?? null,
        expiresAt: expiresAtIso,
      },
    };
  }

  /**
   * Rotates a refresh token:
   * 1. Detects reuse: If an already-consumed refresh token is presented, REVOKES THE ENTIRE FAMILY.
   * 2. If valid, marks old token consumed, creates new access/refresh pair, advances sliding expiry, and returns new tokens.
   */
  public rotateRefreshToken(params: RotateTokenParams): TokenRefreshResponse {
    const now = new Date();
    const nowIso = now.toISOString();

    if (!params.refreshToken) {
      throw new AuthenticationError("Refresh token is required");
    }

    const tokenHash = this.tokenService.hashRefreshToken(params.refreshToken);
    const tokenRecord = this.authDb.findRefreshTokenByHash(tokenHash);

    if (!tokenRecord) {
      this.authDb.insertAuditLog({
        timestamp: nowIso,
        action: "AUTH_FAILED",
        walletPublicKey: null,
        familyId: null,
        sessionId: null,
        deviceId: null,
        ipAddress: params.ipAddress,
        userAgent: params.userAgent,
        status: "FAILURE",
        reason: "Unknown refresh token",
        metadata: null,
      });
      throw new AuthenticationError("Invalid refresh token");
    }

    // ── REUSE DETECTION ────────────────────────────────────────────────────────
    // If the token was already consumed, an adversary or stale client is replaying it!
    if (tokenRecord.isConsumed === 1) {
      logger.warn(
        {
          familyId: tokenRecord.familyId,
          sessionId: tokenRecord.sessionId,
          walletPublicKey: tokenRecord.walletPublicKey,
        },
        "SECURITY ALERT: Refresh token reuse detected! Revoking session family."
      );

      // Invalidate the entire family across DB and fast in-memory cache
      this.authDb.revokeFamily(
        tokenRecord.familyId,
        "Token reuse detected - potential token theft",
        nowIso
      );
      this.authDb.revokeTokensByFamily(tokenRecord.familyId, nowIso);
      this.revocationRegistry.revokeFamily(
        tokenRecord.familyId,
        "Token reuse detected - potential token theft"
      );

      // Record high-severity audit logs
      this.authDb.insertAuditLog({
        timestamp: nowIso,
        action: "TOKEN_REUSE_DETECTED",
        walletPublicKey: tokenRecord.walletPublicKey,
        familyId: tokenRecord.familyId,
        sessionId: tokenRecord.sessionId,
        deviceId: null,
        ipAddress: params.ipAddress,
        userAgent: params.userAgent,
        status: "SECURITY_ALERT",
        reason: "Attempted reuse of consumed refresh token",
        metadata: JSON.stringify({
          reusedTokenId: tokenRecord.id,
          consumedAt: tokenRecord.consumedAt,
        }),
      });

      this.authDb.insertAuditLog({
        timestamp: nowIso,
        action: "SESSION_FAMILY_REVOKED",
        walletPublicKey: tokenRecord.walletPublicKey,
        familyId: tokenRecord.familyId,
        sessionId: tokenRecord.sessionId,
        deviceId: null,
        ipAddress: params.ipAddress,
        userAgent: params.userAgent,
        status: "SECURITY_ALERT",
        reason: "Family revoked due to reuse detection",
        metadata: null,
      });

      throw new AuthenticationError(
        "Token reuse detected. All sessions in this family have been revoked."
      );
    }

    // Check if family, session, or token is revoked
    if (
      tokenRecord.isRevoked === 1 ||
      this.revocationRegistry.isFamilyRevoked(tokenRecord.familyId) ||
      this.revocationRegistry.isSessionRevoked(tokenRecord.sessionId)
    ) {
      this.authDb.insertAuditLog({
        timestamp: nowIso,
        action: "AUTH_FAILED",
        walletPublicKey: tokenRecord.walletPublicKey,
        familyId: tokenRecord.familyId,
        sessionId: tokenRecord.sessionId,
        deviceId: null,
        ipAddress: params.ipAddress,
        userAgent: params.userAgent,
        status: "FAILURE",
        reason: "Token or session is revoked",
        metadata: null,
      });
      throw new AuthenticationError("Session or token has been revoked");
    }

    // Check token expiry
    if (new Date(tokenRecord.expiresAt).getTime() < now.getTime()) {
      this.authDb.insertAuditLog({
        timestamp: nowIso,
        action: "AUTH_FAILED",
        walletPublicKey: tokenRecord.walletPublicKey,
        familyId: tokenRecord.familyId,
        sessionId: tokenRecord.sessionId,
        deviceId: null,
        ipAddress: params.ipAddress,
        userAgent: params.userAgent,
        status: "FAILURE",
        reason: "Refresh token expired",
        metadata: null,
      });
      throw new AuthenticationError("Refresh token has expired");
    }

    // Check parent session
    const session = this.authDb.findSessionById(tokenRecord.sessionId);
    if (!session || session.isRevoked === 1) {
      throw new AuthenticationError("Session not found or revoked");
    }

    // Check absolute session max expiry
    const sessionCreatedAtEpoch = new Date(session.createdAt).getTime();
    const maxSessionExpiry = sessionCreatedAtEpoch + this.tokenService.getSessionMaxTtlSeconds() * 1000;
    if (now.getTime() > maxSessionExpiry) {
      this.authDb.revokeSession(session.id, "Absolute session lifetime expired", nowIso);
      this.revocationRegistry.revokeSession(session.id, "Absolute session lifetime expired");
      throw new AuthenticationError("Session has exceeded maximum allowed lifetime");
    }

    // ── ROTATE TOKEN ───────────────────────────────────────────────────────────
    const newRawRefreshToken = this.tokenService.generateRefreshToken();
    const newTokenHash = this.tokenService.hashRefreshToken(newRawRefreshToken);
    const newTokenId = `tok_${crypto.randomUUID()}`;

    // Mark current token consumed
    this.authDb.markTokenConsumed(tokenHash, nowIso, newTokenHash);

    // Calculate sliding expiry bounded by max session lifetime
    const slidingExpiryTime = now.getTime() + this.tokenService.getRefreshTtlSeconds() * 1000;
    const newExpiresAtEpoch = Math.min(slidingExpiryTime, maxSessionExpiry);
    const newExpiresAtIso = new Date(newExpiresAtEpoch).toISOString();

    // Create new refresh token record
    const newTokenRecord: AuthRefreshToken = {
      id: newTokenId,
      tokenHash: newTokenHash,
      sessionId: session.id,
      familyId: session.familyId,
      walletPublicKey: session.walletPublicKey,
      createdAt: nowIso,
      expiresAt: newExpiresAtIso,
      isConsumed: 0,
      consumedAt: null,
      isRevoked: 0,
      revokedAt: null,
      replacedByTokenHash: null,
    };
    this.authDb.createRefreshToken(newTokenRecord);

    // Update session last active & expiry
    this.authDb.updateSessionActivity(session.id, nowIso, newExpiresAtIso);

    // Generate new access token
    const { token: accessToken, expiresIn } = this.tokenService.generateAccessToken({
      walletPublicKey: session.walletPublicKey,
      sessionId: session.id,
      familyId: session.familyId,
      deviceId: session.deviceId,
    });

    // Record audit log
    this.authDb.insertAuditLog({
      timestamp: nowIso,
      action: "TOKEN_ROTATED",
      walletPublicKey: session.walletPublicKey,
      familyId: session.familyId,
      sessionId: session.id,
      deviceId: session.deviceId,
      ipAddress: params.ipAddress,
      userAgent: params.userAgent,
      status: "SUCCESS",
      reason: null,
      metadata: JSON.stringify({
        previousTokenId: tokenRecord.id,
        newTokenId,
      }),
    });

    return {
      accessToken,
      refreshToken: newRawRefreshToken,
      expiresIn,
      tokenType: "Bearer",
    };
  }

  /**
   * Verifies access token cryptographically and confirms session/family is active and unrevoked.
   */
  public verifyAccessToken(tokenString: string): AccessTokenPayload {
    let payload: AccessTokenPayload;
    try {
      payload = this.tokenService.verifyAccessToken(tokenString);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Invalid access token";
      throw new AuthenticationError(msg);
    }

    // Fast in-memory revocation check
    if (this.revocationRegistry.isSessionRevoked(payload.sessionId)) {
      throw new AuthenticationError("Session has been revoked");
    }
    if (this.revocationRegistry.isFamilyRevoked(payload.familyId)) {
      throw new AuthenticationError("Session family has been revoked");
    }
    if (this.revocationRegistry.isWalletRevoked(payload.sub, payload.iat)) {
      throw new AuthenticationError("User sessions have been revoked");
    }

    // Database check to guarantee consistency across process restarts
    const session = this.authDb.findSessionById(payload.sessionId);
    if (!session || session.isRevoked === 1) {
      // Sync in-memory cache
      this.revocationRegistry.revokeSession(payload.sessionId);
      throw new AuthenticationError("Session is no longer valid or has been revoked");
    }

    return payload;
  }

  /**
   * Revokes a specific session.
   */
  public revokeSession(
    sessionId: string,
    reason = "User logged out / session revoked",
    ipAddress?: string,
    userAgent?: string
  ): void {
    const nowIso = new Date().toISOString();
    const session = this.authDb.findSessionById(sessionId);

    this.authDb.revokeSession(sessionId, reason, nowIso);
    this.authDb.revokeTokensBySession(sessionId, nowIso);
    this.revocationRegistry.revokeSession(sessionId, reason);

    this.authDb.insertAuditLog({
      timestamp: nowIso,
      action: "SESSION_REVOKED",
      walletPublicKey: session?.walletPublicKey ?? null,
      familyId: session?.familyId ?? null,
      sessionId,
      deviceId: session?.deviceId ?? null,
      ipAddress: ipAddress ?? null,
      userAgent: userAgent ?? null,
      status: "SUCCESS",
      reason,
      metadata: null,
    });
  }

  /**
   * Revokes an entire session family.
   */
  public revokeFamily(
    familyId: string,
    reason = "Session family revoked",
    ipAddress?: string,
    userAgent?: string
  ): number {
    const nowIso = new Date().toISOString();
    const count = this.authDb.revokeFamily(familyId, reason, nowIso);
    this.authDb.revokeTokensByFamily(familyId, nowIso);
    this.revocationRegistry.revokeFamily(familyId, reason);

    this.authDb.insertAuditLog({
      timestamp: nowIso,
      action: "SESSION_FAMILY_REVOKED",
      walletPublicKey: null,
      familyId,
      sessionId: null,
      deviceId: null,
      ipAddress: ipAddress ?? null,
      userAgent: userAgent ?? null,
      status: "SUCCESS",
      reason,
      metadata: JSON.stringify({ sessionsRevoked: count }),
    });

    return count;
  }

  /**
   * Revokes all active sessions for a given wallet address.
   */
  public revokeAllUserSessions(
    walletPublicKey: string,
    reason = "All user sessions revoked",
    ipAddress?: string,
    userAgent?: string
  ): number {
    const nowIso = new Date().toISOString();
    const count = this.authDb.revokeAllUserSessions(walletPublicKey, reason, nowIso);
    this.authDb.revokeTokensByUser(walletPublicKey, nowIso);
    this.revocationRegistry.revokeWallet(walletPublicKey, reason);

    this.authDb.insertAuditLog({
      timestamp: nowIso,
      action: "ALL_SESSIONS_REVOKED",
      walletPublicKey,
      familyId: null,
      sessionId: null,
      deviceId: null,
      ipAddress: ipAddress ?? null,
      userAgent: userAgent ?? null,
      status: "SUCCESS",
      reason,
      metadata: JSON.stringify({ sessionsRevoked: count }),
    });

    return count;
  }

  /**
   * Lists all active (unrevoked) sessions for a user/wallet.
   */
  public listUserSessions(walletPublicKey: string): AuthSession[] {
    return this.authDb.listActiveSessions(walletPublicKey);
  }

  /**
   * Retrieves audit logs.
   */
  public getAuditLogs(filters?: {
    walletPublicKey?: string;
    familyId?: string;
    action?: string;
    limit?: number;
    offset?: number;
  }): AuthAuditLog[] {
    return this.authDb.listAuditLogs(filters);
  }
}

let _authService: AuthService | null = null;

export function getAuthService(): AuthService {
  if (!_authService) {
    _authService = new AuthService();
  }
  return _authService;
}
