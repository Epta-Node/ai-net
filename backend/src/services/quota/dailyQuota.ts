/**
 * Single enforcement point for `DAILY_TASK_LIMIT_PER_WALLET` (Issue #738).
 *
 * The three task routers (`/api/tasks`, `/v1/tasks`, `/v2/tasks`) each grew their
 * own copy of the same twelve lines. That was harmless until an operator needed
 * to know how close wallets were to the ceiling: three copies meant three places
 * to add telemetry, and a copy that got missed looked exactly like a wallet that
 * never hit the limit. One helper, one metric hook, one behaviour.
 */

import { getTaskDb, createTaskDb } from '../../db/tasks';
import { getConfig } from '../../config';
import { RateLimitError } from '../../errors';
import { createLogger } from '../../utils/logger';
import { quotaMetricsRegistry } from './metrics';
import { QUOTA_WINDOW_MS } from './metrics';

const log = createLogger({ component: 'quota' });

/** The wallet placeholder used when a request carries no wallet identity. */
export const ANONYMOUS_WALLET = 'anonymous';

/** Result of a quota evaluation, whether or not it rejected. */
export interface DailyQuotaCheck {
  /** Configured limit; `0` means the quota is disabled. */
  limit: number;
  /** Tasks the wallet already has in the trailing window. */
  used: number;
  /** Tasks the wallet may still submit, clamped at 0. */
  remaining: number;
  /** True when no quota was applied (disabled, or an unidentified wallet). */
  disabled: boolean;
  /** True when {@link assertDailyTaskQuota} rejected the request. */
  rejected: boolean;
}

export interface DailyQuotaOptions {
  /** Override the configured limit. Defaults to `DAILY_TASK_LIMIT_PER_WALLET`. */
  limit?: number;
  /** Trailing window in milliseconds. Defaults to 24 hours. */
  windowMs?: number;
  /** Injected clock, for tests. */
  now?: () => number;
}

/** The configured daily task limit. `0` disables the quota. */
export function dailyTaskLimit(): number {
  const configured = getConfig().DAILY_TASK_LIMIT_PER_WALLET;
  return Number.isFinite(configured) && configured > 0 ? Math.floor(configured) : 0;
}

/**
 * Tasks this wallet created inside the trailing window.
 *
 * The same `createdAfter` / `walletPublicKey` pair the original inline check
 * used, so the count an operator sees in the gauges is the count the
 * enforcement path actually compared against the limit.
 */
export function walletTasksInWindow(
  walletPublicKey: string,
  windowMs: number = QUOTA_WINDOW_MS,
  now: () => number = () => Date.now(),
): number {
  const db = createTaskDb(getTaskDb());
  const since = new Date(now() - windowMs).toISOString();
  const { total } = db.list(walletPublicKey, 1, 1, { createdAfter: since });
  return total;
}

/** Evaluate the quota without rejecting anything. */
export function checkDailyTaskQuota(
  walletPublicKey: string,
  options: DailyQuotaOptions = {},
): DailyQuotaCheck {
  const limit = options.limit ?? dailyTaskLimit();
  const disabled = limit <= 0 || walletPublicKey === ANONYMOUS_WALLET;

  // An unidentified or uncapped wallet costs nothing to evaluate: skip the
  // query entirely rather than paying for a count nobody will read.
  if (disabled) {
    return { limit, used: 0, remaining: Number.POSITIVE_INFINITY, disabled: true, rejected: false };
  }

  const used = walletTasksInWindow(walletPublicKey, options.windowMs, options.now);
  return {
    limit,
    used,
    remaining: Math.max(0, limit - used),
    disabled: false,
    rejected: used >= limit,
  };
}

/**
 * Enforce the quota, throwing a {@link RateLimitError} when the wallet is spent.
 *
 * A rejection is also counted in the quota metrics, bucketed by the utilisation
 * band the wallet was in. The counter is what turns "somebody complained" into
 * "12 wallets are pinned at the limit", and it is recorded before the throw so
 * the count survives the error path.
 */
export function assertDailyTaskQuota(
  walletPublicKey: string,
  options: DailyQuotaOptions & { correlationId?: string } = {},
): DailyQuotaCheck {
  const check = checkDailyTaskQuota(walletPublicKey, options);
  if (!check.rejected) return check;

  try {
    quotaMetricsRegistry().recordQuotaRejection({ usedTasks: check.used, limit: check.limit });
  } catch (err) {
    // Telemetry is observability, not enforcement: a broken registry must not
    // turn a 429 into a 500.
    log.warn({ err }, 'failed to record quota rejection metric');
  }

  log.info(
    { wallet: maskWallet(walletPublicKey), used: check.used, limit: check.limit },
    'daily task quota exceeded',
  );

  const windowHours = Math.round((options.windowMs ?? QUOTA_WINDOW_MS) / (60 * 60 * 1000));
  throw new RateLimitError(
    `Daily task limit reached (max ${check.limit} per ${windowHours} hours)`,
    { limit: check.limit, window: `${windowHours}h` },
    options.correlationId,
  );
}

/**
 * Shorten a wallet for logs.
 *
 * Quota logs are the only place a wallet address would reach the log stream, so
 * it is truncated to a prefix/suffix pair that is enough to correlate two
 * events without publishing a full account.
 */
function maskWallet(walletPublicKey: string): string {
  if (walletPublicKey.length <= 8) return walletPublicKey;
  return `${walletPublicKey.slice(0, 4)}…${walletPublicKey.slice(-4)}`;
}