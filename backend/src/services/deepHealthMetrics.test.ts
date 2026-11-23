import Database from 'better-sqlite3';
import {
  DEEP_HEALTH_CHECK_METRIC,
  DEEP_HEALTH_CHECKS,
  DEEP_HEALTH_TOTAL_METRIC,
  DeepHealthMetricsRegistry,
  deepHealthMetricsRegistry,
  millisToSeconds,
  resetDeepHealthMetrics,
} from './deepHealthMetrics';
import { runDeepHealthCheck, type DeepHealthDeps, type QueueStats } from './deepHealth';

const emptyQueue: QueueStats = { pending: 0, active: 0, failed: 0, deadLetter: 0 };
const okResponse = { ok: true, status: 200 } as Response;

let db: Database.Database;

beforeEach(() => {
  db = new Database(':memory:');
  resetDeepHealthMetrics();
});

afterEach(() => {
  db.close();
});

describe('DeepHealthMetricsRegistry', () => {
  it('registers a histogram per sub-check and a total summary', () => {
    const output = new DeepHealthMetricsRegistry().render();

    expect(output).toContain(`# TYPE ${DEEP_HEALTH_CHECK_METRIC} histogram`);
    expect(output).toContain(`# TYPE ${DEEP_HEALTH_TOTAL_METRIC} summary`);
    for (const check of DEEP_HEALTH_CHECKS) {
      expect(output).toContain(`${DEEP_HEALTH_CHECK_METRIC}_count{check="${check}"} 0`);
    }
  });

  it('places an observation in the first bucket whose bound it does not exceed', () => {
    const registry = new DeepHealthMetricsRegistry();
    registry.observeCheck('venice', 0.03);

    const output = registry.render();
    expect(output).toContain(`${DEEP_HEALTH_CHECK_METRIC}_bucket{check="venice",le="0.025"} 0`);
    expect(output).toContain(`${DEEP_HEALTH_CHECK_METRIC}_bucket{check="venice",le="0.05"} 1`);
    expect(output).toContain(`${DEEP_HEALTH_CHECK_METRIC}_bucket{check="venice",le="+Inf"} 1`);
    expect(output).toContain(`${DEEP_HEALTH_CHECK_METRIC}_count{check="venice"} 1`);
  });

  it('ignores check names outside the fixed set, so the label stays bounded', () => {
    const registry = new DeepHealthMetricsRegistry();
    registry.observeCheck('wallet-GABC', 1);

    expect(registry.render()).not.toContain('wallet-GABC');
  });

  it('records the whole-probe time in the summary and clears on reset', () => {
    const registry = new DeepHealthMetricsRegistry();
    registry.observeTotal(0.25);
    registry.observeTotal(0.5);
    expect(registry.render()).toContain(`${DEEP_HEALTH_TOTAL_METRIC}_count 2`);

    registry.reset();
    expect(registry.render()).toContain(`${DEEP_HEALTH_TOTAL_METRIC}_count 0`);
  });

  it('treats non-finite or negative durations as zero', () => {
    expect(millisToSeconds(Number.NaN)).toBe(0);
    expect(millisToSeconds(-5)).toBe(0);
    expect(millisToSeconds(1500)).toBe(1.5);
  });
});

describe('runDeepHealthCheck metrics', () => {
  it('records every sub-check and the whole probe on each run', async () => {
    const input: DeepHealthDeps = {
      veniceApiKey: 'test-key',
      horizonUrl: 'https://horizon.example',
      timeoutMs: 1_000,
      queueDepthWarn: 100,
      fetchFn: jest.fn().mockResolvedValue(okResponse),
      getBreaker: () => null,
      getWriteDb: () => db,
      isReadOnly: () => false,
      getQueueStats: () => emptyQueue,
    };

    await runDeepHealthCheck(input);

    const output = deepHealthMetricsRegistry().render();
    for (const check of DEEP_HEALTH_CHECKS) {
      expect(output).toContain(`${DEEP_HEALTH_CHECK_METRIC}_count{check="${check}"} 1`);
    }
    expect(output).toContain(`${DEEP_HEALTH_TOTAL_METRIC}_count 1`);
  });
});
