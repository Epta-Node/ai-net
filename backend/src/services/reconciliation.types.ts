/**
 * Shared types for payment reconciliation and accounting reports.
 *
 * Reconciliation cross-references local payment records with Stellar
 * on-chain claimable balances and flags any discrepancies. Reports are
 * persisted with a timestamp so operators can audit past runs.
 *
 * Drift model (issue #496)
 * ───────────────────────
 * A *discrepancy* is the low-level shape already reported by the service
 * (`missing_on_chain`, `missing_local`, `amount_mismatch`). Every discrepancy
 * additionally carries a `driftType` — the coarse, stable category used for
 * metrics labels, event payloads and remediation planning:
 *
 * | `driftType`           | DB says          | Chain says            | Remediation                       |
 * |-----------------------|------------------|-----------------------|-----------------------------------|
 * | `orphaned_locked`     | `locked`         | no claimable balance  | mark the record `orphaned`         |
 * | `missing_release_tx`  | `released`       | release tx not found  | backfill the real claim tx hash    |
 * | `release_unconfirmed` | `released`       | balance still claimable | re-submit the release           |
 * | `expired_escrow`      | `locked`         | balance still claimable, task terminal | refund the escrow |
 * | `missing_local`       | no record        | claimable balance     | none (manual review)               |
 * | `amount_mismatch`     | any              | amount differs        | none (manual review)               |
 */

/** The three discrepancy classes detected by reconciliation. */
export type DiscrepancyType =
  | 'missing_on_chain'
  | 'missing_local'
  | 'amount_mismatch'
  // ── Added by issue #496 — release-verification and expiry drift ────────────
  | 'missing_release_tx'
  | 'release_unconfirmed';

export type DiscrepancySeverity = 'info' | 'warning' | 'critical';

/**
 * Stable, coarse drift categories. Used as the `type` label on the
 * `reconcile.driftDetected` / `reconcile.remediated` metrics and on the
 * `RECONCILIATION_EVENT` payload.
 */
export type DriftType =
  /** DB says `locked` but no on-chain claimable balance exists. */
  | 'orphaned_locked'
  /** DB says `released` but the recorded release transaction is absent from Horizon. */
  | 'missing_release_tx'
  /** DB says `released` but the claimable balance is still claimable on-chain. */
  | 'release_unconfirmed'
  /** The owning task reached a terminal unsuccessful state while the escrow is still locked. */
  | 'expired_escrow'
  /** An on-chain claimable balance has no matching local payment record. */
  | 'missing_local'
  /** On-chain and recorded amounts disagree. */
  | 'amount_mismatch';

/** Every drift category, in a stable order (metric label ordering). */
export const DRIFT_TYPES: readonly DriftType[] = [
  'orphaned_locked',
  'missing_release_tx',
  'release_unconfirmed',
  'expired_escrow',
  'missing_local',
  'amount_mismatch',
] as const;

/** What the service did about a drift once (or without) remediating it. */
export type RemediationAction =
  /** Local record flipped to `orphaned` (funds no longer escrowed). */
  | 'mark_orphaned'
  /** The `txHash` was corrected from the on-chain claim record. */
  | 'backfill_tx_hash'
  /** The release was queued for re-submission. */
  | 'requeue_release'
  /** The escrow was refunded back to the coordinator. */
  | 'refund_escrow'
  /** Detected and reported; requires a human. */
  | 'manual_review';

/** The outcome of attempting a remediation. */
export type RemediationStatus = 'remediated' | 'skipped' | 'failed' | 'manual_review';

/** The outcome recorded on a detected drift. */
export interface ReconciliationRemediation {
  /** Action taken (or recommended). */
  action: RemediationAction;
  /** Whether the action was actually applied. */
  status: RemediationStatus;
  /** `txHash` written back, when the action produced one. */
  txHash?: string;
  /** Why the action was skipped or failed. */
  reason?: string;
  /** ISO-8601 timestamp of the attempt. */
  at: string;
}

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

/**
 * A Stellar transaction that claims (or was expected to claim) a claimable
 * balance, as verified against Horizon.
 */
export interface ClaimTransactionOnChain {
  /** Transaction hash. */
  hash: string;
  /** Whether the transaction succeeded (as recorded by Horizon). */
  successful: boolean;
  /** Ledger sequence the transaction landed in. */
  ledgerSequence?: number;
  /** Public key that received the claim. */
  claimant?: string;
}

/** A single detected discrepancy between local and on-chain state. */
export interface ReconciliationDiscrepancy {
  type: DiscrepancyType;
  /** Stable category used for metrics, events and remediation. */
  driftType: DriftType;
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
  /** Release transaction hash recorded locally. */
  recordedTxHash?: string | null;
  /** Release transaction hash discovered on-chain. */
  onChainTxHash?: string;
  /** Terminal status of the owning task, when it could be resolved. */
  taskStatus?: string;
  /** Remediation outcome; absent while the drift is still unremediated. */
  remediation?: ReconciliationRemediation;
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
  /** Drifts found, broken down by {@link DriftType}. */
  driftByType: Record<DriftType, number>;
  /** Drifts successfully remediated, broken down by {@link DriftType}. */
  remediatedByType: Record<DriftType, number>;
  /** Total drifts remediated in this run. */
  remediated: number;
  /** Total drifts still awaiting a human decision. */
  pendingRemediation: number;
  /** Local `released` records whose release transaction was verified. */
  releaseVerified: number;
  /** Local `released` records whose release transaction could not be verified. */
  releaseUnverified: number;
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
  /** Remediation outcomes keyed by `<taskId>:<nodeId>` (or balance id). */
  remediations?: ReconciliationRemediation[];
}

/**
 * A durable record of a drift that is still awaiting a human decision. Persisted
 * so that "flag for re-submit" survives a process restart and can be drained by
 * an operator (or an operator tool) later.
 */
export interface PendingDrift {
  /** Stable id — `<taskId>:<nodeId>` when known, else the balance id. */
  id: string;
  driftType: DriftType;
  balanceId: string;
  taskId?: string;
  nodeId?: string;
  description: string;
  severity: DiscrepancySeverity;
  recommendedAction: RemediationAction;
  /** Run that first observed the drift. */
  detectedAt: string;
  /** Run that most recently re-observed the drift. */
  lastSeenAt: string;
  /** Number of consecutive runs that observed the drift. */
  occurrences: number;
  /** Whether an operator has acknowledged it. */
  acknowledged: boolean;
  /** Fields to patch when resolving the drift. */
  resolution?: {
    status: 'released' | 'refunded' | 'orphaned';
    txHash: string;
    at: string;
    by: string;
  };
}

/**
 * The `RECONCILIATION_EVENT` payload lives in the canonical event-types module so
 * that producers, the schema registry and consumers cannot drift apart.
 */
export type {
  ReconciliationDriftType,
  ReconciliationEventPayload,
  ReconciliationRemediationOutcome,
} from '../events/eventTypes';

