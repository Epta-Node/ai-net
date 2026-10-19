/**
 * Unit tests for the per-wallet daily quotas (Issue #803).
 *
 * The store is exercised through a real in-memory SQLite handle — the SQL is
 * the contract (window filter, kind filter, SUM vs COUNT) — while the task-DB
 * module is mocked the same way `dailyQuota.test.ts` mocks it.
 */

import Database from 'better-sqlite3';
import { QuotaExceededError } from '../../errors';
import { ANONYMOUS_WALLET } from './dailyQuota';
import {
  assertPromptWithinQuota,
  assertWalletQuota,
  checkAndConsumeTask,
  checkWalletQuota,
  ensureWalletQuotaSchema,
  getWalletQuotaStatus,
  recordWalletTokenSpend,
  resetForTesting,
} from './walletQuota';

jest.mock('../../db/tasks', () => ({
  getTaskDb: jest.fn(),
  createTaskDb: jest.fn(),
}));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const taskDbModule = require('../../db/tasks') as { getTaskDb: jest.Mock };

const WALLET = 'GQUOTATEST5VLDNRLN3RPRJMRZOX3Z6G5CHCGDG6NXGPTVMLHK4HZ7HH';
const OTHER = 'GQUOTATEST2VLDNRLN3RPRJMRZOX3Z6G5CHCGDG6NXGPTVMLHK4HZ7HH';
// A Wednesday noon: next UTC midnight is 12h away.
const NOW = Date.parse('2026-10-18T12:00:00.000Z');
const NEXT_MIDNIGHT = '2026-10-19T00:00:00.000Z';
const now = (): number => NOW;

let mem: Database.Database;

beforeEach(() => {
  mem = new Database(':memory:');
  taskDbModule.getTaskDb.mockReturnValue(mem);
  resetForTesting(); // creates the schema on the fresh handle
});

afterEach(() => {
  mem.close();
  jest.clearAllMocks();
});

describe('ensureWalletQuotaSchema', () => {
  it('is idempotent on the same handle', () => {
    expect(() => {
      ensureWalletQuotaSchema(mem);
      ensureWalletQuotaSchema(mem);
    }).not.toThrow();
    const tables = mem
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'wallet_quota_events'"
      )
      .get();
    expect(tables).toBeDefined();
  });
});

describe('checkWalletQuota (Issue #803)', () => {
  it('is disabled for the anonymous wallet', () => {
    const check = checkWalletQuota(ANONYMOUS_WALLET, { taskLimit: 5, now });
    expect(check).toMatchObject({ disabled: true, rejected: false, used: 0 });
  });

  it('is disabled when both limits are 0', () => {
    const check = checkWalletQuota(WALLET, { taskLimit: 0, tokenLimit: 0, now });
    expect(check).toMatchObject({ disabled: true, rejected: false });
  });

  it('counts admitted submissions and reports headroom', () => {
    checkAndConsumeTask(WALLET, { taskLimit: 5, tokenLimit: 0, now });
    checkAndConsumeTask(WALLET, { taskLimit: 5, tokenLimit: 0, now });
    const check = checkWalletQuota(WALLET, { taskLimit: 5, tokenLimit: 0, now });
    expect(check).toMatchObject({
      used: 2,
      remaining: 3,
      rejected: false,
      disabled: false,
      resetAt: NEXT_MIDNIGHT,
    });
  });

  it('ignores events outside the trailing 24h window', () => {
    recordWalletTokenSpend(WALLET, 100, { now });
    const staleAt = new Date(NOW - 25 * 60 * 60 * 1000).toISOString();
    mem
      .prepare(
        "INSERT INTO wallet_quota_events (walletPublicKey, kind, units, createdAt) VALUES (?, 'tokens', 100000, ?)"
      )
      .run(WALLET, staleAt);
    const check = checkWalletQuota(WALLET, { taskLimit: 0, tokenLimit: 1_000, now });
    expect(check.tokenUsed).toBe(100);
    expect(check.rejected).toBe(false);
  });

  it("does not count another wallet's events", () => {
    for (let i = 0; i < 5; i++) {
      checkAndConsumeTask(OTHER, { taskLimit: 5, tokenLimit: 0, now });
    }
    const check = checkWalletQuota(WALLET, { taskLimit: 5, tokenLimit: 0, now });
    expect(check.used).toBe(0);
  });
});

describe('checkAndConsumeTask / assertWalletQuota (Issue #803)', () => {
  it('admits below the limit and records one event', () => {
    const check = checkAndConsumeTask(WALLET, { taskLimit: 2, tokenLimit: 0, now });
    expect(check.rejected).toBe(false);
    const { n } = mem
      .prepare('SELECT COUNT(*) AS n FROM wallet_quota_events WHERE walletPublicKey = ?')
      .get(WALLET) as { n: number };
    expect(n).toBe(1);
  });

  it('rejects at the task limit with QUOTA_EXCEEDED and no extra event', () => {
    checkAndConsumeTask(WALLET, { taskLimit: 1, tokenLimit: 0, now });
    expect(() => checkAndConsumeTask(WALLET, { taskLimit: 1, tokenLimit: 0, now })).toThrow(
      QuotaExceededError
    );

    try {
      assertWalletQuota(WALLET, { taskLimit: 1, tokenLimit: 0, now });
    } catch (err) {
      const e = err as QuotaExceededError;
      expect(e.code).toBe('QUOTA_EXCEEDED');
      expect(e.statusCode).toBe(429);
      expect(e.details).toMatchObject({ resource: 'tasks', used: 1, limit: 1 });
      // Noon → next midnight is exactly 12h.
      expect(e.retryAfterSeconds).toBe(12 * 60 * 60);
    }

    const { n } = mem
      .prepare('SELECT COUNT(*) AS n FROM wallet_quota_events WHERE walletPublicKey = ?')
      .get(WALLET) as { n: number };
    expect(n).toBe(1);
  });

  it("rejects on the token budget with resource 'tokens'", () => {
    recordWalletTokenSpend(WALLET, 1_000, { now });
    try {
      assertWalletQuota(WALLET, { taskLimit: 50, tokenLimit: 1_000, now });
      throw new Error('expected assertWalletQuota to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(QuotaExceededError);
      const e = err as QuotaExceededError;
      expect(e.details).toMatchObject({ resource: 'tokens', used: 1_000, limit: 1_000 });
      expect(e.message).toContain('Venice token quota');
    }
  });

  it('records no events for the anonymous wallet', () => {
    checkAndConsumeTask(ANONYMOUS_WALLET, { taskLimit: 5, tokenLimit: 0, now });
    const { n } = mem.prepare('SELECT COUNT(*) AS n FROM wallet_quota_events').get() as {
      n: number;
    };
    expect(n).toBe(0);
  });
});

describe('recordWalletTokenSpend (Issue #803)', () => {
  it('ignores empty wallets, zero and negative spend', () => {
    recordWalletTokenSpend('', 100, { now });
    recordWalletTokenSpend(ANONYMOUS_WALLET, 100, { now });
    recordWalletTokenSpend(WALLET, 0, { now });
    recordWalletTokenSpend(WALLET, -5, { now });
    const { n } = mem.prepare('SELECT COUNT(*) AS n FROM wallet_quota_events').get() as {
      n: number;
    };
    expect(n).toBe(0);
  });

  it('stores fractional tokens as a positive unit count', () => {
    recordWalletTokenSpend(WALLET, 2.4, { now });
    const row = mem
      .prepare('SELECT units FROM wallet_quota_events WHERE walletPublicKey = ?')
      .get(WALLET) as { units: number };
    expect(row.units).toBe(3);
  });
});

describe('getWalletQuotaStatus (Issue #803)', () => {
  it('returns the { used, limit, resetAt } contract', () => {
    checkAndConsumeTask(WALLET, { taskLimit: 50, tokenLimit: 0, now });
    expect(getWalletQuotaStatus(WALLET, { taskLimit: 50, tokenLimit: 0, now })).toEqual({
      used: 1,
      limit: 50,
      resetAt: NEXT_MIDNIGHT,
    });
  });
});

describe('assertPromptWithinQuota (Issue #803)', () => {
  it('is disabled when the limit is unset', () => {
    expect(() => assertPromptWithinQuota('x'.repeat(50_000))).not.toThrow();
  });

  it('accepts a prompt exactly at the limit', () => {
    expect(() => assertPromptWithinQuota('x'.repeat(10), { promptCharLimit: 10 })).not.toThrow();
  });

  it('rejects a prompt over the limit with QUOTA_EXCEEDED', () => {
    try {
      assertPromptWithinQuota('x'.repeat(11), { promptCharLimit: 10 });
      throw new Error('expected assertPromptWithinQuota to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(QuotaExceededError);
      const e = err as QuotaExceededError;
      expect(e.details).toMatchObject({ resource: 'promptChars', used: 11, limit: 10 });
      expect(e.retryAfterSeconds).toBe(60);
    }
  });
});

describe('QuotaExceededError', () => {
  it('defaults retryAfterSeconds to one hour', () => {
    const err = new QuotaExceededError('spent', { resource: 'tokens' });
    expect(err.retryAfterSeconds).toBe(3_600);
    expect(err.code).toBe('QUOTA_EXCEEDED');
    expect(err.statusCode).toBe(429);
  });
});
