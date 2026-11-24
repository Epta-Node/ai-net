/**
 * Per-wallet daily quotas for task submissions and Venice token spend
 * (Issue #803).
 *
 * Two budgets, one store, one enforcement point:
 *
 *  • `MAX_DAILY_TASKS_PER_WALLET` — how many task submissions a wallet may
 *    make in the trailing 24 hours. Counted from *submission attempts* in
 *    `wallet_quota_events` (kind `task`), so a request rejected downstream by
 *    the legacy `DAILY_TASK_LIMIT_PER_WALLET` check still shows up here: two
 *    limiters that count different things give operators two different truths.
 *  • `MAX_DAILY_VENICE_TOKENS_PER_WALLET` — how many provider tokens a wallet
 *    may consume in the trailing 24 hours. Token events (kind `tokens`) are
 *    recorded once per settled task from the budget ledger
 *    (`services/budget/persistence.ts`), which already knows both the wallet
 *    and the final spend.
 *
 * `wallet_quota_events` lives in `tasks.db` — the same handle `dailyQuota`
 * and the quota metrics source already read — so one connection answers
 * "tasks used", "tokens spent" and the gauges that display them.
 *
 * Both limits are trailing 24-hour windows rolled per event, so there is no
 * single "reset moment"; `resetAt` reports the next UTC midnight, which is
 * when the oldest possible in-window event ages out for practical purposes.
 */

import type Database from 'better-sqlite3';
import { getTaskDb } from '../../db/tasks';
import { getConfig } from '../../config';
import { QuotaExceededError } from '../../errors';
import { quotaMetricsRegistry, QUOTA_WINDOW_MS } from './metrics';
import { ANONYMOUS_WALLET } from './dailyQuota';

/** Event kinds stored in `wallet_quota_events`. */
export type WalletQuotaEventKind = 'task' | 'tokens';

/** Result of evaluating a wallet's quota, whether or not it rejected. */
export interface WalletQuotaCheck {
  /** Configured task limit; `0` means the quota is disabled. */
  limit: number;
  /** Task submissions the wallet made in the trailing window. */
  used: number;
  /** Tasks the wallet may still submit, clamped at 0. */
  remaining: number;
  /** Configured Venice token limit; `0` means the quota is disabled. */
  tokenLimit: number;
  /** Venice tokens the wallet consumed in the trailing window. */
  tokenUsed: number;
  /** Next UTC midnight — the practical reset point of the daily window. */
  resetAt: string;
  /** True when neither quota applied (disabled, or an unidentified wallet). */
  disabled: boolean;
  /** True when the wallet is at or over either enabled limit. */
  rejected: boolean;
}

/** The `{ used, limit, resetAt }` contract of `GET /quota`. */
export interface WalletQuotaStatus {
  used: number;
  limit: number;
  resetAt: string;
}

export interface WalletQuotaOptions {
  /** Override `MAX_DAILY_TASKS_PER_WALLET`. */
  taskLimit?: number;
  /** Override `MAX_DAILY_VENICE_TOKENS_PER_WALLET`. */
  tokenLimit?: number;
  /** Injected clock, for tests. */
  now?: () => number;
}

/** Schema handles already migrated, so a hot path pays no DDL per request. */
const ensured = new WeakSet<object>();

/**
 * Create `wallet_quota_events` if it does not exist.
 *
 * Idempotent, keyed on the handle: `tasks.db` has no migration runner (its
 * schema is applied with the same inline `CREATE ... IF NOT EXISTS` pattern in
 * `db/tasks.ts`), and a test that swaps in a fresh in-memory handle gets the
 * table by calling this — which every accessor below does automatically.
 */
export function ensureWalletQuotaSchema(db: Database.Database = getTaskDb()): void {
  if (ensured.has(db)) return;
  db.exec(`
    CREATE TABLE IF NOT EXISTS wallet_quota_events (
      id     INTEGER PRIMARY KEY AUTOINCREMENT,
      walletPublicKey TEXT NOT NULL,
      kind   TEXT NOT NULL CHECK (kind IN ('task','tokens')),
      units  INTEGER NOT NULL DEFAULT 1,
      createdAt TEXT NOT NULL
    )
  `);
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_wallet_quota_events_wallet_kind_created
      ON wallet_quota_events (walletPublicKey, kind, createdAt DESC)
  `);
  ensured.add(db);
}

function quotaDb(): Database.Database {
  const db = getTaskDb();
  ensureWalletQuotaSchema(db);
  return db;
}

/** The configured task limit. `0` disables the quota. */
export function maxDailyTasksPerWallet(): number {
  return positiveInt(getConfig().MAX_DAILY_TASKS_PER_WALLET);
}

/** The configured Venice token limit. `0` disables the quota. */
export function maxDailyVeniceTokensPerWallet(): number {
  return positiveInt(getConfig().MAX_DAILY_VENICE_TOKENS_PER_WALLET);
}

function positiveInt(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

function windowStartIso(now: number): string {
  return new Date(now - QUOTA_WINDOW_MS).toISOString();
}

/** Next UTC midnight — the daily reset point reported to clients. */
function nextMidnightIso(now: number): string {
  const d = new Date(now);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1)).toISOString();
}

function secondsUntil(resetAtIso: string, now: number): number {
  return Math.max(0, Math.ceil((Date.parse(resetAtIso) - now) / 1000));
}

function countEvents(
  db: Database.Database,
  wallet: string,
  kind: WalletQuotaEventKind,
  since: string
): number {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS n FROM wallet_quota_events
        WHERE walletPublicKey = ? AND kind = ? AND createdAt > ?`
    )
    .get(wallet, kind, since) as { n: number } | undefined;
  return Number(row?.n) || 0;
}

function sumUnits(
  db: Database.Database,
  wallet: string,
  kind: WalletQuotaEventKind,
  since: string
): number {
  const row = db
    .prepare(
      `SELECT COALESCE(SUM(units), 0) AS total FROM wallet_quota_events
        WHERE walletPublicKey = ? AND kind = ? AND createdAt > ?`
    )
    .get(wallet, kind, since) as { total: number } | undefined;
  return Number(row?.total) || 0;
}

function insertEvent(
  db: Database.Database,
  wallet: string,
  kind: WalletQuotaEventKind,
  units: number,
  createdAt: string
): void {
  db.prepare(
    `INSERT INTO wallet_quota_events (walletPublicKey, kind, units, createdAt)
     VALUES (?, ?, ?, ?)`
  ).run(wallet, kind, units, createdAt);
}

/** Evaluate both quotas without rejecting or recording anything. */
export function checkWalletQuota(
  walletPublicKey: string,
  options: WalletQuotaOptions = {}
): WalletQuotaCheck {
  const now = (options.now ?? (() => Date.now()))();
  const taskLimit = positiveInt(options.taskLimit ?? maxDailyTasksPerWallet());
  const tokenLimit = positiveInt(options.tokenLimit ?? maxDailyVeniceTokensPerWallet());
  const resetAt = nextMidnightIso(now);

  const disabled = walletPublicKey === ANONYMOUS_WALLET || (taskLimit <= 0 && tokenLimit <= 0);
  if (disabled) {
    return {
      limit: taskLimit,
      used: 0,
      remaining: Number.POSITIVE_INFINITY,
      tokenLimit,
      tokenUsed: 0,
      resetAt,
      disabled: true,
      rejected: false,
    };
  }

  const since = windowStartIso(now);
  const db = quotaDb();
  const used = taskLimit > 0 ? countEvents(db, walletPublicKey, 'task', since) : 0;
  const tokenUsed = tokenLimit > 0 ? sumUnits(db, walletPublicKey, 'tokens', since) : 0;

  return {
    limit: taskLimit,
    used,
    remaining: taskLimit > 0 ? Math.max(0, taskLimit - used) : Number.POSITIVE_INFINITY,
    tokenLimit,
    tokenUsed,
    resetAt,
    disabled: false,
    rejected: (taskLimit > 0 && used >= taskLimit) || (tokenLimit > 0 && tokenUsed >= tokenLimit),
  };
}

/**
 * Enforce both quotas, throwing a {@link QuotaExceededError} when the wallet
 * is spent.
 *
 * A rejection is also counted in the task-quota rejection metrics (the band
 * the wallet was in), recorded before the throw so the count survives the
 * error path.
 */
export function assertWalletQuota(
  walletPublicKey: string,
  options: WalletQuotaOptions & { correlationId?: string } = {}
): WalletQuotaCheck {
  const check = checkWalletQuota(walletPublicKey, options);
  if (!check.rejected) return check;

  const overTokens = check.tokenLimit > 0 && check.tokenUsed >= check.tokenLimit;
  const resource = overTokens ? 'tokens' : 'tasks';
  const used = overTokens ? check.tokenUsed : check.used;
  const limit = overTokens ? check.tokenLimit : check.limit;

  try {
    quotaMetricsRegistry().recordQuotaRejection({
      usedTasks: check.used,
      limit: check.limit,
    });
  } catch {
    // Telemetry is observability, not enforcement.
  }

  throw new QuotaExceededError(
    resource === 'tokens'
      ? `Venice token quota reached (max ${limit} per 24 hours)`
      : `Task submission quota reached (max ${limit} per 24 hours)`,
    {
      resource,
      used,
      limit,
      resetAt: check.resetAt,
      retryAfterSeconds: secondsUntil(check.resetAt, (options.now ?? (() => Date.now()))()),
    },
    options.correlationId
  );
}

/**
 * Check both quotas and, when the wallet still has headroom, record one task
 * submission event.
 *
 * The single call the POST /tasks middleware makes: check first so a rejected
 * wallet never inflates its own count, record only what was admitted.
 */
export function checkAndConsumeTask(
  walletPublicKey: string,
  options: WalletQuotaOptions & { correlationId?: string } = {}
): WalletQuotaCheck {
  const check = assertWalletQuota(walletPublicKey, options);
  if (walletPublicKey !== ANONYMOUS_WALLET) {
    const now = (options.now ?? (() => Date.now()))();
    insertEvent(quotaDb(), walletPublicKey, 'task', 1, new Date(now).toISOString());
  }
  return check;
}

/**
 * Record Venice tokens consumed on behalf of a wallet.
 *
 * Called once per settled task from the budget ledger. Best-effort by design —
 * a database hiccup must not fail a run that already spent real money — but
 * the caller (`settleTaskCost`) also wraps this, so throwing here is safe.
 */
export function recordWalletTokenSpend(
  walletPublicKey: string,
  tokens: number,
  options: WalletQuotaOptions = {}
): void {
  if (!walletPublicKey || walletPublicKey === ANONYMOUS_WALLET) return;
  const units = Math.ceil(Number(tokens));
  if (!Number.isFinite(units) || units <= 0) return;
  const now = (options.now ?? (() => Date.now()))();
  insertEvent(quotaDb(), walletPublicKey, 'tokens', units, new Date(now).toISOString());
}

/** The `{ used, limit, resetAt }` contract of `GET /quota` (task dimension). */
export function getWalletQuotaStatus(
  walletPublicKey: string,
  options: WalletQuotaOptions = {}
): WalletQuotaStatus {
  const check = checkWalletQuota(walletPublicKey, options);
  return { used: check.used, limit: check.limit, resetAt: check.resetAt };
}

/**
 * Enforce `MAX_PROMPT_CHARS_PER_REQUEST`, when configured.
 *
 * A character budget is a cheap first line of defence: it rejects a prompt
 * that could never fit a token budget before any database or metrics work
 * happens. Disabled (`0` / unset) by default — the Zod schema's
 * `MAX_PROMPT_LENGTH` remains the effective cap until an operator opts in.
 */
export function assertPromptWithinQuota(
  prompt: string,
  options: { promptCharLimit?: number } = {}
): void {
  const limit = positiveInt(options.promptCharLimit ?? getConfig().MAX_PROMPT_CHARS_PER_REQUEST);
  if (limit <= 0) return;
  if (prompt.length <= limit) return;
  throw new QuotaExceededError(`Prompt exceeds the ${limit}-character limit`, {
    resource: 'promptChars',
    used: prompt.length,
    limit,
    retryAfterSeconds: 60,
  });
}

/** Test hook: drop every recorded event (the schema survives). */
export function resetForTesting(): void {
  quotaDb().prepare('DELETE FROM wallet_quota_events').run();
}
