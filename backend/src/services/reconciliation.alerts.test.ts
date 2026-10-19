import {
  classifyDriftAlert,
  driftPercentOf,
  stroopsToXlm,
  type DriftAlertThresholds,
} from './reconciliation.alerts';
import type { ReconciliationDiscrepancy } from './reconciliation.types';

const THRESHOLDS: DriftAlertThresholds = { warningPercent: 1, criticalPercent: 5 };
const NOW = new Date('2026-10-18T02:00:00.000Z');

function amountMismatch(expected: string, onChain: string): ReconciliationDiscrepancy {
  return {
    type: 'amount_mismatch',
    driftType: 'amount_mismatch',
    balanceId: 'bal_1',
    taskId: 'task_1',
    nodeId: 'node_1',
    severity: 'critical',
    description: 'amount mismatch',
    localAmountStroops: expected,
    onChainAmountStroops: onChain,
    expectedAmountStroops: expected,
  };
}

describe('driftPercentOf', () => {
  it('measures amount drift as a percentage of the expected amount', () => {
    // 1.5% of 10 XLM (100_000_000 stroops) is 150_000 stroops.
    expect(driftPercentOf(amountMismatch('100000000', '101500000'))).toBe(1.5);
    expect(driftPercentOf(amountMismatch('100000000', '93000000'))).toBe(7);
  });

  it('reports 0 when the amounts agree', () => {
    expect(driftPercentOf(amountMismatch('100000000', '100000000'))).toBe(0);
  });

  it('treats an unclaimed release as 100% drift', () => {
    const release: ReconciliationDiscrepancy = {
      type: 'missing_on_chain',
      driftType: 'release_unconfirmed',
      balanceId: 'bal_2',
      severity: 'critical',
      description: 'still claimable',
      localAmountStroops: '50000000',
      onChainAmountStroops: '50000000',
      expectedAmountStroops: '0',
    };
    expect(driftPercentOf(release)).toBe(100);
  });

  it('treats whole-escrow drifts as 100%', () => {
    const orphaned: ReconciliationDiscrepancy = {
      type: 'missing_on_chain',
      driftType: 'orphaned_locked',
      balanceId: 'bal_3',
      severity: 'critical',
      description: 'no balance',
      localAmountStroops: '10000000',
    };
    expect(driftPercentOf(orphaned)).toBe(100);
  });
});

describe('classifyDriftAlert', () => {
  it('raises a warning for 1.5% drift', () => {
    const alert = classifyDriftAlert(amountMismatch('100000000', '101500000'), THRESHOLDS, NOW);
    expect(alert).not.toBeNull();
    expect(alert?.level).toBe('warning');
    expect(alert?.driftPercent).toBe(1.5);
    expect(alert?.taskId).toBe('task_1');
    expect(alert?.detectedAt).toBe(NOW);
  });

  it('raises a critical alert for 6% drift', () => {
    const alert = classifyDriftAlert(amountMismatch('100000000', '106000000'), THRESHOLDS, NOW);
    expect(alert?.level).toBe('critical');
    expect(alert?.driftPercent).toBe(6);
  });

  it('raises nothing below the warning threshold', () => {
    expect(classifyDriftAlert(amountMismatch('100000000', '100500000'), THRESHOLDS, NOW)).toBeNull();
  });

  it('raises nothing for zero drift, even with a zero warning threshold', () => {
    const zeroThresholds = { warningPercent: 0, criticalPercent: 5 };
    expect(classifyDriftAlert(amountMismatch('100000000', '100000000'), zeroThresholds, NOW)).toBeNull();
  });

  it('reports expected and actual amounts in XLM', () => {
    const alert = classifyDriftAlert(amountMismatch('100000000', '106000000'), THRESHOLDS, NOW);
    expect(alert?.expectedXLM).toBe(10);
    expect(alert?.actualXLM).toBeCloseTo(10.6, 7);
  });
});

describe('stroopsToXlm', () => {
  it('converts stroops to XLM and reads missing or invalid amounts as 0', () => {
    expect(stroopsToXlm('12345678')).toBeCloseTo(1.2345678, 7);
    expect(stroopsToXlm(undefined)).toBe(0);
    expect(stroopsToXlm('not-a-number')).toBe(0);
  });
});
