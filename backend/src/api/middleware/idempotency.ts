/**
 * IdempotencyMiddleware — Issue #1003
 *
 * Applies to: POST /api/tasks, POST /api/agents/register, POST /api/admin/dlq/:id/replay
 *
 * When an `Idempotency-Key` header is present on a mutating POST request:
 *   - Validates the key is a UUID v4; rejects with 400 otherwise.
 *   - Checks the SQLite idempotency_cache table for a matching (key, walletPublicKey) row.
 *   - If a completed record exists it replays the stored response without re-executing.
 *   - If a record is in_progress it returns 409 Processing.
 *   - If no record exists it inserts one (in_progress), executes the downstream handler,
 *     then stores the response body + status as completed.
 *
 * Keys expire after 24 hours. A background purge runs every 6 hours.
 */
import type { Request, Response, NextFunction } from "express";
import Database from "better-sqlite3";
import path from "path";
import { createLogger } from "../../utils/logger";

const log = createLogger({ component: "idempotency" });

// ── UUID v4 regex ─────────────────────────────────────────────────────────────
const UUID_V4_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
const PURGE_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6 hours

// ── Database singleton ────────────────────────────────────────────────────────

let _db: Database.Database | null = null;

export function getIdempotencyDb(dbPath?: string): Database.Database {
  if (!_db) {
    const filePath = dbPath ?? path.join(process.cwd(), "idempotency.db");
    _db = new Database(filePath);
    _db.pragma("journal_mode = WAL");
    _db.pragma("busy_timeout = 5000");
    _db.exec(`
      CREATE TABLE IF NOT EXISTS idempotency_cache (
        key              TEXT    NOT NULL,
        walletPublicKey  TEXT    NOT NULL DEFAULT '',
        status           TEXT    NOT NULL DEFAULT 'in_progress',
        statusCode       INTEGER,
        responseBody     TEXT,
        createdAt        INTEGER NOT NULL,
        PRIMARY KEY (key, walletPublicKey)
      );
      CREATE INDEX IF NOT EXISTS idx_idempotency_key_wallet
        ON idempotency_cache (key, walletPublicKey);
    `);
    log.info({ dbPath: filePath }, "idempotency database opened");

    // Background purge
    const purge = (): void => {
      const cutoff = Date.now() - TTL_MS;
      const deleted = _db!.prepare(
        "DELETE FROM idempotency_cache WHERE createdAt < ?",
      ).run(cutoff);
      if (deleted.changes > 0) {
        log.info({ deleted: deleted.changes }, "purged expired idempotency keys");
      }
    };
    setInterval(purge, PURGE_INTERVAL_MS).unref();
  }
  return _db;
}

export function closeIdempotencyDb(): void {
  _db?.close();
  _db = null;
}

// ── Middleware ────────────────────────────────────────────────────────────────

export function idempotencyMiddleware(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const key = req.headers["idempotency-key"] as string | undefined;

  // No key → pass through (idempotency is optional)
  if (!key) {
    return next();
  }

  // Validate UUID v4 format
  if (!UUID_V4_RE.test(key)) {
    res.status(400).json({
      error: "InvalidIdempotencyKey",
      message: "Idempotency-Key must be a valid UUID v4",
    });
    return;
  }

  const walletPublicKey =
    (req.headers["x-wallet-public-key"] as string | undefined) ?? "";

  const db = getIdempotencyDb();
  const now = Date.now();
  const cutoff = now - TTL_MS;

  // Look up existing record (not expired)
  const existing = db
    .prepare(
      `SELECT status, statusCode, responseBody
       FROM idempotency_cache
       WHERE key = ? AND walletPublicKey = ? AND createdAt >= ?`,
    )
    .get(key, walletPublicKey, cutoff) as
    | { status: string; statusCode: number | null; responseBody: string | null }
    | undefined;

  if (existing) {
    if (existing.status === "completed") {
      // Replay the original response
      const statusCode = existing.statusCode ?? 200;
      const body = existing.responseBody
        ? JSON.parse(existing.responseBody)
        : {};
      res.setHeader("Idempotency-Replay", "true");
      res.status(statusCode).json(body);
      return;
    }

    if (existing.status === "in_progress") {
      res.status(409).json({
        error: "Processing",
        message: "A request with this Idempotency-Key is already being processed",
      });
      return;
    }
  }

  // Insert in_progress record (upsert — handles race conditions gracefully)
  db.prepare(`
    INSERT INTO idempotency_cache (key, walletPublicKey, status, createdAt)
    VALUES (?, ?, 'in_progress', ?)
    ON CONFLICT (key, walletPublicKey) DO NOTHING
  `).run(key, walletPublicKey, now);

  // Intercept res.json to capture the response
  const originalJson = res.json.bind(res);
  res.json = function (body: unknown) {
    try {
      db.prepare(`
        UPDATE idempotency_cache
        SET status = 'completed', statusCode = ?, responseBody = ?
        WHERE key = ? AND walletPublicKey = ?
      `).run(
        res.statusCode,
        JSON.stringify(body),
        key,
        walletPublicKey,
      );
    } catch (err) {
      log.error({ err }, "failed to persist idempotency response");
    }
    return originalJson(body);
  };

  next();
}
