import Database from "better-sqlite3";
import path from "path";
import { createLogger } from "../utils/logger";

const logger = createLogger({ component: "auth-db" });

export interface AuthSession {
  id: string;
  familyId: string;
  walletPublicKey: string;
  deviceId: string;
  deviceName: string | null;
  ipAddress: string;
  userAgent: string;
  createdAt: string;
  lastActiveAt: string;
  expiresAt: string;
  isRevoked: number;
  revokedAt: string | null;
  revokedReason: string | null;
}

export interface AuthRefreshToken {
  id: string;
  tokenHash: string;
  sessionId: string;
  familyId: string;
  walletPublicKey: string;
  createdAt: string;
  expiresAt: string;
  isConsumed: number;
  consumedAt: string | null;
  isRevoked: number;
  revokedAt: string | null;
  replacedByTokenHash: string | null;
}

export type AuthAuditAction =
  | "SESSION_CREATED"
  | "TOKEN_ROTATED"
  | "TOKEN_REUSE_DETECTED"
  | "SESSION_REVOKED"
  | "DEVICE_REVOKED"
  | "SESSION_FAMILY_REVOKED"
  | "ALL_SESSIONS_REVOKED"
  | "ACCESS_TOKEN_VERIFIED"
  | "AUTH_FAILED";

export type AuthAuditStatus = "SUCCESS" | "FAILURE" | "SECURITY_ALERT";

export interface AuthAuditLog {
  id?: number;
  timestamp: string;
  action: AuthAuditAction | string;
  walletPublicKey: string | null;
  familyId: string | null;
  sessionId: string | null;
  deviceId: string | null;
  ipAddress: string | null;
  userAgent: string | null;
  status: AuthAuditStatus;
  reason: string | null;
  metadata: string | null;
}

let _authDb: Database.Database | null = null;

export function getAuthDb(dbPath?: string): Database.Database {
  if (!_authDb) {
    const filePath = dbPath ?? path.join(process.cwd(), "auth.db");
    _authDb = new Database(filePath);
    _authDb.pragma("busy_timeout = 5000");
    _authDb.pragma("journal_mode = WAL");
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (_authDb as any).on("error", (err: Error) => {
        logger.error({ err }, "auth database error");
      });
    } catch {
      // ignore
    }
    _authDb.exec(`
      CREATE TABLE IF NOT EXISTS auth_sessions (
        id              TEXT PRIMARY KEY,
        familyId        TEXT NOT NULL,
        walletPublicKey TEXT NOT NULL,
        deviceId        TEXT NOT NULL,
        deviceName      TEXT,
        ipAddress       TEXT NOT NULL,
        userAgent       TEXT NOT NULL,
        createdAt       TEXT NOT NULL,
        lastActiveAt    TEXT NOT NULL,
        expiresAt       TEXT NOT NULL,
        isRevoked       INTEGER NOT NULL DEFAULT 0,
        revokedAt       TEXT,
        revokedReason   TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_auth_sessions_familyId ON auth_sessions(familyId);
      CREATE INDEX IF NOT EXISTS idx_auth_sessions_wallet ON auth_sessions(walletPublicKey);
      CREATE INDEX IF NOT EXISTS idx_auth_sessions_device ON auth_sessions(walletPublicKey, deviceId);

      CREATE TABLE IF NOT EXISTS auth_refresh_tokens (
        id                  TEXT PRIMARY KEY,
        tokenHash           TEXT NOT NULL UNIQUE,
        sessionId           TEXT NOT NULL,
        familyId            TEXT NOT NULL,
        walletPublicKey     TEXT NOT NULL,
        createdAt           TEXT NOT NULL,
        expiresAt           TEXT NOT NULL,
        isConsumed          INTEGER NOT NULL DEFAULT 0,
        consumedAt          TEXT,
        isRevoked           INTEGER NOT NULL DEFAULT 0,
        revokedAt           TEXT,
        replacedByTokenHash TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_auth_tokens_hash ON auth_refresh_tokens(tokenHash);
      CREATE INDEX IF NOT EXISTS idx_auth_tokens_familyId ON auth_refresh_tokens(familyId);
      CREATE INDEX IF NOT EXISTS idx_auth_tokens_sessionId ON auth_refresh_tokens(sessionId);

      CREATE TABLE IF NOT EXISTS auth_audit_logs (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp       TEXT NOT NULL,
        action          TEXT NOT NULL,
        walletPublicKey TEXT,
        familyId        TEXT,
        sessionId       TEXT,
        deviceId        TEXT,
        ipAddress       TEXT,
        userAgent       TEXT,
        status          TEXT NOT NULL,
        reason          TEXT,
        metadata        TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_auth_audit_wallet ON auth_audit_logs(walletPublicKey);
      CREATE INDEX IF NOT EXISTS idx_auth_audit_familyId ON auth_audit_logs(familyId);
      CREATE INDEX IF NOT EXISTS idx_auth_audit_action ON auth_audit_logs(action);
      CREATE INDEX IF NOT EXISTS idx_auth_audit_timestamp ON auth_audit_logs(timestamp);
    `);
  }
  return _authDb;
}

export function closeAuthDb(): void {
  _authDb?.close();
  _authDb = null;
}

export interface AuthDb {
  // Session operations
  createSession(session: AuthSession): void;
  findSessionById(sessionId: string): AuthSession | undefined;
  updateSessionActivity(sessionId: string, lastActiveAt: string, expiresAt: string): void;
  revokeSession(sessionId: string, reason: string, revokedAt: string): void;
  revokeFamily(familyId: string, reason: string, revokedAt: string): number;
  revokeAllUserSessions(walletPublicKey: string, reason: string, revokedAt: string): number;
  listActiveSessions(walletPublicKey: string): AuthSession[];

  // Refresh token operations
  createRefreshToken(token: AuthRefreshToken): void;
  findRefreshTokenByHash(tokenHash: string): AuthRefreshToken | undefined;
  markTokenConsumed(tokenHash: string, consumedAt: string, replacedByTokenHash: string): void;
  revokeTokensByFamily(familyId: string, revokedAt: string): void;
  revokeTokensBySession(sessionId: string, revokedAt: string): void;
  revokeTokensByUser(walletPublicKey: string, revokedAt: string): void;

  // Audit log operations
  insertAuditLog(log: AuthAuditLog): void;
  listAuditLogs(filters?: {
    walletPublicKey?: string;
    familyId?: string;
    action?: string;
    limit?: number;
    offset?: number;
  }): AuthAuditLog[];
}

export function createAuthDb(db: Database.Database): AuthDb {
  const insertSessionStmt = db.prepare(`
    INSERT INTO auth_sessions (
      id, familyId, walletPublicKey, deviceId, deviceName, ipAddress, userAgent,
      createdAt, lastActiveAt, expiresAt, isRevoked, revokedAt, revokedReason
    ) VALUES (
      @id, @familyId, @walletPublicKey, @deviceId, @deviceName, @ipAddress, @userAgent,
      @createdAt, @lastActiveAt, @expiresAt, @isRevoked, @revokedAt, @revokedReason
    )
  `);

  const findSessionByIdStmt = db.prepare(
    "SELECT * FROM auth_sessions WHERE id = ?"
  );

  const updateSessionActivityStmt = db.prepare(`
    UPDATE auth_sessions
    SET lastActiveAt = ?, expiresAt = ?
    WHERE id = ? AND isRevoked = 0
  `);

  const revokeSessionStmt = db.prepare(`
    UPDATE auth_sessions
    SET isRevoked = 1, revokedAt = ?, revokedReason = ?
    WHERE id = ?
  `);

  const revokeFamilySessionsStmt = db.prepare(`
    UPDATE auth_sessions
    SET isRevoked = 1, revokedAt = ?, revokedReason = ?
    WHERE familyId = ? AND isRevoked = 0
  `);

  const revokeUserSessionsStmt = db.prepare(`
    UPDATE auth_sessions
    SET isRevoked = 1, revokedAt = ?, revokedReason = ?
    WHERE walletPublicKey = ? AND isRevoked = 0
  `);

  const listActiveSessionsStmt = db.prepare(`
    SELECT * FROM auth_sessions
    WHERE walletPublicKey = ? AND isRevoked = 0
    ORDER BY lastActiveAt DESC
  `);

  const insertTokenStmt = db.prepare(`
    INSERT INTO auth_refresh_tokens (
      id, tokenHash, sessionId, familyId, walletPublicKey, createdAt, expiresAt,
      isConsumed, consumedAt, isRevoked, revokedAt, replacedByTokenHash
    ) VALUES (
      @id, @tokenHash, @sessionId, @familyId, @walletPublicKey, @createdAt, @expiresAt,
      @isConsumed, @consumedAt, @isRevoked, @revokedAt, @replacedByTokenHash
    )
  `);

  const findTokenByHashStmt = db.prepare(
    "SELECT * FROM auth_refresh_tokens WHERE tokenHash = ?"
  );

  const markTokenConsumedStmt = db.prepare(`
    UPDATE auth_refresh_tokens
    SET isConsumed = 1, consumedAt = ?, replacedByTokenHash = ?
    WHERE tokenHash = ?
  `);

  const revokeTokensByFamilyStmt = db.prepare(`
    UPDATE auth_refresh_tokens
    SET isRevoked = 1, revokedAt = ?
    WHERE familyId = ? AND isRevoked = 0
  `);

  const revokeTokensBySessionStmt = db.prepare(`
    UPDATE auth_refresh_tokens
    SET isRevoked = 1, revokedAt = ?
    WHERE sessionId = ? AND isRevoked = 0
  `);

  const revokeTokensByUserStmt = db.prepare(`
    UPDATE auth_refresh_tokens
    SET isRevoked = 1, revokedAt = ?
    WHERE walletPublicKey = ? AND isRevoked = 0
  `);

  const insertAuditLogStmt = db.prepare(`
    INSERT INTO auth_audit_logs (
      timestamp, action, walletPublicKey, familyId, sessionId, deviceId,
      ipAddress, userAgent, status, reason, metadata
    ) VALUES (
      @timestamp, @action, @walletPublicKey, @familyId, @sessionId, @deviceId,
      @ipAddress, @userAgent, @status, @reason, @metadata
    )
  `);

  return {
    createSession(session: AuthSession): void {
      insertSessionStmt.run(session);
    },

    findSessionById(sessionId: string): AuthSession | undefined {
      return findSessionByIdStmt.get(sessionId) as AuthSession | undefined;
    },

    updateSessionActivity(sessionId: string, lastActiveAt: string, expiresAt: string): void {
      updateSessionActivityStmt.run(lastActiveAt, expiresAt, sessionId);
    },

    revokeSession(sessionId: string, reason: string, revokedAt: string): void {
      revokeSessionStmt.run(revokedAt, reason, sessionId);
    },

    revokeFamily(familyId: string, reason: string, revokedAt: string): number {
      const result = revokeFamilySessionsStmt.run(revokedAt, reason, familyId);
      return result.changes;
    },

    revokeAllUserSessions(walletPublicKey: string, reason: string, revokedAt: string): number {
      const result = revokeUserSessionsStmt.run(revokedAt, reason, walletPublicKey);
      return result.changes;
    },

    listActiveSessions(walletPublicKey: string): AuthSession[] {
      return listActiveSessionsStmt.all(walletPublicKey) as AuthSession[];
    },

    createRefreshToken(token: AuthRefreshToken): void {
      insertTokenStmt.run(token);
    },

    findRefreshTokenByHash(tokenHash: string): AuthRefreshToken | undefined {
      return findTokenByHashStmt.get(tokenHash) as AuthRefreshToken | undefined;
    },

    markTokenConsumed(tokenHash: string, consumedAt: string, replacedByTokenHash: string): void {
      markTokenConsumedStmt.run(consumedAt, replacedByTokenHash, tokenHash);
    },

    revokeTokensByFamily(familyId: string, revokedAt: string): void {
      revokeTokensByFamilyStmt.run(revokedAt, familyId);
    },

    revokeTokensBySession(sessionId: string, revokedAt: string): void {
      revokeTokensBySessionStmt.run(revokedAt, sessionId);
    },

    revokeTokensByUser(walletPublicKey: string, revokedAt: string): void {
      revokeTokensByUserStmt.run(revokedAt, walletPublicKey);
    },

    insertAuditLog(log: AuthAuditLog): void {
      insertAuditLogStmt.run(log);
    },

    listAuditLogs(filters = {}): AuthAuditLog[] {
      const conditions: string[] = [];
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const params: any[] = [];

      if (filters.walletPublicKey) {
        conditions.push("walletPublicKey = ?");
        params.push(filters.walletPublicKey);
      }
      if (filters.familyId) {
        conditions.push("familyId = ?");
        params.push(filters.familyId);
      }
      if (filters.action) {
        conditions.push("action = ?");
        params.push(filters.action);
      }

      let query = "SELECT * FROM auth_audit_logs";
      if (conditions.length > 0) {
        query += " WHERE " + conditions.join(" AND ");
      }
      query += " ORDER BY id DESC";

      if (filters.limit) {
        query += " LIMIT ?";
        params.push(filters.limit);
        if (filters.offset) {
          query += " OFFSET ?";
          params.push(filters.offset);
        }
      }

      return db.prepare(query).all(...params) as AuthAuditLog[];
    },
  };
}
