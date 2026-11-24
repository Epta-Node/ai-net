/**
 * Drift alert classification (issue #811).
 *
 * Pure functions that turn a reconciliation discrepancy into an alert level.
 * The level depends on how much of the escrowed amount the drift affects, as a
 * percentage of the expected amount:
 *
 * • `amount_mismatch` — the measured difference between on-chain and local
 *   amounts.
 * • `release_unconfirmed` — the expected amount is 0 but money is still
 *   claimable, so the drift is 100%.
 * • Every other category — the whole escrow is unaccounted for, stranded or
 *   unproven (orphaned, missing release proof, expired, missing local record),
 *   so the drift is 100%.
 *
 * No I/O and no clock reads: the caller supplies the detection time.
 */

import type { DriftType, ReconciliationDiscrepancy } from './reconciliation.types';

/** Stroops per XLM (1 XLM = 10^7 stroops). */
export const STROOPS_PER_XLM = 10_000_000n;

/** Drift percentages (of the expected amount) at which alerts fire. */
export interface DriftAlertThresholds {
  /** Drift at or above this percentage raises a `warning` alert. */
  warningPercent: number;
  /** Drift at or above this percentage raises a `critical` alert. */
  criticalPercent: number;
}

/** A threshold-breaching drift, ready for notification. */
export interface DriftAlert {
  level: 'warning' | 'critical';
  taskId: string;
  balanceId: string;
  driftType: DriftType;
  expectedXLM: number;
  actualXLM: number;
  driftPercent: number;
  detectedAt: Date;
  message: string;
}

/** Parse a stroop string, returning `null` when it is missing or not an integer. */
function parseStroops(value: string | undefined): bigint | null {
  if (value === undefined) return null;
  try {
    return BigInt(value);
  } catch {
    return null;
  }
}

/** Stroops as XLM for display. Missing or invalid amounts read as 0. */
export function stroopsToXlm(value: string | undefined): number {
  const stroops = parseStroops(value);
  return stroops === null ? 0 : Number(stroops) / Number(STROOPS_PER_XLM);
}

/**
 * Percentage difference between an actual and an expected amount, to two
 * decimal places. An expected amount of 0 counts as 0% only when nothing is
 * actually present; an amount that cannot be measured counts as 100%.
 */
function amountDriftPercent(expected: string | undefined, actual: string | undefined): number {
  const expectedStroops = parseStroops(expected);
  const actualStroops = parseStroops(actual);
  if (expectedStroops === null || actualStroops === null) return 100;
  if (expectedStroops === 0n) return actualStroops === 0n ? 0 : 100;
  const diff = actualStroops > expectedStroops ? actualStroops - expectedStroops : expectedStroops - actualStroops;
  return Number((diff * 10_000n) / expectedStroops) / 100;
}

/** Drift as a percentage of the expected amount. */
export function driftPercentOf(discrepancy: ReconciliationDiscrepancy): number {
  switch (discrepancy.driftType) {
    case 'amount_mismatch':
      return amountDriftPercent(discrepancy.expectedAmountStroops ?? discrepancy.localAmountStroops, discrepancy.onChainAmountStroops);
    case 'release_unconfirmed':
      return amountDriftPercent(discrepancy.expectedAmountStroops ?? '0', discrepancy.onChainAmountStroops);
    default:
      return 100;
  }
}

/**
 * Alert level for a discrepancy, or `null` when it does not reach the warning
 * threshold (or has no drift at all).
 */
export function classifyDriftAlert(
  discrepancy: ReconciliationDiscrepancy,
  thresholds: DriftAlertThresholds,
  detectedAt: Date,
): DriftAlert | null {
  const driftPercent = driftPercentOf(discrepancy);
  if (driftPercent <= 0) return null;

  let level: DriftAlert['level'];
  if (driftPercent >= thresholds.criticalPercent) level = 'critical';
  else if (driftPercent >= thresholds.warningPercent) level = 'warning';
  else return null;

  const taskId = discrepancy.taskId ?? '';
  return {
    level,
    taskId,
    balanceId: discrepancy.balanceId,
    driftType: discrepancy.driftType,
    expectedXLM: stroopsToXlm(discrepancy.expectedAmountStroops ?? discrepancy.localAmountStroops),
    actualXLM: stroopsToXlm(discrepancy.onChainAmountStroops),
    driftPercent,
    detectedAt,
    message:
      `Payment drift of ${driftPercent.toFixed(2)}% (${discrepancy.driftType}) ` +
      `${level === 'critical' ? 'exceeds critical' : 'exceeds warning'} threshold ` +
      `(${level === 'critical' ? thresholds.criticalPercent : thresholds.warningPercent}%)` +
      (taskId ? ` for task ${taskId}` : ''),
  };
}
