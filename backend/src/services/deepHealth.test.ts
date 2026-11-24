import fs from 'fs';
import os from 'os';
import path from 'path';
import Database from 'better-sqlite3';
import {
  runDeepHealthCheck,
  queueDepthOf,
  type DeepHealthDeps,
  type QueueStats,
} from './deepHealth';
import type { CircuitBreakerSummary } from './circuitBreaker';

// ── helpers ───────────────────────────────────────────────────────────────────

const okResponse = { ok: true, status: 200 } as Response;

function breaker(overrides: Partial<CircuitBreakerSummary> = {}): CircuitBreakerSummary {
  return {
    name: 'venice',
    state: 'CLOSED',
    instances: 1,
    openInstances: 0,
    failures: 0,
    lastSuccessAt: Date.UTC(2026, 0, 1),
    lastFailureAt: null,
    ...overrides,
  };
}

const emptyQueue: QueueStats = { pending: 0, active: 0, failed: 0, deadLetter: 0 };

let db: Database.Database;

beforeEach(() => {
  db = new Database(':memory:');
});

afterEach(() => {
  db.close();
});

function deps(overrides: Partial<DeepHealthDeps> = {}): DeepHealthDeps {
  return {
    veniceApiKey: 'test-key',
    horizonUrl: 'https://horizon.example',
    timeoutMs: 1_000,
    queueDepthWarn: 100,
    fetchFn: jest.fn().mockResolvedValue(okResponse),
    getBreaker: () => null,
    getWriteDb: () => db,
    isReadOnly: () => false,
    getQueueStats: () => emptyQueue,
    ...overrides,
  };
}

// ── tests ─────────────────────────────────────────────────────────────────────

describe('runDeepHealthCheck', () => {
  it('reports ok with structured per-dependency results when everything is healthy', async () => {
    const report = await runDeepHealthCheck(deps({ getBreaker: (name) => breaker({ name }) }));

    expect(report.status).toBe('ok');
    expect(report.failing).toEqual([]);
    expect(report.degraded).toEqual([]);
    expect(Object.keys(report.dependencies).sort()).toEqual([
      'database',
      'horizon',
      'queue',
      'venice',
    ]);
    for (const result of Object.values(report.dependencies)) {
      expect(result.status).toBe('ok');
      expect(typeof result.critical).toBe('boolean');
      expect(typeof result.latencyMs).toBe('number');
      expect(typeof result.detail).toBe('string');
    }
    expect(report.dependencies.queue.critical).toBe(false);
    expect(report.dependencies.venice.lastSuccessAt).toBe('2026-01-01T00:00:00.000Z');
    expect(report.dependencies.venice.breaker).toMatchObject({ state: 'CLOSED' });
  });

  it('fails when the Venice breaker is OPEN even though the probe succeeds', async () => {
    const report = await runDeepHealthCheck(
      deps({
        getBreaker: (name) =>
          name === 'venice' ? breaker({ state: 'OPEN', failures: 3, openInstances: 1 }) : null,
      })
    );
    expect(report.status).toBe('fail');
    expect(report.failing).toEqual(['venice']);
    expect(report.dependencies.venice.detail).toMatch(/OPEN/);
  });

  it('degrades (not fails) when the Venice breaker is HALF_OPEN', async () => {
    const report = await runDeepHealthCheck(
      deps({ getBreaker: (name) => (name === 'venice' ? breaker({ state: 'HALF_OPEN' }) : null) })
    );
    expect(report.status).toBe('degraded');
    expect(report.degraded).toEqual(['venice']);
  });

  it('reports breaker: null when no Venice client has been constructed', async () => {
    const report = await runDeepHealthCheck(deps());
    expect(report.dependencies.venice.breaker).toBeNull();
    expect(report.dependencies.venice.lastSuccessAt).toBeNull();
    expect(report.dependencies.venice.status).toBe('ok');
  });

  it('treats a 401 from Venice as reachable', async () => {
    const fetchFn = jest.fn().mockResolvedValue({ ok: false, status: 401 } as Response);
    const report = await runDeepHealthCheck(deps({ fetchFn }));
    expect(report.dependencies.venice.status).toBe('ok');
    expect(report.dependencies.horizon.status).toBe('fail');
  });

  it('fails when Horizon is unreachable', async () => {
    const fetchFn = jest.fn((url: string) =>
      url.includes('venice.ai')
        ? Promise.resolve(okResponse)
        : Promise.reject(new Error('ECONNREFUSED'))
    );
    const report = await runDeepHealthCheck(deps({ fetchFn: fetchFn as unknown as typeof fetch }));
    expect(report.status).toBe('fail');
    expect(report.failing).toEqual(['horizon']);
    expect(report.dependencies.horizon.detail).toBe('unreachable');
  });

  it('describes a probe timeout', async () => {
    const abort = Object.assign(new Error('aborted'), { name: 'AbortError' });
    const report = await runDeepHealthCheck(deps({ fetchFn: jest.fn().mockRejectedValue(abort) }));
    expect(report.dependencies.venice.detail).toBe('timed out after 1000ms');
  });

  describe('database', () => {
    it('passes the write check without persisting anything', async () => {
      db.exec('CREATE TABLE t (x INTEGER)');
      const report = await runDeepHealthCheck(deps());
      expect(report.dependencies.database).toMatchObject({ status: 'ok', readOnlyMode: false });
      expect(db.inTransaction).toBe(false);
    });

    it("restores the connection's busy_timeout afterwards", async () => {
      db.pragma('busy_timeout = 4321');
      await runDeepHealthCheck(deps());
      expect(db.pragma('busy_timeout', { simple: true })).toBe(4321);
    });

    it('skips the write check in read-only mode and stays healthy', async () => {
      const exec = jest.spyOn(db, 'exec');
      const report = await runDeepHealthCheck(deps({ isReadOnly: () => true }));
      expect(report.dependencies.database).toMatchObject({ status: 'ok', readOnlyMode: true });
      expect(report.dependencies.database.detail).toMatch(/write check skipped/);
      expect(exec).not.toHaveBeenCalledWith('BEGIN IMMEDIATE');
    });

    it('fails when the database handle is read-only', async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deep-health-'));
      const file = path.join(dir, 'ro.db');
      new Database(file).close();
      const readonlyDb = new Database(file, { readonly: true });
      try {
        const report = await runDeepHealthCheck(deps({ getWriteDb: () => readonlyDb }));
        expect(report.status).toBe('fail');
        expect(report.failing).toEqual(['database']);
        expect(report.dependencies.database.detail).toMatch(/read-only/);
      } finally {
        readonlyDb.close();
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });

    it('degrades when another connection holds the write lock', async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deep-health-'));
      const file = path.join(dir, 'locked.db');
      const holder = new Database(file);
      const probed = new Database(file);
      try {
        holder.exec('BEGIN IMMEDIATE');
        const report = await runDeepHealthCheck(deps({ getWriteDb: () => probed }));
        expect(report.dependencies.database.status).toBe('degraded');
        expect(report.dependencies.database.detail).toMatch(/contended/);
        holder.exec('ROLLBACK');
      } finally {
        holder.close();
        probed.close();
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });

    it('fails when the database cannot be opened', async () => {
      const report = await runDeepHealthCheck(
        deps({
          getWriteDb: () => {
            throw new Error('SQLITE_CANTOPEN');
          },
        })
      );
      expect(report.failing).toEqual(['database']);
    });
  });

  describe('queue', () => {
    it('reports depth, active and dead-letter counts', async () => {
      const stats = { pending: 4, active: 2, failed: 1, deadLetter: 3 };
      const report = await runDeepHealthCheck(deps({ getQueueStats: () => stats }));
      expect(report.dependencies.queue).toMatchObject({
        status: 'ok',
        depth: 5,
        active: 2,
        deadLetter: 3,
        threshold: 100,
      });
    });

    it('degrades (200, not 503) when depth reaches the warning threshold', async () => {
      const report = await runDeepHealthCheck(
        deps({ queueDepthWarn: 10, getQueueStats: () => ({ ...emptyQueue, pending: 10 }) })
      );
      expect(report.status).toBe('degraded');
      expect(report.degraded).toEqual(['queue']);
      expect(report.failing).toEqual([]);
    });

    it('degrades when queue stats cannot be read', async () => {
      const report = await runDeepHealthCheck(
        deps({
          getQueueStats: () => {
            throw new Error('no such table: jobs');
          },
        })
      );
      expect(report.status).toBe('degraded');
      expect(report.dependencies.queue.depth).toBeNull();
    });
  });

  it('queueDepthOf counts pending plus failed jobs', () => {
    expect(queueDepthOf({ pending: 3, active: 9, failed: 2, deadLetter: 7 })).toBe(5);
  });
});
