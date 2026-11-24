/**
 * Unit tests for the shared daily-quota enforcement point (Issue #738).
 *
 * The three task routers used to carry their own copy of this check. These
 * tests pin the behaviour those copies had — the 429, the `RATE_LIMITED` code,
 * the `anonymous` bypass — so folding them into one helper cannot quietly
 * change an API contract, plus the new rejection-metric side effect.
 */

import { RateLimitError } from '../../errors';
import {
  ANONYMOUS_WALLET,
  assertDailyTaskQuota,
  checkDailyTaskQuota,
  walletTasksInWindow,
} from './dailyQuota';
import { QUOTA_WINDOW_MS } from './metrics';

const WALLET = 'GQUOTATEST5VLDNRLN3RPRJMRZOX3Z6G5CHCGDG6NXGPTVMLHK4HZ7HH';
const NOW = Date.parse('2026-10-17T12:00:00.000Z');

jest.mock('../../db/tasks', () => ({
  getTaskDb: jest.fn(),
  createTaskDb: jest.fn(),
}));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const taskDbModule = require('../../db/tasks') as {
  getTaskDb: jest.Mock;
  createTaskDb: jest.Mock;
};

/** Stands in for `createTaskDb(...).list(...)`, whose `total` drives the check. */
function mockTaskDb(total: number): void {
  taskDbModule.createTaskDb.mockReturnValue({
    list: jest.fn().mockReturnValue({ tasks: [], total }),
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  mockTaskDb(0);
});

describe('walletTasksInWindow (Issue #738)', () => {
  it('counts tasks created after the trailing window start', () => {
    expect(walletTasksInWindow(WALLET, QUOTA_WINDOW_MS, () => NOW)).toBe(0);

    const list = taskDbModule.createTaskDb.mock.results[0]!.value.list as jest.Mock;
    expect(list).toHaveBeenCalledWith(WALLET, 1, 1, {
      createdAfter: '2026-10-16T12:00:00.000Z',
    });
  });
});

describe('checkDailyTaskQuota (Issue #738)', () => {
  it('reports remaining headroom below the limit', () => {
    mockTaskDb(4);
    expect(checkDailyTaskQuota(WALLET, { limit: 10 })).toEqual({
      limit: 10,
      used: 4,
      remaining: 6,
      disabled: false,
      rejected: false,
    });
  });

  it('flags a wallet at the limit', () => {
    mockTaskDb(10);
    expect(checkDailyTaskQuota(WALLET, { limit: 10 })).toMatchObject({
      used: 10,
      remaining: 0,
      rejected: true,
    });
  });

  it('flags a wallet past the limit', () => {
    mockTaskDb(25);
    expect(checkDailyTaskQuota(WALLET, { limit: 10 })).toMatchObject({
      used: 25,
      remaining: 0,
      rejected: true,
    });
  });

  it('skips the query entirely for the anonymous wallet', () => {
    const check = checkDailyTaskQuota(ANONYMOUS_WALLET, { limit: 10 });
    expect(check).toMatchObject({ disabled: true, rejected: false });
    expect(taskDbModule.createTaskDb).not.toHaveBeenCalled();
  });

  it('skips the query when the quota is disabled (limit 0)', () => {
    const check = checkDailyTaskQuota(WALLET, { limit: 0 });
    expect(check).toMatchObject({ disabled: true, rejected: false });
    expect(taskDbModule.createTaskDb).not.toHaveBeenCalled();
  });
});

describe('assertDailyTaskQuota (Issue #738)', () => {
  it('returns the check when the wallet is under the limit', () => {
    mockTaskDb(1);
    expect(assertDailyTaskQuota(WALLET, { limit: 10 }).rejected).toBe(false);
  });

  it('throws a 429 RATE_LIMITED error once the wallet is spent', () => {
    mockTaskDb(10);

    let caught: unknown;
    try {
      assertDailyTaskQuota(WALLET, { limit: 10 });
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(RateLimitError);
    const error = caught as RateLimitError;
    expect(error.statusCode).toBe(429);
    expect(error.code).toBe('RATE_LIMITED');
    expect(error.message).toBe('Daily task limit reached (max 10 per 24 hours)');
    expect(error.details).toEqual({ limit: 10, window: '24h' });
  });

  it('carries the correlation id through to the error', () => {
    mockTaskDb(10);
    try {
      assertDailyTaskQuota(WALLET, { limit: 10, correlationId: 'corr_123' });
      throw new Error('expected a rejection');
    } catch (err) {
      expect((err as RateLimitError).correlationId).toBe('corr_123');
    }
  });

  it('reports the window in hours when it is not the default 24h', () => {
    mockTaskDb(10);
    try {
      assertDailyTaskQuota(WALLET, { limit: 10, windowMs: 60 * 60 * 1000 });
      throw new Error('expected a rejection');
    } catch (err) {
      expect((err as RateLimitError).message).toBe(
        'Daily task limit reached (max 10 per 1 hours)',
      );
      expect((err as RateLimitError).details).toEqual({ limit: 10, window: '1h' });
    }
  });

  it('counts the rejection in the quota metrics before throwing', () => {
    mockTaskDb(10);
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { quotaMetricsRegistry, resetQuotaMetricsRegistry } = require('./metrics');
    resetQuotaMetricsRegistry();
    const registry = quotaMetricsRegistry();
    registry.reset();

    expect(() => assertDailyTaskQuota(WALLET, { limit: 10 })).toThrow(RateLimitError);
    expect(registry.rejectionCounts()['at-limit']).toBe(1);
    resetQuotaMetricsRegistry();
  });

  it('does not count a rejection for a wallet that is still under the limit', () => {
    mockTaskDb(1);
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { quotaMetricsRegistry, resetQuotaMetricsRegistry } = require('./metrics');
    resetQuotaMetricsRegistry();
    const registry = quotaMetricsRegistry();
    registry.reset();

    assertDailyTaskQuota(WALLET, { limit: 10 });
    expect(Object.values(registry.rejectionCounts()).every((n) => n === 0)).toBe(true);
    resetQuotaMetricsRegistry();
  });

  it('still rejects when the metrics registry throws', () => {
    mockTaskDb(10);
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const metricsModule = require('./metrics');
    jest.spyOn(metricsModule, 'quotaMetricsRegistry').mockImplementation(() => {
      throw new Error('registry unavailable');
    });

    expect(() => assertDailyTaskQuota(WALLET, { limit: 10 })).toThrow(RateLimitError);
    jest.restoreAllMocks();
  });
});