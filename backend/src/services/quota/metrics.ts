/**
 * Prometheus telemetry for the per-wallet daily quota and the per-task token
 * budget (Issue #738).
 *
 * `DAILY_TASK_LIMIT_PER_WALLET` and `TASK_TOKEN_BUDGET` were already enforced,
 * but an operator could only infer their state from a rejection that had
 * already happened. This registry makes both limits visible *before* they bite.
 *
 * Cardinality is the design constraint, not an afterthought. A Stellar account
 * is a 56-character string, and every wallet that ever submits a task is a
 * distinct value — so `walletPublicKey` is never a label anywhere in this file.
 * Wallets are folded into a fixed set of utilisation bands instead, which caps
 * every labelled family at {@link QUOTA_BUCKETS}.length series regardless of how
 * many wallets are active, whether the node serves ten or ten million.
 *
 * Two sources feed the gauges, deliberately:
 *
 *  • Anything the database already owns (24h task counts per wallet, settled
 *    token spend) is read at scrape time, so the numbers survive a restart and
 *    match the enforcement path exactly.
 *  • Anything the database does not record (quota rejections) is accumulated in
 *    memory by the enforcement path itself. A counter is cheap to lose on
 *    restart; a missing rejection is cheap to notice.
 */

import { createLogger } from '../../utils/logger';

const logger = createLogger({ component: 'quota-metrics' });

/** Trailing window that `DAILY_TASK_LIMIT_PER_WALLET` is enforced over. */
export const QUOTA_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * Utilisation bands a wallet is folded into.
 *
 * Fixed and closed on purpose — this tuple is the cardinality budget for every
 * labelled family here. The bands are chosen so an operator can answer "is
 * anybody near the ceiling?" from `at-limit`/`over-limit` alone, and "is the
 * ceiling doing anything at all?" from a non-zero `0-25%`.
 *
 * `disabled` is emitted for every scrape so the `bucket` label set is stable
 * across scrapes: Prometheus rejects a series that appears and disappears.
 */
export const QUOTA_BUCKETS = [
  'disabled',
  '0-25%',
  '25-50%',
  '50-75%',
  '75-100%',
  'at-limit',
  'over-limit',
] as const;

export type QuotaBucket = (typeof QUOTA_BUCKETS)[number];

const EMPTY_BUCKET_TALLY: Readonly<Record<QuotaBucket, number>> = Object.freeze(
  QUOTA_BUCKETS.reduce(
    (acc, bucket) => {
      acc[bucket] = 0;
      return acc;
    },
    {} as Record<QuotaBucket, number>,
  ),
);

/**
 * Fold a wallet's task count into a utilisation band.
 *
 * Pure and exported so the banding is unit-testable without a registry, a
 * database, or a clock. A `limit` of 0 means the quota is switched off, so
 * every wallet lands in `disabled` rather than dividing by zero.
 */
export function quotaBucketFor(usedTasks: number, limit: number): QuotaBucket {
  if (!Number.isFinite(limit) || limit <= 0) return 'disabled';
  const used = Number.isFinite(usedTasks) ? Math.max(0, usedTasks) : 0;
  const ratio = used / limit;
  if (ratio >= 1) return used > limit ? 'over-limit' : 'at-limit';
  if (ratio >= 0.75) return '75-100%';
  if (ratio >= 0.5) return '50-75%';
  if (ratio >= 0.25) return '25-50%';
  return '0-25%';
}

/** One declared metric family. Mirrors the `prom-client` shape without the dependency. */
export interface MetricDescriptor {
  name: string;
  type: 'counter' | 'gauge';
  help: string;
  labelNames: readonly string[];
}

/**
 * The families this module owns.
 *
 * Exported so a test can assert registration by name without scraping HTTP,
 * and so an operator diffing the endpoint output against this list knows what
 * to expect. Every entry declares its labels up front — that is the check that
 * keeps a wallet address out of the exposition.
 */
export const QUOTA_METRICS: readonly MetricDescriptor[] = Object.freeze([
  {
    name: 'ainet_wallet_daily_quota_limit',
    type: 'gauge',
    help: 'Configured per-wallet daily task quota (DAILY_TASK_LIMIT_PER_WALLET); 0 when disabled',
    labelNames: [],
  },
  {
    name: 'ainet_wallet_daily_quota_wallets',
    type: 'gauge',
    help: 'Wallets observed in the trailing 24h, by daily task quota utilisation band',
    labelNames: ['bucket'],
  },
  {
    name: 'ainet_wallet_daily_quota_utilization_max',
    type: 'gauge',
    help: 'Highest daily task quota utilisation ratio observed in the trailing 24h',
    labelNames: [],
  },
  {
    name: 'ainet_wallet_daily_quota_rejections_total',
    type: 'counter',
    help: 'Daily task quota rejections since process start, by utilisation band of the rejected wallet',
    labelNames: ['bucket'],
  },
  {
    name: 'ainet_wallet_quota_used_ratio',
    type: 'gauge',
    help: 'Highest per-wallet Venice token quota utilisation (MAX_DAILY_VENICE_TOKENS_PER_WALLET) in the trailing 24h',
    labelNames: [],
  },
  {
    name: 'ainet_task_token_budget',
    type: 'gauge',
    help: 'Configured per-task token budget (TASK_TOKEN_BUDGET)',
    labelNames: [],
  },
  {
    name: 'ainet_task_tokens_spent_total',
    type: 'counter',
    help: 'Tokens spent on settled tasks since process start',
    labelNames: [],
  },
  {
    name: 'ainet_task_tokens_spent_daily',
    type: 'gauge',
    help: 'Tokens spent on tasks settled in the trailing 24h',
    labelNames: [],
  },
  {
    name: 'ainet_tasks_settled_daily',
    type: 'gauge',
    help: 'Tasks whose token spend was settled in the trailing 24h',
    labelNames: [],
  },
  {
    name: 'ainet_task_cost_usd_daily',
    type: 'gauge',
    help: 'US dollars spent on tasks settled in the trailing 24h',
    labelNames: [],
  },
  {
    name: 'ainet_task_budget_exceeded_daily',
    type: 'gauge',
    help: 'Tasks in the trailing 24h whose actual usage passed the token budget',
    labelNames: [],
  },
] as MetricDescriptor[]);

/** Read side of the registry. Injected so a scrape is testable without SQLite. */
export interface QuotaUsageSource {
  /** Per-wallet task counts created since `windowStart` (ISO 8601). */
  walletTaskCounts(windowStart: string): Array<{ wallet: string; tasks: number }>;
  /** Settled task cost rollup for tasks settled since `windowStart` (ISO 8601). */
  settledTokenSpend(windowStart: string): {
    tokens: number;
    costUsd: number;
    tasks: number;
    overBudget: number;
  };
  /**
   * Per-wallet Venice token spend recorded since `windowStart` (ISO 8601),
   * from `wallet_quota_events` (Issue #803). Optional: sources that predate
   * the wallet quota simply omit it and the ratio gauge reports zero.
   */
  walletTokenUsage?(windowStart: string): Array<{ wallet: string; tokens: number }>;
}

/** Everything a scrape needs, resolved and ready to render. */
export interface QuotaMetricsSnapshot {
  dailyTaskLimit: number;
  tokenBudget: number;
  windowMs: number;
  /** Wallet count per utilisation band. Always has an entry per {@link QUOTA_BUCKETS}. */
  wallets: Record<QuotaBucket, number>;
  walletsTracked: number;
  maxUtilizationRatio: number;
  /** Rejection counts per band. Always has an entry per {@link QUOTA_BUCKETS}. */
  rejections: Record<QuotaBucket, number>;
  tokensSpentTotal: number;
  tokensSpentDaily: number;
  costUsdDaily: number;
  tasksSettledDaily: number;
  tasksOverBudgetDaily: number;
  /**
   * Highest per-wallet Venice token utilisation observed in the trailing 24h
   * (Issue #803). 0 when the quota is disabled or no usage source supports it.
   */
  maxWalletQuotaUsedRatio: number;
  /** Set when the usage source threw, so the operator knows the gauges are stale. */
  sourceError?: string;
}

function tally(): Record<QuotaBucket, number> {
  return { ...EMPTY_BUCKET_TALLY };
}

function nonNegative(value: number): number {
  return Number.isFinite(value) && value > 0 ? value : 0;
}

function positiveLimit(value: number | undefined): number {
  return Number.isFinite(value) && (value as number) > 0 ? Math.floor(value as number) : 0;
}

function escapeLabelValue(v: string): string {
  return v.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
}

function renderFamily(
  descriptor: MetricDescriptor,
  samples: Array<{ labels: Record<string, string>; value: number }>,
): string {
  let out = `# HELP ${descriptor.name} ${descriptor.help}\n# TYPE ${descriptor.name} ${descriptor.type}\n`;
  for (const sample of samples) {
    const entries = Object.entries(sample.labels);
    const labelStr = entries.length
      ? `{${entries.map(([k, v]) => `${k}="${escapeLabelValue(v)}"`).join(',')}}`
      : '';
    out += `${descriptor.name}${labelStr} ${sample.value}\n`;
  }
  return out;
}

/**
 * In-memory counter/observation registry for the quota families.
 *
 * There is no global Prometheus registry in this codebase — `generatePrometheusMetrics`
 * builds the exposition per scrape — so "registration" here means: the family
 * descriptors have been claimed by this instance and its counters are the ones
 * the scrape reads. {@link register} is idempotent, because a second
 * registration must not silently reset the counters an operator is watching.
 */
export class QuotaMetricsRegistry {
  private registered = false;
  private readonly rejections = tally();
  private tokensSpentTotal = 0;

  constructor(
    private readonly source: QuotaUsageSource,
    private readonly limits: () => {
      dailyTaskLimit: number;
      tokenBudget: number;
      /** `MAX_DAILY_VENICE_TOKENS_PER_WALLET`; 0 disables the ratio gauge. */
      veniceTokenLimit?: number;
    },
    private readonly now: () => number = () => Date.now(),
  ) {}

  /**
   * Claim the metric families. Idempotent, and deliberately not lazy: the
   * families exist from process start so a scrape before any traffic still
   * reports zeroed series instead of an empty document.
   */
  register(): this {
    this.registered = true;
    return this;
  }

  get isRegistered(): boolean {
    return this.registered;
  }

  /** The families this registry owns, for registration assertions. */
  get registeredMetrics(): readonly MetricDescriptor[] {
    return QUOTA_METRICS;
  }

  /**
   * Record a daily-quota rejection.
   *
   * `usedTasks`/`limit` are the values the enforcement path saw, so the band is
   * the one the operator would have predicted from their dashboards.
   */
  recordQuotaRejection(params: { usedTasks: number; limit: number }): void {
    const bucket = quotaBucketFor(params.usedTasks, params.limit);
    this.rejections[bucket] += 1;
  }

  /**
   * Record settled spend for one task.
   *
   * Feeds the lifetime token counter only. The trailing-24h gauges are read
   * from `task_costs` at scrape time so they do not reset when the process
   * restarts mid-day.
   */
  recordTaskSpend(params: { tokens: number }): void {
    this.tokensSpentTotal += Math.floor(nonNegative(params.tokens));
  }

  /** Rejection counts as a plain map, for assertions and dashboards. */
  rejectionCounts(): Record<QuotaBucket, number> {
    return { ...this.rejections };
  }

  /** Resolve every gauge and counter for one scrape. */
  snapshot(): QuotaMetricsSnapshot {
    const limits = this.limits();
    const windowStart = new Date(this.now() - QUOTA_WINDOW_MS).toISOString();

    const wallets = tally();
    let walletsTracked = 0;
    let maxUtilizationRatio = 0;
    let maxWalletQuotaUsedRatio = 0;
    let tokensSpentDaily = 0;
    let costUsdDaily = 0;
    let tasksSettledDaily = 0;
    let tasksOverBudgetDaily = 0;
    let sourceError: string | undefined;

    try {
      for (const row of this.source.walletTaskCounts(windowStart)) {
        const tasks = nonNegative(row.tasks);
        wallets[quotaBucketFor(tasks, limits.dailyTaskLimit)] += 1;
        walletsTracked += 1;
        if (limits.dailyTaskLimit > 0) {
          maxUtilizationRatio = Math.max(maxUtilizationRatio, tasks / limits.dailyTaskLimit);
        }
      }

      const veniceTokenLimit = positiveLimit(limits.veniceTokenLimit);
      if (veniceTokenLimit > 0 && this.source.walletTokenUsage) {
        for (const row of this.source.walletTokenUsage(windowStart)) {
          const tokens = nonNegative(row.tokens);
          maxWalletQuotaUsedRatio = Math.max(maxWalletQuotaUsedRatio, tokens / veniceTokenLimit);
        }
      }

      const spend = this.source.settledTokenSpend(windowStart);
      tokensSpentDaily = nonNegative(spend.tokens);
      costUsdDaily = nonNegative(spend.costUsd);
      tasksSettledDaily = nonNegative(spend.tasks);
      tasksOverBudgetDaily = nonNegative(spend.overBudget);
    } catch (err) {
      // Metrics must never be the reason a scrape fails. Report the failure on
      // the family rather than dropping it, so a silent gap is visible.
      sourceError = err instanceof Error ? err.message : String(err);
      logger.debug({ err }, 'quota usage source unavailable');
    }

    return {
      dailyTaskLimit: Math.max(0, Math.floor(limits.dailyTaskLimit)),
      tokenBudget: Math.max(0, Math.floor(limits.tokenBudget)),
      windowMs: QUOTA_WINDOW_MS,
      wallets,
      walletsTracked,
      maxUtilizationRatio: round4(maxUtilizationRatio),
      rejections: { ...this.rejections },
      tokensSpentTotal: this.tokensSpentTotal,
      tokensSpentDaily,
      costUsdDaily: round4(costUsdDaily),
      tasksSettledDaily,
      tasksOverBudgetDaily,
      maxWalletQuotaUsedRatio: round4(maxWalletQuotaUsedRatio),
      sourceError,
    };
  }

  /** Render the families in Prometheus text exposition format. */
  render(snapshot: QuotaMetricsSnapshot = this.snapshot()): string {
    const walletSeries = QUOTA_BUCKETS.map(bucket => ({
      labels: { bucket },
      value: snapshot.wallets[bucket],
    }));
    const rejectionSeries = QUOTA_BUCKETS.map(bucket => ({
      labels: { bucket },
      value: snapshot.rejections[bucket],
    }));

    const samples: Record<string, Array<{ labels: Record<string, string>; value: number }>> = {
      ainet_wallet_daily_quota_limit: [{ labels: {}, value: snapshot.dailyTaskLimit }],
      ainet_wallet_daily_quota_wallets: walletSeries,
      ainet_wallet_daily_quota_utilization_max: [
        { labels: {}, value: snapshot.maxUtilizationRatio },
      ],
      ainet_wallet_daily_quota_rejections_total: rejectionSeries,
      ainet_wallet_quota_used_ratio: [
        { labels: {}, value: snapshot.maxWalletQuotaUsedRatio },
      ],
      ainet_task_token_budget: [{ labels: {}, value: snapshot.tokenBudget }],
      ainet_task_tokens_spent_total: [{ labels: {}, value: snapshot.tokensSpentTotal }],
      ainet_task_tokens_spent_daily: [{ labels: {}, value: snapshot.tokensSpentDaily }],
      ainet_tasks_settled_daily: [{ labels: {}, value: snapshot.tasksSettledDaily }],
      ainet_task_cost_usd_daily: [{ labels: {}, value: snapshot.costUsdDaily }],
      ainet_task_budget_exceeded_daily: [{ labels: {}, value: snapshot.tasksOverBudgetDaily }],
    };

    let out = '';
    for (const descriptor of QUOTA_METRICS) {
      out += renderFamily(descriptor, samples[descriptor.name] ?? []);
      out += '\n';
    }
    if (snapshot.sourceError) {
      out += '# HELP ainet_wallet_daily_quota_source_errors Whether the trailing-24h quota read failed (1) or succeeded (0)\n';
      out += '# TYPE ainet_wallet_daily_quota_source_errors gauge\n';
      out += 'ainet_wallet_daily_quota_source_errors 1\n';
    }
    return out;
  }

  /** Zero the counters. Used by tests and by the metrics reset route. */
  reset(): void {
    for (const bucket of QUOTA_BUCKETS) this.rejections[bucket] = 0;
    this.tokensSpentTotal = 0;
  }
}

function round4(value: number): number {
  return Number.isFinite(value) ? Math.round(value * 1e4) / 1e4 : 0;
}

// ---------------------------------------------------------------------------
// Production source
// ---------------------------------------------------------------------------

/**
 * The slice of a `better-sqlite3` handle this module uses.
 *
 * Declared structurally rather than importing the concrete type so a test can
 * hand in a stub with two methods instead of standing up a database.
 */
export interface QuotaStatement {
  all(...params: unknown[]): unknown[];
  get(...params: unknown[]): unknown;
}

export interface QuotaDb {
  prepare(sql: string): QuotaStatement;
}

/**
 * SQLite-backed usage source.
 *
 * Reads through `getTaskDb()` so a test that swaps the task DB gets quota
 * gauges for free. The `anonymous` wallet is excluded from the banding: it is
 * the no-wallet placeholder and the quota check already skips it, so counting
 * it would report a phantom series.
 *
 * Banding deliberately happens in JS rather than in the SQL `CASE`: the ratio
 * depends on a limit that is read from config at scrape time, and duplicating
 * the thresholds in a query string would give the two copies somewhere to
 * drift apart. The query returns one row per active wallet, not one per task,
 * so the row count is bounded by 24h of traffic rather than 24h of work.
 */
export function createSqliteQuotaSource(db: QuotaDb): QuotaUsageSource {
  return {
    walletTaskCounts(windowStart: string): Array<{ wallet: string; tasks: number }> {
      const rows = db
        .prepare(
          `SELECT walletPublicKey AS wallet, COUNT(*) AS tasks
             FROM tasks
            WHERE createdAt > ? AND walletPublicKey <> 'anonymous'
            GROUP BY walletPublicKey`,
        )
        .all(windowStart) as Array<{ wallet: string | null; tasks: number }>;
      return rows.map(row => ({ wallet: row.wallet ?? '', tasks: Number(row.tasks) || 0 }));
    },

    settledTokenSpend(windowStart: string): {
      tokens: number;
      costUsd: number;
      tasks: number;
      overBudget: number;
    } {
      const row = db
        .prepare(
          `SELECT COALESCE(SUM(usedTokens), 0) AS tokens,
                  COALESCE(SUM(costUsd), 0)    AS costUsd,
                  COUNT(*)                     AS tasks,
                  COALESCE(SUM(CASE WHEN exceeded = 1 THEN 1 ELSE 0 END), 0) AS overBudget
             FROM task_costs
            WHERE settledAt > ?`,
        )
        .get(windowStart) as
        | { tokens: number; costUsd: number; tasks: number; overBudget: number }
        | undefined;

      return {
        tokens: Number(row?.tokens) || 0,
        costUsd: Number(row?.costUsd) || 0,
        tasks: Number(row?.tasks) || 0,
        overBudget: Number(row?.overBudget) || 0,
      };
    },

    walletTokenUsage(windowStart: string): Array<{ wallet: string; tokens: number }> {
      // `wallet_quota_events` lives in the same `tasks.db` handle (Issue #803),
      // so one source answers both the task bands and the token ratio.
      const rows = db
        .prepare(
          `SELECT walletPublicKey AS wallet, COALESCE(SUM(units), 0) AS tokens
             FROM wallet_quota_events
            WHERE kind = 'tokens' AND createdAt > ? AND walletPublicKey <> 'anonymous'
            GROUP BY walletPublicKey`,
        )
        .all(windowStart) as Array<{ wallet: string | null; tokens: number }>;
      return rows.map(row => ({ wallet: row.wallet ?? '', tokens: Number(row.tokens) || 0 }));
    },
  };
}

/** Limits read from the validated config, never from `process.env`. */
function quotaLimitsFromConfig(): {
  dailyTaskLimit: number;
  tokenBudget: number;
  veniceTokenLimit?: number;
} {
  // Imported lazily: `getConfig()` validates the whole environment, and this
  // module is imported by collectors that must stay usable without a config.
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { getConfig } = require('../../config') as typeof import('../../config');
    const config = getConfig();
    return {
      dailyTaskLimit: Number(config.DAILY_TASK_LIMIT_PER_WALLET) || 0,
      tokenBudget: Number(config.TASK_TOKEN_BUDGET) || 0,
      veniceTokenLimit: Number(config.MAX_DAILY_VENICE_TOKENS_PER_WALLET) || 0,
    };
  } catch {
    return { dailyTaskLimit: 0, tokenBudget: 0, veniceTokenLimit: 0 };
  }
}

let shared: QuotaMetricsRegistry | undefined;

/**
 * The process-wide registry.
 *
 * Lazily built because its SQLite source needs the task DB, which must not be
 * opened just by importing this module. An unavailable task DB degrades to a
 * source that always throws: the families still render (zeroed, with
 * `ainet_wallet_daily_quota_source_errors 1`) instead of the whole quota block
 * vanishing from the scrape.
 */
export function quotaMetricsRegistry(): QuotaMetricsRegistry {
  if (!shared) {
    let source: QuotaUsageSource;
    try {
      source = createSqliteQuotaSource(sharedTaskDb());
    } catch (err) {
      logger.debug({ err }, 'task database unavailable for quota metrics');
      source = unavailableSource();
    }
    shared = new QuotaMetricsRegistry(source, quotaLimitsFromConfig).register();
  }
  return shared;
}

/** Stands in for the SQLite source when the task DB cannot be opened. */
function unavailableSource(): QuotaUsageSource {
  const fail = (): never => {
    throw new Error('task database unavailable');
  };
  return {
    walletTaskCounts: fail,
    settledTokenSpend: fail,
  };
}

function sharedTaskDb(): QuotaDb {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { getTaskDb } = require('../../db/tasks') as typeof import('../../db/tasks');
  // A handle that throws on `prepare` is fine: the registry catches a failed
  // usage read and reports it on the family instead of failing the scrape.
  return getTaskDb() as unknown as QuotaDb;
}

/** Test hook: drop the shared registry so the next call rebuilds it. */
export function resetQuotaMetricsRegistry(): void {
  shared = undefined;
}