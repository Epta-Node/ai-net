/**
 * Shared types for payment reconciliation and accounting reports.
 *
 * Reconciliation cross-references local payment records with Stellar
 * on-chain claimable balances and flags any discrepancies. Reports are
 * persisted with a timestamp so operators can audit past runs.
 */

/** The three discrepancy classes detected by reconciliation. */
export type DiscrepancyType =
  | 'missing_on_chain'
  | 'missing_local'
  | 'amount_mismatch';

export type DiscrepancySeverity = 'info' | 'warning' | 'critical';

/** How a reconciliation run was triggered. */
export type ReconciliationTrigger = 'manual' | 'scheduled' | 'release';

/** A claimable balance as observed on-chain via Horizon. */
export interface ClaimableBalanceOnChain {
  /** Horizon balance ID (claimable balance identifier). */
  balanceId: string;
  /** Amount in stroops. String to remain JSON-safe (bigint is not). */
  amountStroops: string;
  asset?: string;
  sponsor?: string;
  claimant?: string;
}

/** A single detected discrepancy between local and on-chain state. */
export interface ReconciliationDiscrepancy {
  type: DiscrepancyType;
  balanceId: string;
  taskId?: string;
  nodeId?: string;
  severity: DiscrepancySeverity;
  description: string;
  /** Amount recorded locally (stroops). */
  localAmountStroops?: string;
  /** Amount observed on-chain (stroops). */
  onChainAmountStroops?: string;
  /** Amount that should be on-chain for this record (stroops). */
  expectedAmountStroops?: string;
}

/** Aggregate counters for a reconciliation run. */
export interface ReconciliationSummary {
  totalLocalRecords: number;
  totalOnChainBalances: number;
  matched: number;
  discrepancies: number;
  missingOnChain: number;
  missingLocal: number;
  amountMismatch: number;
}

/** A completed reconciliation run, persisted with a timestamp. */
export interface ReconciliationReport {
  id: string;
  /** ISO-8601 timestamp of when the run completed. */
  runAt: string;
  triggeredBy: ReconciliationTrigger;
  status: 'consistent' | 'discrepancies_found';
  summary: ReconciliationSummary;
  discrepancies: ReconciliationDiscrepancy[];
}
