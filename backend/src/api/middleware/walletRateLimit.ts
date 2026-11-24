/**
 * Per-wallet sliding window rate limiter with daily quota.
 *
 * Uses SQLite for persistence so limits survive restarts and work correctly
 * across multiple process instances sharing the same DB file.
 *
 * Limits (per wallet public key):
 *   - 10 task submissions per 60 s   (enforced on POST /api/tasks)
 *   - 500 total API requests per 60 s (enforced on all /api/* routes)
 *   - 50 task submissions per UTC calendar day
 *
 * Issue #999
 */

import Database from "better-sqlite3";
import type { Request, Response, NextFunction } from "express";
import path from "path";
import { createLogger } from "../../utils/logger";

const logger = createLogger({ component: "wallet-rate-limiter" });

// ── Database bootstrap ───────────────────────────────────────────────────────

let _db: Database.Database | null = null;

export function getRateLimitDb(dbPath?: string): Database.Database {
  if (!_db) {
    const filePath = dbPath ?? path.join(process.cwd(), "rate_limits.db");
    _db = new Database(filePath);
    _db.pragma("journal_mode = WAL");
    _db.pragma("busy_timeout = 3000");
    _db.exec(`
      CREATE TABLE IF NOT EXISTS rate_limit_events (
        wallet     TEXT NOT NULL,
        event_type TEXT NOT NULL DEFAULT 'api',
        ts         INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_rle_wallet_type_ts
        ON rate_limit_events (wallet, event_type, ts);

      CREATE TABLE IF NOT EXISTS daily_quotas (
        wallet    TEXT NOT NULL,
        utc_day   TEXT NOT NULL,
        task_count INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (wallet, utc_day)
      );
    `);
    logger.info({ dbPath: filePath }, "rate-limit database opened");
  }
  return _db;
}

export function closeRateLimitDb(): void {
  _db?.close();
  _db = null;
}

// ── Core logic ───────────────────────────────────────────────────────────────

const WINDOW_MS = 60_000;
const MAX_TASK_SUBMISSIONS_PER_WINDOW = 10;
const MAX_API_REQUESTS_PER_WINDOW = 500;
const MAX_TASKS_PER_DAY = 50;

function utcDay(): string {
  return new Date().toISOString().slice(0, 10); // "YYYY-MM-DD"
}

interface QuotaInfo {
  requestsRemaining: number;
  tasksRemainingToday: number;
  resetAtUTC: string;
}

/**
 * Records an event and checks whether the wallet has exceeded the sliding
 * window or daily limit.
 *
 * Returns `null` when the request is allowed, or an object describing the
 * limit breach when it should be blocked.
 */
function checkAndRecord(
  db: Database.Database,
  wallet: string,
  eventType: "api" | "task",
): { allowed: boolean; retryAfter: number; resetTimestamp: number } | null {
  const now = Date.now();
  const cutoff = now - WINDOW_MS;
  const today = utcDay();

  // ── Evict stale entries for this wallet ──────────────────────────────────
  db.prepare(
    "DELETE FROM rate_limit_events WHERE wallet = ? AND ts < ?",
  ).run(wallet, cutoff);

  // ── Sliding-window checks ────────────────────────────────────────────────
  const maxForType =
    eventType === "task"
      ? MAX_TASK_SUBMISSIONS_PER_WINDOW
      : MAX_API_REQUESTS_PER_WINDOW;

  const countInWindow = (
    db
      .prepare(
        "SELECT COUNT(*) as cnt FROM rate_limit_events WHERE wallet = ? AND event_type = ? AND ts > ?",
      )
      .get(wallet, eventType, cutoff) as { cnt: number }
  ).cnt;

  if (countInWindow >= maxForType) {
    // Find the oldest event timestamp in the window to compute Retry-After.
    const oldest = (
      db
        .prepare(
          "SELECT MIN(ts) as oldest FROM rate_limit_events WHERE wallet = ? AND event_type = ? AND ts > ?",
        )
        .get(wallet, eventType, cutoff) as { oldest: number | null }
    ).oldest ?? now;

    const resetTimestamp = Math.ceil((oldest + WINDOW_MS) / 1000);
    const retryAfter = Math.max(1, resetTimestamp - Math.floor(now / 1000));
    return { allowed: false, retryAfter, resetTimestamp };
  }

  // ── Daily quota check (tasks only) ──────────────────────────────────────
  if (eventType === "task") {
    const row = db
      .prepare("SELECT task_count FROM daily_quotas WHERE wallet = ? AND utc_day = ?")
      .get(wallet, today) as { task_count: number } | undefined;

    const todayCount = row?.task_count ?? 0;
    if (todayCount >= MAX_TASKS_PER_DAY) {
      // Reset at midnight UTC.
      const tomorrowMidnight = new Date(today);
      tomorrowMidnight.setUTCDate(tomorrowMidnight.getUTCDate() + 1);
      const resetTimestamp = Math.floor(tomorrowMidnight.getTime() / 1000);
      const retryAfter = Math.max(1, resetTimestamp - Math.floor(now / 1000));
      return { allowed: false, retryAfter, resetTimestamp };
    }

    // Increment daily counter.
    db.prepare(`
      INSERT INTO daily_quotas (wallet, utc_day, task_count)
      VALUES (?, ?, 1)
      ON CONFLICT(wallet, utc_day) DO UPDATE SET task_count = task_count + 1
    `).run(wallet, today);
  }

  // ── Record the event ─────────────────────────────────────────────────────
  db.prepare(
    "INSERT INTO rate_limit_events (wallet, event_type, ts) VALUES (?, ?, ?)",
  ).run(wallet, eventType, now);

  return null; // allowed
}

// ── Middleware factory ───────────────────────────────────────────────────────

function extractWallet(req: Request): string | null {
  // Convention: wallet public key in X-Wallet-Address header or
  // walletPublicKey query param.
  return (
    (req.headers["x-wallet-address"] as string | undefined) ??
    (req.query.walletPublicKey as string | undefined) ??
    null
  );
}

export function createWalletRateLimitMiddleware(
  eventType: "api" | "task",
  db?: Database.Database,
) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const wallet = extractWallet(req);
    if (!wallet) {
      // No wallet header — fall through; IP-based limiter handles these.
      next();
      return;
    }

    const resolvedDb = db ?? getRateLimitDb();
    const breach = checkAndRecord(resolvedDb, wallet, eventType);

    if (breach) {
      res.setHeader("Retry-After", String(breach.retryAfter));
      res.setHeader("X-RateLimit-Reset", String(breach.resetTimestamp));
      res.status(429).json({
        error: {
          message:
            eventType === "task"
              ? "Task submission rate limit exceeded"
              : "API request rate limit exceeded",
          code: "WALLET_RATE_LIMITED",
        },
      });
      return;
    }

    next();
  };
}

/** Middleware for POST /api/tasks — 10 task submissions per 60 s. */
export const walletTaskRateLimitMiddleware =
  createWalletRateLimitMiddleware("task");

/** Middleware for all /api/* routes — 500 requests per 60 s. */
export const walletApiRateLimitMiddleware =
  createWalletRateLimitMiddleware("api");

// ── Quota API helpers ────────────────────────────────────────────────────────

export function getWalletQuota(
  wallet: string,
  db?: Database.Database,
): QuotaInfo {
  const resolvedDb = db ?? getRateLimitDb();
  const now = Date.now();
  const cutoff = now - WINDOW_MS;
  const today = utcDay();

  // Evict stale events first.
  resolvedDb
    .prepare("DELETE FROM rate_limit_events WHERE wallet = ? AND ts < ?")
    .run(wallet, cutoff);

  const apiCount = (
    resolvedDb
      .prepare(
        "SELECT COUNT(*) as cnt FROM rate_limit_events WHERE wallet = ? AND event_type = 'api' AND ts > ?",
      )
      .get(wallet, cutoff) as { cnt: number }
  ).cnt;

  const taskRow = resolvedDb
    .prepare("SELECT task_count FROM daily_quotas WHERE wallet = ? AND utc_day = ?")
    .get(wallet, today) as { task_count: number } | undefined;

  const tasksTodayUsed = taskRow?.task_count ?? 0;

  const tomorrowMidnight = new Date(today);
  tomorrowMidnight.setUTCDate(tomorrowMidnight.getUTCDate() + 1);

  return {
    requestsRemaining: Math.max(0, MAX_API_REQUESTS_PER_WINDOW - apiCount),
    tasksRemainingToday: Math.max(0, MAX_TASKS_PER_DAY - tasksTodayUsed),
    resetAtUTC: tomorrowMidnight.toISOString(),
  };
}

export function resetWalletDailyQuota(
  wallet: string,
  db?: Database.Database,
): void {
  const resolvedDb = db ?? getRateLimitDb();
  const today = utcDay();
  resolvedDb
    .prepare(
      "DELETE FROM daily_quotas WHERE wallet = ? AND utc_day = ?",
    )
    .run(wallet, today);
  resolvedDb
    .prepare(
      "DELETE FROM rate_limit_events WHERE wallet = ?",
    )
    .run(wallet);
  logger.info({ wallet }, "daily quota reset");
}
