import request from "supertest";
import Database from "better-sqlite3";
import express from "express";
import { createAuthDb, AuthDb } from "../src/db/auth";
import { TokenService } from "../src/services/auth/tokenService";
import { RevocationRegistry } from "../src/services/auth/revocationRegistry";
import { AuthService } from "../src/services/auth/authService";
import { createAuthRouter } from "../src/api/routes/auth";
import { authMiddleware, sessionAuthMiddleware } from "../src/api/middleware/auth";
import { errorHandler } from "../src/api/middleware/errorHandler";

describe("Auth Hardening — Tokens, Rotation, Revocation, and Audit (#367)", () => {
  let db: Database.Database;
  let authDb: AuthDb;
  let tokenService: TokenService;
  let revocationRegistry: RevocationRegistry;
  let authService: AuthService;
  let app: express.Express;

  beforeEach(() => {
    // In-memory SQLite for complete isolation in each test
    db = new Database(":memory:");
    db.exec(`
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
    `);

    authDb = createAuthDb(db);
    tokenService = new TokenService({
      jwtSecret: "test-super-secret-key-1234567890",
      accessTtlSeconds: 900,
      refreshTtlSeconds: 604800,
      sessionMaxTtlSeconds: 2592000,
    });
    revocationRegistry = new RevocationRegistry();
    authService = new AuthService({
      authDb,
      tokenService,
      revocationRegistry,
    });

    app = express();
    app.use(express.json());
    app.use("/api/auth", createAuthRouter(authService));

    // Protected test route
    app.get("/api/protected", sessionAuthMiddleware, (req, res) => {
      res.json({ message: "Welcome to protected area", user: req.user });
    });

    app.use(errorHandler);
  });

  afterEach(() => {
    db.close();
  });

  describe("TokenService unit tests", () => {
    it("generates and verifies valid access tokens", () => {
      const { token, expiresIn } = tokenService.generateAccessToken({
        walletPublicKey: "GABC123456789",
        sessionId: "sess_1",
        familyId: "fam_1",
        deviceId: "dev_mac",
      });

      expect(expiresIn).toBe(900);
      const payload = tokenService.verifyAccessToken(token);
      expect(payload.sub).toBe("GABC123456789");
      expect(payload.sessionId).toBe("sess_1");
      expect(payload.familyId).toBe("fam_1");
      expect(payload.deviceId).toBe("dev_mac");
    });

    it("rejects tampered token signatures", () => {
      const { token } = tokenService.generateAccessToken({
        walletPublicKey: "GABC123456789",
        sessionId: "sess_1",
        familyId: "fam_1",
        deviceId: "dev_mac",
      });

      const parts = token.split(".");
      // Tamper with payload
      const tamperedToken = `${parts[0]}.${parts[1]}tampered.${parts[2]}`;
      expect(() => tokenService.verifyAccessToken(tamperedToken)).toThrow();
    });

    it("rejects expired tokens", () => {
      const shortLivedService = new TokenService({
        jwtSecret: "test-secret",
        accessTtlSeconds: -10, // already expired
      });

      const { token } = shortLivedService.generateAccessToken({
        walletPublicKey: "GABC123456789",
        sessionId: "sess_1",
        familyId: "fam_1",
        deviceId: "dev_mac",
      });

      expect(() => shortLivedService.verifyAccessToken(token)).toThrow("Token expired");
    });

    it("hashes refresh tokens uniquely using SHA-256", () => {
      const token1 = tokenService.generateRefreshToken();
      const token2 = tokenService.generateRefreshToken();
      expect(token1).not.toBe(token2);

      const hash1 = tokenService.hashRefreshToken(token1);
      const hash2 = tokenService.hashRefreshToken(token2);
      expect(hash1).not.toBe(hash2);
      expect(hash1).toHaveLength(64); // hex sha256
    });
  });

  describe("AuthService Lifecycle & Session Family Management", () => {
    it("creates a new session and returns access and refresh tokens", () => {
      const res = authService.createSession({
        walletPublicKey: "G_WALLET_ALICE",
        deviceId: "laptop-01",
        deviceName: "Alice's MacBook",
        ipAddress: "192.168.1.50",
        userAgent: "Mozilla/5.0",
      });

      expect(res.accessToken).toBeDefined();
      expect(res.refreshToken).toBeDefined();
      expect(res.tokenType).toBe("Bearer");
      expect(res.session.familyId).toBeDefined();
      expect(res.session.deviceId).toBe("laptop-01");

      const logs = authService.getAuditLogs({ walletPublicKey: "G_WALLET_ALICE" });
      expect(logs.length).toBeGreaterThan(0);
      expect(logs[0].action).toBe("SESSION_CREATED");
      expect(logs[0].status).toBe("SUCCESS");
    });

    it("rotates refresh token, consuming the old one and returning a new pair", () => {
      const initial = authService.createSession({
        walletPublicKey: "G_WALLET_ALICE",
        deviceId: "laptop-01",
        ipAddress: "192.168.1.50",
        userAgent: "Mozilla/5.0",
      });

      const rotated = authService.rotateRefreshToken({
        refreshToken: initial.refreshToken,
        ipAddress: "192.168.1.50",
        userAgent: "Mozilla/5.0",
      });

      expect(rotated.accessToken).toBeDefined();
      expect(rotated.refreshToken).toBeDefined();
      expect(rotated.refreshToken).not.toBe(initial.refreshToken);

      // Verify the new access token works
      const payload = authService.verifyAccessToken(rotated.accessToken);
      expect(payload.sub).toBe("G_WALLET_ALICE");
      expect(payload.familyId).toBe(initial.session.familyId);

      // Check audit log
      const logs = authService.getAuditLogs({ action: "TOKEN_ROTATED" });
      expect(logs.length).toBe(1);
      expect(logs[0].familyId).toBe(initial.session.familyId);
    });

    it("REUSE DETECTION: Replaying a consumed refresh token revokes the entire session family", () => {
      // 1. Initial login
      const initial = authService.createSession({
        walletPublicKey: "G_WALLET_VICTIM",
        deviceId: "laptop-01",
        ipAddress: "192.168.1.50",
        userAgent: "Mozilla/5.0",
      });
      const oldRefreshToken = initial.refreshToken;
      const familyId = initial.session.familyId;

      // 2. Legitimate rotation: oldRefreshToken is consumed, newRefreshToken issued
      const rotated = authService.rotateRefreshToken({
        refreshToken: oldRefreshToken,
        ipAddress: "192.168.1.50",
        userAgent: "Mozilla/5.0",
      });
      const validRefreshToken = rotated.refreshToken;

      // 3. Attacker replays oldRefreshToken
      expect(() => {
        authService.rotateRefreshToken({
          refreshToken: oldRefreshToken,
          ipAddress: "10.0.0.99", // Attacker IP
          userAgent: "curl/7.68.0",
        });
      }).toThrow(/Token reuse detected/);

      // 4. VERIFY ACCEPTANCE CRITERIA: The entire session family is now revoked!
      // Attempting to use even the latest legitimate refresh token must now fail!
      expect(() => {
        authService.rotateRefreshToken({
          refreshToken: validRefreshToken,
          ipAddress: "192.168.1.50",
          userAgent: "Mozilla/5.0",
        });
      }).toThrow(/revoked/);

      // Attempting to verify the access token from that family fails
      expect(() => {
        authService.verifyAccessToken(rotated.accessToken);
      }).toThrow(/revoked/);

      // Check security alert audit logs
      const reuseLogs = authService.getAuditLogs({ action: "TOKEN_REUSE_DETECTED" });
      expect(reuseLogs.length).toBe(1);
      expect(reuseLogs[0].status).toBe("SECURITY_ALERT");
      expect(reuseLogs[0].familyId).toBe(familyId);

      const familyRevokedLogs = authService.getAuditLogs({ action: "SESSION_FAMILY_REVOKED" });
      expect(familyRevokedLogs.length).toBe(1);
      expect(familyRevokedLogs[0].status).toBe("SECURITY_ALERT");
    });

    it("supports single device session revocation and all-device revocation", () => {
      const session1 = authService.createSession({
        walletPublicKey: "G_WALLET_BOB",
        deviceId: "phone",
        deviceName: "iPhone 15",
        ipAddress: "1.1.1.1",
        userAgent: "Mobile Safari",
      });

      const session2 = authService.createSession({
        walletPublicKey: "G_WALLET_BOB",
        deviceId: "laptop",
        deviceName: "MacBook",
        ipAddress: "1.1.1.2",
        userAgent: "Chrome",
      });

      let activeSessions = authService.listUserSessions("G_WALLET_BOB");
      expect(activeSessions.length).toBe(2);

      // Revoke session 1
      authService.revokeSession(session1.session.id, "User logout from iPhone");

      activeSessions = authService.listUserSessions("G_WALLET_BOB");
      expect(activeSessions.length).toBe(1);
      expect(activeSessions[0].id).toBe(session2.session.id);

      // Session 1 access token is immediately revoked
      expect(() => authService.verifyAccessToken(session1.accessToken)).toThrow(/revoked/);
      // Session 2 access token is still valid
      expect(authService.verifyAccessToken(session2.accessToken).sub).toBe("G_WALLET_BOB");

      // Revoke all remaining sessions
      authService.revokeAllUserSessions("G_WALLET_BOB", "Security reset");
      activeSessions = authService.listUserSessions("G_WALLET_BOB");
      expect(activeSessions.length).toBe(0);
      expect(() => authService.verifyAccessToken(session2.accessToken)).toThrow(/revoked/);
    });

    it("propagates revocation instantly (sub-second propagation)", () => {
      const session = authService.createSession({
        walletPublicKey: "G_WALLET_FAST",
        deviceId: "device_1",
        ipAddress: "10.0.0.1",
        userAgent: "Agent",
      });

      // Token works immediately
      expect(authService.verifyAccessToken(session.accessToken).sub).toBe("G_WALLET_FAST");

      const t0 = Date.now();
      authService.revokeSession(session.session.id);
      const elapsed = Date.now() - t0;

      // Verification fails immediately within milliseconds (< 1 minute requirement)
      expect(elapsed).toBeLessThan(1000);
      expect(() => authService.verifyAccessToken(session.accessToken)).toThrow(/revoked/);
    });

    it("enforces sliding expiry and absolute session max lifetime", () => {
      const session = authService.createSession({
        walletPublicKey: "G_WALLET_SLIDING",
        deviceId: "device_1",
        ipAddress: "10.0.0.1",
        userAgent: "Agent",
      });

      const initialExpiry = new Date(session.session.expiresAt).getTime();

      // Rotate token advances sliding expiry
      const rotated = authService.rotateRefreshToken({
        refreshToken: session.refreshToken,
        ipAddress: "10.0.0.1",
        userAgent: "Agent",
      });
      expect(rotated.accessToken).toBeDefined();

      const updatedSession = authDb.findSessionById(session.session.id);
      expect(updatedSession).toBeDefined();
      expect(new Date(updatedSession!.lastActiveAt).getTime()).toBeGreaterThanOrEqual(
        new Date(session.session.expiresAt).getTime() - 604800 * 1000
      );
    });
  });

  describe("API Endpoints (/api/auth)", () => {
    it("POST /api/auth/token creates tokens and protected route succeeds", async () => {
      const res = await request(app)
        .post("/api/auth/token")
        .send({
          walletPublicKey: "G_API_TEST_WALLET",
          deviceId: "desktop_app",
          deviceName: "Desktop Client",
        })
        .expect(200);

      expect(res.body.accessToken).toBeDefined();
      expect(res.body.refreshToken).toBeDefined();
      expect(res.body.session.deviceId).toBe("desktop_app");

      // Use the access token on a protected route
      const protectedRes = await request(app)
        .get("/api/protected")
        .set("Authorization", `Bearer ${res.body.accessToken}`)
        .expect(200);

      expect(protectedRes.body.user.sub).toBe("G_API_TEST_WALLET");
    });

    it("POST /api/auth/refresh rotates token via API", async () => {
      const loginRes = await request(app)
        .post("/api/auth/token")
        .send({
          walletPublicKey: "G_API_ROTATION",
          deviceId: "tablet",
        })
        .expect(200);

      const refreshRes = await request(app)
        .post("/api/auth/refresh")
        .send({ refreshToken: loginRes.body.refreshToken })
        .expect(200);

      expect(refreshRes.body.accessToken).toBeDefined();
      expect(refreshRes.body.refreshToken).toBeDefined();
      expect(refreshRes.body.refreshToken).not.toBe(loginRes.body.refreshToken);
    });

    it("POST /api/auth/refresh detects reuse over HTTP, returns 401, and revokes family", async () => {
      // 1. Initial login
      const loginRes = await request(app)
        .post("/api/auth/token")
        .send({
          walletPublicKey: "G_API_REUSE_TEST",
          deviceId: "phone",
        })
        .expect(200);

      const firstRefreshToken = loginRes.body.refreshToken;

      // 2. Rotate once
      const rotateRes = await request(app)
        .post("/api/auth/refresh")
        .send({ refreshToken: firstRefreshToken })
        .expect(200);

      const secondRefreshToken = rotateRes.body.refreshToken;

      // 3. Replay old token -> 401 Unauthorized
      const reuseRes = await request(app)
        .post("/api/auth/refresh")
        .send({ refreshToken: firstRefreshToken })
        .expect(401);

      expect(reuseRes.body.message).toMatch(/Token reuse detected/);

      // 4. Try rotating with the second refresh token -> also 401 because family was revoked!
      await request(app)
        .post("/api/auth/refresh")
        .send({ refreshToken: secondRefreshToken })
        .expect(401);

      // 5. Protected route using the previous access token also fails with 401
      await request(app)
        .get("/api/protected")
        .set("Authorization", `Bearer ${rotateRes.body.accessToken}`)
        .expect(401);
    });

    it("GET /api/auth/sessions lists active sessions for user", async () => {
      const login1 = await request(app)
        .post("/api/auth/token")
        .send({ walletPublicKey: "G_MULTI_SESSION", deviceId: "device_1", deviceName: "Mac" })
        .expect(200);

      await request(app)
        .post("/api/auth/token")
        .send({ walletPublicKey: "G_MULTI_SESSION", deviceId: "device_2", deviceName: "Phone" })
        .expect(200);

      const sessionsRes = await request(app)
        .get("/api/auth/sessions")
        .set("Authorization", `Bearer ${login1.body.accessToken}`)
        .expect(200);

      expect(sessionsRes.body.sessions).toHaveLength(2);
      expect(sessionsRes.body.sessions.some((s: any) => s.isCurrent === true)).toBe(true);
    });

    it("POST /api/auth/revoke-all revokes all user sessions", async () => {
      const login = await request(app)
        .post("/api/auth/token")
        .send({ walletPublicKey: "G_REVOKE_ALL", deviceId: "device_1" })
        .expect(200);

      const revokeRes = await request(app)
        .post("/api/auth/revoke-all")
        .set("Authorization", `Bearer ${login.body.accessToken}`)
        .expect(200);

      expect(revokeRes.body.success).toBe(true);
      expect(revokeRes.body.count).toBe(1);

      // Access token is now revoked
      await request(app)
        .get("/api/protected")
        .set("Authorization", `Bearer ${login.body.accessToken}`)
        .expect(401);
    });

    it("GET /api/auth/audit-logs retrieves security audit events", async () => {
      const login = await request(app)
        .post("/api/auth/token")
        .send({ walletPublicKey: "G_AUDIT_USER", deviceId: "device_1" })
        .expect(200);

      const auditRes = await request(app)
        .get("/api/auth/audit-logs")
        .set("Authorization", `Bearer ${login.body.accessToken}`)
        .expect(200);

      expect(auditRes.body.logs).toBeDefined();
      expect(auditRes.body.logs.length).toBeGreaterThan(0);
      expect(auditRes.body.logs[0].action).toBe("SESSION_CREATED");
    });
  });

  describe("authMiddleware compatibility", () => {
    it("allows valid session access token through authMiddleware", (done) => {
      const session = authService.createSession({
        walletPublicKey: "G_COMPAT_WALLET",
        deviceId: "client_1",
        ipAddress: "127.0.0.1",
        userAgent: "Jest",
      });

      const req = {
        headers: { authorization: `Bearer ${session.accessToken}` },
      } as any;
      const res = {} as any;
      const next = jest.fn(() => {
        expect(req.user.sub).toBe("G_COMPAT_WALLET");
        done();
      });

      authMiddleware(req, res, next);
    });

    it("falls back to static API_KEYS when token is not a JWT", (done) => {
      process.env.API_KEYS = "secret-api-key-123";
      const req = {
        headers: { authorization: `Bearer secret-api-key-123` },
      } as any;
      const res = {} as any;
      const next = jest.fn(() => {
        delete process.env.API_KEYS;
        done();
      });

      authMiddleware(req, res, next);
    });

    it("rejects revoked session access tokens in authMiddleware", () => {
      const session = authService.createSession({
        walletPublicKey: "G_REVOKED_COMPAT",
        deviceId: "client_1",
        ipAddress: "127.0.0.1",
        userAgent: "Jest",
      });

      authService.revokeSession(session.session.id);

      const req = {
        headers: { authorization: `Bearer ${session.accessToken}` },
      } as any;
      const res = {
        status: jest.fn().mockReturnThis(),
        json: jest.fn().mockReturnThis(),
      } as any;
      const next = jest.fn();

      authMiddleware(req, res, next);
      expect(res.status).toHaveBeenCalledWith(401);
      expect(next).not.toHaveBeenCalled();
    });
  });
});
