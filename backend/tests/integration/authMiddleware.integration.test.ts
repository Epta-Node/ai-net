import express from "express";
import request from "supertest";
import crypto from "crypto";
import { authMiddleware, sessionAuthMiddleware } from "../../src/api/middleware/auth";
import {
  AuthService,
  resetAuthService,
  setAuthService,
} from "../../src/services/auth/authService";
import { TokenService } from "../../src/services/auth/tokenService";
import { RevocationRegistry } from "../../src/services/auth/revocationRegistry";
import { verifyWalletSignature } from "../../src/services/auth/walletChallenge";

type FakeSession = {
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
};

function createFakeAuthDb() {
  const sessions = new Map<string, FakeSession>();
  return {
    createSession: jest.fn((session: FakeSession) => {
      sessions.set(session.id, { ...session });
    }),
    createRefreshToken: jest.fn(),
    insertAuditLog: jest.fn(),
    findRefreshTokenByHash: jest.fn(),
    revokeFamily: jest.fn(),
    revokeTokensByFamily: jest.fn(),
    markTokenConsumed: jest.fn(),
    revokeSession: jest.fn(),
    revokeTokensBySession: jest.fn(),
    findSessionById: jest.fn((sessionId: string) => sessions.get(sessionId)),
    updateSessionActivity: jest.fn(),
    revokeAllUserSessions: jest.fn(),
    revokeTokensByUser: jest.fn(),
    listActiveSessions: jest.fn(() => []),
    listAuditLogs: jest.fn(() => []),
    _sessions: sessions,
  };
}

function buildApp(service: AuthService) {
  setAuthService(service);

  const app = express();
  app.get("/protected", authMiddleware, (req, res) => {
    res.status(200).json({
      ok: true,
      wallet: (req as any).user?.sub ?? null,
      sessionId: (req as any).user?.sessionId ?? null,
    });
  });
  app.get("/session-only", sessionAuthMiddleware, (req, res) => {
    res.status(200).json({ ok: true, wallet: (req as any).user?.sub ?? null });
  });
  // Error handler to surface middleware errors in tests.
  app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(err?.statusCode || 500).json({ error: err?.message || "internal" });
  });
  return app;
}

describe("Auth middleware integration (Issue #907)", () => {
  const walletPublicKey = "GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN7";
  let service: AuthService;
  let fakeDb: ReturnType<typeof createFakeAuthDb>;
  let tokenService: TokenService;

  beforeEach(() => {
    process.env.API_KEYS = "";
    fakeDb = createFakeAuthDb();
    tokenService = new TokenService({
      jwtSecret: "test-jwt-secret-for-integration-tests",
      accessTtlSeconds: 900,
      refreshTtlSeconds: 3600,
      sessionMaxTtlSeconds: 86400,
    });
    service = new AuthService({
      authDb: fakeDb as any,
      tokenService,
      revocationRegistry: new RevocationRegistry(),
    });
  });

  afterEach(() => {
    resetAuthService();
    jest.restoreAllMocks();
  });

  it("authenticates a valid access token", async () => {
    const app = buildApp(service);
    const session = service.createSession({
      walletPublicKey,
      deviceId: "device-1",
      deviceName: "Test Device",
      ipAddress: "127.0.0.1",
      userAgent: "jest",
    });

    const res = await request(app)
      .get("/protected")
      .set("Authorization", `Bearer ${session.accessToken}`);

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.wallet).toBe(walletPublicKey);
    expect(res.body.sessionId).toBe(session.session.id);
  });

  it("rejects an expired access token", async () => {
    const app = buildApp(service);
    const session = service.createSession({
      walletPublicKey,
      deviceId: "device-expired",
      ipAddress: "127.0.0.1",
      userAgent: "jest",
    });

    const now = Math.floor(Date.now() / 1000);
    jest.spyOn(Date, "now").mockReturnValue((now + 3600) * 1000);

    const res = await request(app)
      .get("/protected")
      .set("Authorization", `Bearer ${session.accessToken}`);

    expect(res.status).toBe(401);
    expect(String(res.body.error)).toMatch(/invalid|expired|unauthorized/i);
  });

  it("rejects missing authorization header when auth is required by session middleware", async () => {
    const app = buildApp(service);

    const res = await request(app).get("/session-only");

    expect(res.status).toBe(401);
    expect(res.body).toMatchObject({
      error: "Unauthorized",
      message: "Missing Authorization header",
    });
  });

  it("rejects invalid token format", async () => {
    const app = buildApp(service);

    const res = await request(app)
      .get("/protected")
      .set("Authorization", "Bearer not-a-jwt-token");

    expect(res.status).toBe(401);
    expect(String(res.body.error)).toMatch(/invalid|expired/i);
  });

  it("verifies wallet signature verification flow", () => {
    // Invalid signature/key material should be rejected.
    expect(verifyWalletSignature("not-a-stellar-key", "nonce", "c2ln")).toBe(false);
    expect(verifyWalletSignature("", "nonce", "")).toBe(false);

    // Valid flow: sign a challenge with a real Ed25519 keypair and verify it.
    const { Keypair } = require("@stellar/stellar-sdk");
    const keypair = Keypair.random();
    const challenge = `ai-net:auth:${crypto.randomUUID()}`;
    const signature = keypair.sign(Buffer.from(challenge)).toString("base64");

    expect(verifyWalletSignature(keypair.publicKey(), challenge, signature)).toBe(true);
    expect(verifyWalletSignature(keypair.publicKey(), "different-challenge", signature)).toBe(false);
  });
});
