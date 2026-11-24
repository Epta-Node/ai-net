/**
 * Admin Ed25519 challenge-response authentication.
 *
 * Flow:
 *   1. POST /api/admin/auth/challenge  → returns { nonce, expiresAt }
 *   2. Admin signs the nonce with their Ed25519 private key
 *   3. POST /api/admin/auth/verify     → returns { token } (1-hour JWT)
 *   4. All /api/admin/* routes require  Authorization: Bearer <token>
 *
 * Issue #1001
 */

import { Router, Request, Response } from "express";
import { randomBytes, createHmac } from "crypto";
import Database from "better-sqlite3";
import path from "path";
import * as ed from "@noble/ed25519";
import { createLogger } from "../../utils/logger";

const logger = createLogger({ component: "admin-auth" });

// ── Database ─────────────────────────────────────────────────────────────────

let _authDb: Database.Database | null = null;

export function getAuthDb(dbPath?: string): Database.Database {
  if (!_authDb) {
    const filePath = dbPath ?? path.join(process.cwd(), "admin_auth.db");
    _authDb = new Database(filePath);
    _authDb.pragma("journal_mode = WAL");
    _authDb.pragma("busy_timeout = 3000");
    _authDb.exec(`
      CREATE TABLE IF NOT EXISTS admin_challenges (
        nonce      TEXT PRIMARY KEY,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        used       INTEGER NOT NULL DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS admin_audit_log (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        action     TEXT    NOT NULL,
        public_key TEXT,
        ip         TEXT,
        detail     TEXT,
        created_at TEXT    NOT NULL DEFAULT (datetime('now'))
      );
    `);
  }
  return _authDb;
}

export function closeAuthDb(): void {
  _authDb?.close();
  _authDb = null;
}

// ── JWT (manual HS256) ───────────────────────────────────────────────────────

function base64url(buf: Buffer | string): string {
  const b = typeof buf === "string" ? Buffer.from(buf) : buf;
  return b.toString("base64").replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}

function jwtSecret(): string {
  const s = process.env.JWT_SECRET;
  if (!s) throw new Error("JWT_SECRET env var is required");
  return s;
}

export function issueJwt(publicKey: string): string {
  const header = base64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const iat = Math.floor(Date.now() / 1000);
  const exp = iat + 3600; // 1 hour
  const payload = base64url(JSON.stringify({ sub: publicKey, iat, exp, role: "admin" }));
  const sig = base64url(
    createHmac("sha256", jwtSecret())
      .update(`${header}.${payload}`)
      .digest(),
  );
  return `${header}.${payload}.${sig}`;
}

export function verifyJwt(token: string): { sub: string; exp: number } | null {
  try {
    const [header, payload, sig] = token.split(".");
    if (!header || !payload || !sig) return null;
    const expected = base64url(
      createHmac("sha256", jwtSecret())
        .update(`${header}.${payload}`)
        .digest(),
    );
    if (sig !== expected) return null;
    const claims = JSON.parse(Buffer.from(payload, "base64").toString());
    if (Math.floor(Date.now() / 1000) > claims.exp) return null;
    return claims;
  } catch {
    return null;
  }
}

// ── Authorised public keys ────────────────────────────────────────────────────

function authorisedKeys(): Set<string> {
  const raw = process.env.ADMIN_PUBLIC_KEYS ?? "";
  const keys = raw.split(",").map((k) => k.trim()).filter(Boolean);
  return new Set(keys);
}

// ── Audit logging ─────────────────────────────────────────────────────────────

export function auditLog(
  db: Database.Database,
  action: string,
  publicKey: string | null,
  ip: string | null,
  detail?: string,
): void {
  db.prepare(
    "INSERT INTO admin_audit_log (action, public_key, ip, detail) VALUES (?, ?, ?, ?)",
  ).run(action, publicKey ?? null, ip ?? null, detail ?? null);
}

// ── Routes ────────────────────────────────────────────────────────────────────

export function createAdminAuthRouter(db?: Database.Database): Router {
  const router = Router();

  /**
   * @openapi
   * /api/admin/auth/challenge:
   *   post:
   *     summary: Generate a nonce for Ed25519 challenge-response
   *     tags: [Admin Auth]
   *     responses:
   *       200:
   *         description: Nonce and expiry
   */
  router.post("/challenge", (req: Request, res: Response) => {
    const resolvedDb = db ?? getAuthDb();
    const nonce = randomBytes(32).toString("hex");
    const now = Date.now();
    const expiresAt = now + 60_000; // 60 s TTL

    resolvedDb.prepare(
      "INSERT INTO admin_challenges (nonce, created_at, expires_at) VALUES (?, ?, ?)",
    ).run(nonce, now, expiresAt);

    // Evict expired challenges on each call (housekeeping).
    resolvedDb.prepare("DELETE FROM admin_challenges WHERE expires_at < ?").run(now);

    auditLog(resolvedDb, "auth.challenge", null, req.ip ?? null);

    res.json({ nonce, expiresAt: new Date(expiresAt).toISOString() });
  });

  /**
   * @openapi
   * /api/admin/auth/verify:
   *   post:
   *     summary: Verify Ed25519 signature and issue session JWT
   *     tags: [Admin Auth]
   *     requestBody:
   *       required: true
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *             required: [nonce, signature, publicKey]
   *             properties:
   *               nonce:      { type: string }
   *               signature:  { type: string }
   *               publicKey:  { type: string }
   *     responses:
   *       200:
   *         description: JWT token
   *       401:
   *         description: Invalid nonce, signature or expired
   *       403:
   *         description: Public key not authorised
   */
  router.post("/verify", async (req: Request, res: Response) => {
    const resolvedDb = db ?? getAuthDb();
    const { nonce, signature, publicKey } = req.body ?? {};

    if (!nonce || !signature || !publicKey) {
      res.status(400).json({ error: "nonce, signature, and publicKey are required" });
      return;
    }

    const now = Date.now();

    // Fetch and validate the nonce record.
    const record = resolvedDb.prepare(
      "SELECT * FROM admin_challenges WHERE nonce = ?",
    ).get(nonce) as { nonce: string; expires_at: number; used: number } | undefined;

    if (!record) {
      auditLog(resolvedDb, "auth.failed.unknown_nonce", publicKey, req.ip ?? null);
      res.status(401).json({ error: "Invalid nonce" });
      return;
    }

    if (record.used) {
      auditLog(resolvedDb, "auth.failed.nonce_reuse", publicKey, req.ip ?? null);
      res.status(401).json({ error: "Nonce already used" });
      return;
    }

    if (record.expires_at < now) {
      auditLog(resolvedDb, "auth.failed.nonce_expired", publicKey, req.ip ?? null);
      res.status(401).json({ error: "NonceExpired" });
      return;
    }

    // Check public key is authorised.
    if (!authorisedKeys().has(publicKey)) {
      auditLog(resolvedDb, "auth.failed.unauthorized_key", publicKey, req.ip ?? null);
      res.status(403).json({ error: "Forbidden" });
      return;
    }

    // Verify Ed25519 signature: message = nonce as utf-8 bytes.
    try {
      const msgBytes = Buffer.from(nonce, "utf8");
      const sigBytes = Buffer.from(signature, "hex");
      const keyBytes = Buffer.from(publicKey, "hex");

      const valid = await ed.verifyAsync(sigBytes, msgBytes, keyBytes);
      if (!valid) {
        auditLog(resolvedDb, "auth.failed.invalid_signature", publicKey, req.ip ?? null);
        res.status(401).json({ error: "Invalid signature" });
        return;
      }
    } catch (err) {
      logger.warn({ err }, "Ed25519 verification error");
      auditLog(resolvedDb, "auth.failed.verify_error", publicKey, req.ip ?? null);
      res.status(401).json({ error: "Signature verification failed" });
      return;
    }

    // Mark nonce as used (single-use guarantee).
    resolvedDb.prepare("UPDATE admin_challenges SET used = 1 WHERE nonce = ?").run(nonce);

    // Issue JWT.
    let token: string;
    try {
      token = issueJwt(publicKey);
    } catch {
      res.status(500).json({ error: "JWT_SECRET not configured" });
      return;
    }

    auditLog(resolvedDb, "auth.login", publicKey, req.ip ?? null);
    logger.info({ publicKey }, "admin login successful");

    res.json({ token });
  });

  return router;
}
