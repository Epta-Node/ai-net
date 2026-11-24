/**
 * Unit tests for the quota / token-budget Prometheus registry (Issue #738).
 *
 * The two properties worth locking down are the ones an operator cannot see
 * from a scrape by eye:
 *
 *  1. Registration — the families exist, and exist under stable names, from
 *     process start rather than after the first quota event.
 *  2. Cardinality — no label can ever carry a wallet address, so the endpoint
 *     cannot become an accidental per-wallet time series store.
 */

import {
  QUOTA_BUCKETS,
  QUOTA_METRICS,
  QuotaMetricsRegistry,
  createSqliteQuotaSource,
  quotaBucketFor,
  resetQuotaMetricsRegistry,
  quotaMetricsRegistry,
  type QuotaUsageSource,
} from './metrics';

const LIMIT = 100;
const TOKEN_BUDGET = 200_000;
const FIXED_NOW = Date.parse('2026-10-17T12:00:00.000Z');

function stubSource(overrides: Partial<QuotaUsageSource> = {}): QuotaUsageSource {
  return {
    walletTaskCounts: () => [],
    settledTokenSpend: () => ({ tokens: 0, costUsd: 0, tasks: 0, overBudget: 0 }),
    ...overrides,
  };
}

function registry(source: QuotaUsageSource = stubSource()): QuotaMetricsRegistry {
  return new QuotaMetricsRegistry(
    source,
    () => ({ dailyTaskLimit: LIMIT, tokenBudget: TOKEN_BUDGET }),
    () => FIXED_NOW,
  );
}

/** Every sample line of a family, ignoring HELP/TYPE comments. */
function samplesOf(text: string, name: string): string[] {
  return text
    .split('\n')
    .filter((line) => line.startsWith(`${name} `) || line.startsWith(`${name}{`));
}

describe('quotaBucketFor', () => {
  it.each([
    [0, LIMIT, '0-25%'],
    [24, LIMIT, '0-25%'],
    [25, LIMIT, '25-50%'],
    [49, LIMIT, '25-50%'],
    [50, LIMIT, '50-75%'],
    [74, LIMIT, '50-75%'],
    [75, LIMIT, '75-100%'],
    [99, LIMIT, '75-100%'],
    [100, LIMIT, 'at-limit'],
    [140, LIMIT, 'over-limit'],
  ])('bands %i used tasks of a %d limit into %s', (used, _limit, expected) => {
    expect(quotaBucketFor(used as number, LIMIT)).toBe(expected);
  });

  it('reports every wallet as disabled when the quota limit is 0', () => {
    expect(quotaBucketFor(0, 0)).toBe('disabled');
    expect(quotaBucketFor(5_000, 0)).toBe('disabled');
  });

  it('treats negative or non-finite counts as zero usage', () => {
    expect(quotaBucketFor(-5, LIMIT)).toBe('0-25%');
    expect(quotaBucketFor(Number.NaN, LIMIT)).toBe('0-25%');
    expect(quotaBucketFor(Number.POSITIVE_INFINITY, LIMIT)).toBe('0-25%');
  });
});

describe('QuotaMetricsRegistry registration (Issue #738)', () => {
  it('starts unregistered and reports the declared families once registered', () => {
    const metrics = registry();
    expect(metrics.isRegistered).toBe(false);

    metrics.register();
    expect(metrics.isRegistered).toBe(true);
    expect(metrics.registeredMetrics).toBe(QUOTA_METRICS);
    expect(metrics.registeredMetrics.map((m) => m.name)).toEqual(
      expect.arrayContaining([
        'ainet_wallet_daily_quota_limit',
        'ainet_wallet_daily_quota_wallets',
        'ainet_wallet_daily_quota_utilization_max',
        'ainet_wallet_daily_quota_rejections_total',
        'ainet_task_token_budget',
        'ainet_task_tokens_spent_total',
        'ainet_task_tokens_spent_daily',
        'ainet_tasks_settled_daily',
        'ainet_task_cost_usd_daily',
        'ainet_task_budget_exceeded_daily',
      ]),
    );
  });

  it('declares each family exactly once, with a type and help text', () => {
    const names = QUOTA_METRICS.map((m) => m.name);
    expect(new Set(names).size).toBe(names.length);
    for (const descriptor of QUOTA_METRICS) {
      expect(['counter', 'gauge']).toContain(descriptor.type);
      expect(descriptor.help.length).toBeGreaterThan(0);
    }
  });

  it('is idempotent: re-registering does not reset observed counters', () => {
    const metrics = registry().register();
    metrics.recordQuotaRejection({ usedTasks: 100, limit: LIMIT });
    metrics.register();
    metrics.register();

    expect(metrics.rejectionCounts()['at-limit']).toBe(1);
  });

  it('registers the process-wide singleton', () => {
    resetQuotaMetricsRegistry();
    expect(quotaMetricsRegistry().isRegistered).toBe(true);
    expect(quotaMetricsRegistry()).toBe(quotaMetricsRegistry());
    resetQuotaMetricsRegistry();
  });
});

describe('QuotaMetricsRegistry bounded cardinality (Issue #738)', () => {
  it('never declares a wallet-scoped label', () => {
    for (const descriptor of QUOTA_METRICS) {
      for (const label of descriptor.labelNames) {
        expect(label).not.toMatch(/wallet|account|address|public_?key/i);
      }
    }
  });

  it('only uses the `bucket` label, whose value set is fixed', () => {
    const labelSets = QUOTA_METRICS.map((m) => [...m.labelNames].sort().join(','));
    expect(new Set(labelSets)).toEqual(new Set(['', 'bucket']));
  });

  it('emits exactly one series per bucket regardless of wallet count', () => {
    const busy = registry(
      stubSource({
        walletTaskCounts: () =>
          Array.from({ length: 500 }, (_, i) => ({ wallet: `G${i}`, tasks: i })),
      }),
    ).register();

    const text = busy.render();
    expect(samplesOf(text, 'ainet_wallet_daily_quota_wallets')).toHaveLength(QUOTA_BUCKETS.length);
    expect(samplesOf(text, 'ainet_wallet_daily_quota_rejections_total')).toHaveLength(
      QUOTA_BUCKETS.length,
    );
  });

  it('does not leak a wallet address into the exposition', () => {
    const wallet = 'GB3NK5X2M2C5DFR6EH3A5DQF4FRT2XQ2IQC6GKJ6GKJ6GKJ6GKJ6GKJ6';
    const metrics = registry(
      stubSource({ walletTaskCounts: () => [{ wallet, tasks: LIMIT }] }),
    ).register();

    const text = metrics.render();
    expect(text).not.toContain(wallet);
    expect(text).not.toContain(wallet.slice(0, 12));
  });

  it('renders every bucket series even with no traffic, so series never flap', () => {
    const text = registry().register().render();
    for (const bucket of QUOTA_BUCKETS) {
      expect(text).toContain(`ainet_wallet_daily_quota_wallets{bucket="${bucket}"} 0`);
      expect(text).toContain(`ainet_wallet_daily_quota_rejections_total{bucket="${bucket}"} 0`);
    }
  });
});

describe('QuotaMetricsRegistry increments (Issue #738)', () => {
  it('counts a quota rejection in the band the wallet was in', () => {
    const metrics = registry().register();

    metrics.recordQuotaRejection({ usedTasks: LIMIT, limit: LIMIT });
    metrics.recordQuotaRejection({ usedTasks: LIMIT + 5, limit: LIMIT });
    metrics.recordQuotaRejection({ usedTasks: 10, limit: LIMIT });

    expect(metrics.rejectionCounts()).toMatchObject({
      'at-limit': 1,
      'over-limit': 1,
      '0-25%': 1,
      '25-50%': 0,
      '50-75%': 0,
      '75-100%': 0,
      disabled: 0,
    });
  });

  it('accumulates repeated rejections rather than overwriting', () => {
    const metrics = registry().register();
    for (let i = 0; i < 5; i += 1) {
      metrics.recordQuotaRejection({ usedTasks: 80, limit: LIMIT });
    }
    expect(metrics.rejectionCounts()['75-100%']).toBe(5);
    expect(metrics.render()).toContain('ainet_wallet_daily_quota_rejections_total{bucket="75-100%"} 5');
  });

  it('counts a rejected wallet against `disabled` when the limit is 0', () => {
    const metrics = registry().register();
    metrics.recordQuotaRejection({ usedTasks: 999, limit: 0 });
    expect(metrics.rejectionCounts().disabled).toBe(1);
  });

  it('increments the lifetime token counter on settled spend', () => {
    const metrics = registry().register();

    metrics.recordTaskSpend({ tokens: 1_000 });
    metrics.recordTaskSpend({ tokens: 2_500 });
    metrics.recordTaskSpend({ tokens: -50 });

    expect(metrics.snapshot().tokensSpentTotal).toBe(3_500);
    expect(metrics.render()).toContain('ainet_task_tokens_spent_total 3500');
  });

  it('zeroes counters on reset', () => {
    const metrics = registry().register();
    metrics.recordQuotaRejection({ usedTasks: 100, limit: LIMIT });
    metrics.recordTaskSpend({ tokens: 900 });

    metrics.reset();

    expect(metrics.rejectionCounts()['at-limit']).toBe(0);
    expect(metrics.snapshot().tokensSpentTotal).toBe(0);
  });
});

describe('QuotaMetricsRegistry snapshot (Issue #738)', () => {
  it('aggregates wallet task counts into utilisation bands', () => {
    const metrics = registry(
      stubSource({
        walletTaskCounts: () => [
          { wallet: 'GA', tasks: 5 },
          { wallet: 'GB', tasks: 30 },
          { wallet: 'GC', tasks: 60 },
          { wallet: 'GD', tasks: 90 },
          { wallet: 'GE', tasks: 100 },
          { wallet: 'GF', tasks: 250 },
        ],
      }),
    ).register();

    expect(metrics.snapshot()).toMatchObject({
      dailyTaskLimit: LIMIT,
      tokenBudget: TOKEN_BUDGET,
      walletsTracked: 6,
      maxUtilizationRatio: 2.5,
      wallets: {
        '0-25%': 1,
        '25-50%': 1,
        '50-75%': 1,
        '75-100%': 1,
        'at-limit': 1,
        'over-limit': 1,
        disabled: 0,
      },
    });
  });

  it('reports a max utilisation of 0 when the quota is disabled', () => {
    const metrics = new QuotaMetricsRegistry(
      stubSource({ walletTaskCounts: () => [{ wallet: 'GA', tasks: 40 }] }),
      () => ({ dailyTaskLimit: 0, tokenBudget: TOKEN_BUDGET }),
      () => FIXED_NOW,
    ).register();

    expect(metrics.snapshot().maxUtilizationRatio).toBe(0);
    expect(metrics.snapshot().wallets.disabled).toBe(1);
  });

  it('reads the trailing-24h token spend from the usage source', () => {
    const metrics = registry(
      stubSource({
        settledTokenSpend: () => ({ tokens: 1_234, costUsd: 0.0042, tasks: 7, overBudget: 2 }),
      }),
    ).register();

    expect(metrics.snapshot()).toMatchObject({
      tokensSpentDaily: 1_234,
      costUsdDaily: 0.0042,
      tasksSettledDaily: 7,
      tasksOverBudgetDaily: 2,
      windowMs: 24 * 60 * 60 * 1000,
    });
  });

  it('passes a 24-hour-old window start to the source', () => {
    const seen: string[] = [];
    const metrics = registry(
      stubSource({
        walletTaskCounts: (windowStart: string) => {
          seen.push(windowStart);
          return [];
        },
        settledTokenSpend: (windowStart: string) => {
          seen.push(windowStart);
          return { tokens: 0, costUsd: 0, tasks: 0, overBudget: 0 };
        },
      }),
    ).register();

    metrics.snapshot();
    expect(seen).toEqual(['2026-10-16T12:00:00.000Z', '2026-10-16T12:00:00.000Z']);
  });

  it('surfaces a failed usage read instead of dropping the families', () => {
    const metrics = registry(
      stubSource({
        walletTaskCounts: () => {
          throw new Error('database is locked');
        },
      }),
    ).register();

    const snapshot = metrics.snapshot();
    expect(snapshot.sourceError).toBe('database is locked');
    expect(snapshot.walletsTracked).toBe(0);

    const text = metrics.render();
    expect(text).toContain('# TYPE ainet_wallet_daily_quota_wallets gauge');
    expect(text).toContain('ainet_wallet_daily_quota_source_errors 1');
  });

  it('omits the source-error gauge on a healthy scrape', () => {
    expect(registry().register().render()).not.toContain(
      'ainet_wallet_daily_quota_source_errors',
    );
  });
});

describe('QuotaMetricsRegistry exposition format (Issue #738)', () => {
  it('emits HELP and TYPE annotations for every family', () => {
    const text = registry().register().render();
    for (const descriptor of QUOTA_METRICS) {
      expect(text).toContain(`# HELP ${descriptor.name} ${descriptor.help}`);
      expect(text).toContain(`# TYPE ${descriptor.name} ${descriptor.type}`);
    }
  });

  it('emits only lines the Prometheus text parser accepts', () => {
    const metrics = registry(
      stubSource({ walletTaskCounts: () => [{ wallet: 'GA', tasks: 30 }] }),
    ).register();
    metrics.recordQuotaRejection({ usedTasks: 100, limit: LIMIT });

    const lines = metrics.render().split('\n').filter((line) => line.trim().length > 0);
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      if (line.startsWith('#')) {
        expect(line).toMatch(/^# (HELP|TYPE) [\w{]/);
      } else {
        expect(line).toMatch(/^[a-z_][a-z0-9_]*(\{[^}]+\})?\s+[\d.e+-]+$/);
      }
    }
  });

  it('publishes the configured limits as gauges', () => {
    const text = registry().register().render();
    expect(text).toContain('ainet_wallet_daily_quota_limit 100');
    expect(text).toContain('ainet_task_token_budget 200000');
  });
});

describe('createSqliteQuotaSource (Issue #738)', () => {
  function stubDb(rows: unknown[], settled: unknown) {
    const calls: Array<{ sql: string; params: unknown[] }> = [];
    return {
      calls,
      prepare(sql: string) {
        return {
          all: (...params: unknown[]) => {
            calls.push({ sql, params });
            return rows;
          },
          get: (...params: unknown[]) => {
            calls.push({ sql, params });
            return settled;
          },
        };
      },
    };
  }

  it('groups trailing-24h task counts per wallet, excluding `anonymous`', () => {
    const db = stubDb([{ wallet: 'GA', tasks: 3 }], undefined);
    createSqliteQuotaSource(db).walletTaskCounts('2026-10-16T12:00:00.000Z');

    const { sql, params } = db.calls[0]!;
    expect(sql).toContain('FROM tasks');
    expect(sql).toContain('GROUP BY walletPublicKey');
    expect(sql).toContain("walletPublicKey <> 'anonymous'");
    expect(params).toEqual(['2026-10-16T12:00:00.000Z']);
  });

  it('normalises NULL wallet keys and non-numeric counts', () => {
    const db = stubDb([{ wallet: null, tasks: '4' }], undefined);
    expect(createSqliteQuotaSource(db).walletTaskCounts('x')).toEqual([
      { wallet: '', tasks: 4 },
    ]);
  });

  it('sums settled spend and over-budget tasks since the window start', () => {
    const db = stubDb([], { tokens: 900, costUsd: 0.5, tasks: 3, overBudget: 1 });
    const source = createSqliteQuotaSource(db);

    expect(source.settledTokenSpend('2026-10-16T12:00:00.000Z')).toEqual({
      tokens: 900,
      costUsd: 0.5,
      tasks: 3,
      overBudget: 1,
    });
    expect(db.calls[0]!.sql).toContain('FROM task_costs');
    expect(db.calls[0]!.sql).toContain('exceeded = 1');
    expect(db.calls[0]!.params).toEqual(['2026-10-16T12:00:00.000Z']);
  });

  it('reports zeroes when the spend query matches no rows', () => {
    const db = stubDb([], undefined);
    expect(createSqliteQuotaSource(db).settledTokenSpend('x')).toEqual({
      tokens: 0,
      costUsd: 0,
      tasks: 0,
      overBudget: 0,
    });
  });
});