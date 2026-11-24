/**
 * Pure payment-drift detection (issue #496).
 *
 * Everything in this module is a total function over already-fetched inputs —
 * local payment records, on-chain claimable balances, verified release
 * transactions and task states. There is no I/O, no clock read and no database
 * access, which makes every drift scenario directly unit-testable and lets the
 * service keep its orchestration concerns separate.
 *
 * The four scenarios named in the issue map onto the detectors below:
 *
 * 1. DB `locked` but no on-chain claimable balance → `orphaned_locked`
 * 2. DB `released` but no on-chain release tx       → `missing_release_tx`
 * 3. DB `released` but the balance is still claimable → `release_unconfirmed`
 * 4. Task terminal, escrow still `locked`           → `expired_escrow`
 *
 * plus the two pre-existing categories (`missing_local`, `amount_mismatch`)
 * which remain reportable but are never auto-remediated.
 */

import { isSettledPaymentStatus } from "../db/index";
import type { PaymentRecord, PaymentStatus } from "../db/index";
import type {
  ClaimableBalanceOnChain,
  ClaimTransactionOnChain,
  DriftType,
  ReconciliationDiscrepancy,
  RemediationAction,
} from "./reconciliation.types";

/** Task statuses after which a still-locked escrow is dead money. */
const TERMINAL_UNSUCCESSFUL_TASK_STATUSES = new Set([
  "failed",
  "cancelled",
  "canceled",
]);

/** Resolved state of the task that owns a payment record. */
export interface TaskState {
  status: string;
  /** ISO-8601 timestamp the task last changed. */
  updatedAt?: string;
}

/** Port used to resolve a task's current state. */
export type TaskStateResolver = (taskId: string) => TaskState | undefined;

/** Release-transaction verification outcome for one `released` record. */
export interface ReleaseVerification {
  /** The `txHash` stored on the local record, if any. */
  recordedTxHash: string | null;
  /** Result of looking that hash up on-chain, or the real hash when backfilled. */
  onChainTx: ClaimTransactionOnChain | null;
  /** Why the on-chain record is missing, when it is. */
  lookupError?: string;
}

/** Port used to verify a recorded release transaction against the chain. */
export type ReleaseTransactionResolver = (
  record: PaymentRecord,
) => Promise<ReleaseVerification>;

/** Knobs that influence drift classification. */
export interface DriftDetectionOptions {
  /**
   * How long a `locked` escrow may remain after its task reached a terminal
   * unsuccessful state before it is treated as expired. `0` disables the age
   * gate (every terminal task triggers a refund).
   */
  escrowExpiryMs: number;
  /** Injectable clock (epoch ms). */
  now: () => number;
  /** Resolve a task's state; omit to disable `expired_escrow` detection. */
  taskState?: TaskStateResolver;
  /** Verify a `released` record's transaction; omit to skip tx verification. */
  releaseTransactions?: ReleaseTransactionResolver;
}

/** An empty per-category counter map. */
export function emptyDriftCounters<K extends string>(
  keys: readonly K[],
): Record<K, number> {
  const out = {} as Record<K, number>;
  for (const key of keys) out[key] = 0;
  return out;
}

/** `true` when the task is in a terminal, unsuccessful state. */
export function isTerminalUnsuccessful(status: string | undefined): boolean {
  if (!status) return false;
  return TERMINAL_UNSUCCESSFUL_TASK_STATUSES.has(status.toLowerCase());
}

/**
 * Age of a payment record in milliseconds, or `null` when unknown.
 *
 * Prefers the record's own `createdAt` (the moment escrow was locked) and falls
 * back to the task's `updatedAt`. Returning `null` means "cannot tell" — the
 * caller must then decide whether to fail open or closed, and both are
 * documented at the call site.
 */
export function paymentAgeMs(
  record: PaymentRecord,
  task: TaskState | undefined,
  now: number,
): number | null {
  const recordCreated = record.createdAt
    ? Date.parse(record.createdAt)
    : Number.NaN;
  if (Number.isFinite(recordCreated)) {
    return Math.max(0, now - recordCreated);
  }
  const taskUpdated = task?.updatedAt ? Date.parse(task.updatedAt) : Number.NaN;
  if (Number.isFinite(taskUpdated)) {
    return Math.max(0, now - taskUpdated);
  }
  return null;
}

/** Drift detected for a `locked` record whose claimable balance is gone. */
export function detectOrphanedLock(
  record: PaymentRecord,
): ReconciliationDiscrepancy {
  return {
    type: "missing_on_chain",
    driftType: "orphaned_locked",
    balanceId: record.balanceId,
    taskId: record.taskId,
    nodeId: record.nodeId,
    severity: "critical",
    description:
      `Local payment record (task=${record.taskId}, node=${record.nodeId}, status=${record.status}) ` +
      `has no matching on-chain claimable balance — the escrow no longer exists on-chain`,
    localAmountStroops: record.amountStroops.toString(),
  };
}

/**
 * Drift detected for a `released` record whose release transaction cannot be
 * found on-chain (issue #496 scenario 2).
 */
export function detectMissingReleaseTx(
  record: PaymentRecord,
  verification: ReleaseVerification,
  onChain: ClaimableBalanceOnChain | undefined,
): ReconciliationDiscrepancy | null {
  if (onChain) {
    // The balance is still claimable: scenario 3 handles this instead, and it
    // is a stronger signal than a missing transaction index.
    return null;
  }
  const realHash = verification.onChainTx?.hash;
  if (realHash && realHash === verification.recordedTxHash) {
    // The recorded hash matches the on-chain claim — nothing is wrong here.
    return null;
  }
  const reason = verification.lookupError
    ? ` (${verification.lookupError})`
    : "";
  const backfill = realHash
    ? ` On-chain claim transaction ${realHash} will be back-filled.`
    : " No on-chain claim transaction is available to back-fill.";

  return {
    type: "missing_release_tx",
    driftType: "missing_release_tx",
    balanceId: record.balanceId,
    taskId: record.taskId,
    nodeId: record.nodeId,
    severity: "critical",
    description:
      `Local record is released but the release transaction ` +
      `${verification.recordedTxHash ?? "(none recorded)"} is missing from Horizon${reason}.${backfill}`,
    localAmountStroops: record.amountStroops.toString(),
    recordedTxHash: verification.recordedTxHash,
    onChainTxHash: realHash,
  };
}

/**
 * Drift detected for a `released` record whose claimable balance is still
 * claimable on-chain — the release never landed (issue #496 scenario 3).
 */
export function detectUnconfirmedRelease(
  record: PaymentRecord,
  onChain: ClaimableBalanceOnChain,
): ReconciliationDiscrepancy {
  return {
    type: "release_unconfirmed",
    driftType: "release_unconfirmed",
    balanceId: record.balanceId,
    taskId: record.taskId,
    nodeId: record.nodeId,
    severity: "critical",
    description:
      `Local record is released but ${onChain.amountStroops} stroops are still claimable on-chain ` +
      `(balance ${record.balanceId}, task=${record.taskId}, node=${record.nodeId}) — the release ` +
      `transaction never landed and must be re-submitted`,
    localAmountStroops: record.amountStroops.toString(),
    onChainAmountStroops: onChain.amountStroops,
    expectedAmountStroops: "0",
    recordedTxHash: record.txHash,
  };
}

/**
 * Drift detected for an escrow whose task is terminal but which is still locked
 * on-chain (issue #496 scenario 4).
 */
export function detectExpiredEscrow(
  record: PaymentRecord,
  onChain: ClaimableBalanceOnChain,
  task: TaskState | undefined,
  ageMs: number | null,
  expiryMs: number,
): ReconciliationDiscrepancy {
  return {
    type: "missing_on_chain",
    driftType: "expired_escrow",
    balanceId: record.balanceId,
    taskId: record.taskId,
    nodeId: record.nodeId,
    severity: "warning",
    description:
      `Escrow for task=${record.taskId}, node=${record.nodeId} is still locked on-chain ` +
      `(${onChain.amountStroops} stroops) but the task is ` +
      `${task ? `status=${task.status}` : "no longer tracked"}` +
      (ageMs === null
        ? " and its age cannot be determined"
        : ` (${Math.floor(ageMs / 1000)}s old, limit ${Math.floor(expiryMs / 1000)}s)`) +
      ` — a refund is required`,
    localAmountStroops: record.amountStroops.toString(),
    onChainAmountStroops: onChain.amountStroops,
    expectedAmountStroops: record.amountStroops.toString(),
    taskStatus: task?.status,
  };
}

/** An on-chain claimable balance with no matching local payment record. */
export function detectMissingLocal(
  balance: ClaimableBalanceOnChain,
): ReconciliationDiscrepancy {
  return {
    type: "missing_local",
    driftType: "missing_local",
    balanceId: balance.balanceId,
    severity: "warning",
    description:
      `On-chain claimable balance ${balance.balanceId} ` +
      `(${balance.amountStroops} stroops) has no matching local payment record`,
    onChainAmountStroops: balance.amountStroops,
  };
}

/** A local record whose amount disagrees with the on-chain balance. */
export function detectAmountMismatch(
  record: PaymentRecord,
  onChain: ClaimableBalanceOnChain,
  expectedStroops: bigint,
): ReconciliationDiscrepancy {
  return {
    type: "amount_mismatch",
    driftType: "amount_mismatch",
    balanceId: record.balanceId,
    taskId: record.taskId,
    nodeId: record.nodeId,
    severity: record.status === "locked" ? "critical" : "warning",
    description:
      record.status === "locked"
        ? `On-chain amount ${onChain.amountStroops} stroops does not match ` +
          `local record amount ${record.amountStroops.toString()} stroops ` +
          `(task=${record.taskId}, node=${record.nodeId})`
        : `Record (task=${record.taskId}, node=${record.nodeId}) is ` +
          `status=${record.status} but ${onChain.amountStroops} stroops are ` +
          `still claimable on-chain`,
    localAmountStroops: record.amountStroops.toString(),
    onChainAmountStroops: onChain.amountStroops,
    expectedAmountStroops: expectedStroops.toString(),
  };
}

/**
 * Should this `locked` record be refunded because its task is dead?
 *
 * Age gate semantics:
 * • age known and `< escrowExpiryMs` → **not** expired (the task may still be
 *   settling; avoid refunding a payment that is about to be released).
 * • age known and `>= escrowExpiryMs` → expired.
 * • age unknown → fail **open** and refund. The escrow demonstrably exists
 *   on-chain and the task is terminal, so the funds are otherwise stranded.
 * • `escrowExpiryMs <= 0` → the gate is disabled, so every terminal task counts
 *   as expired.
 */
export function isEscrowExpired(
  ageMs: number | null,
  expiryMs: number,
): boolean {
  if (expiryMs <= 0) return true;
  if (ageMs === null) return true;
  return ageMs >= expiryMs;
}

/** Everything the remediator needs to act on one drift. */
export interface RemediationPlan {
  discrepancy: ReconciliationDiscrepancy;
  action: RemediationAction;
  /** `true` when the action can be applied without human judgement. */
  automatic: boolean;
}

/**
 * Decide the remediation for a detected drift.
 *
 * Only unambiguous cases are automatic:
 * • `orphaned_locked`    → mark the local record `orphaned`
 * • `missing_release_tx` → back-fill the real on-chain claim hash
 * • `expired_escrow`     → refund the escrow
 * • `release_unconfirmed`→ re-submit the release (the chain is the source of
 *   truth and the claim is idempotent on-chain, so this cannot double-pay)
 *
 * `missing_local` and `amount_mismatch` are inherently ambiguous and always go
 * to manual review.
 */
export function planRemediation(
  discrepancy: ReconciliationDiscrepancy,
): RemediationPlan {
  switch (discrepancy.driftType) {
    case "orphaned_locked":
      return { discrepancy, action: "mark_orphaned", automatic: true };
    case "missing_release_tx":
      return {
        discrepancy,
        // Only safe to automate when the real hash is on-chain to copy from.
        action: discrepancy.onChainTxHash
          ? "backfill_tx_hash"
          : "manual_review",
        automatic: Boolean(discrepancy.onChainTxHash),
      };
    case "expired_escrow":
      return { discrepancy, action: "refund_escrow", automatic: true };
    case "release_unconfirmed":
      return { discrepancy, action: "requeue_release", automatic: true };
    default:
      return { discrepancy, action: "manual_review", automatic: false };
  }
}

/** Result of running a detection pass over a snapshot. */
export interface DriftDetectionResult {
  discrepancies: ReconciliationDiscrepancy[];
  /** Number of local records matched to an on-chain balance. */
  matched: number;
  /** Number of `released` records whose transaction verified. */
  releaseVerified: number;
  /** Number of `released` records whose transaction could not be verified. */
  releaseUnverified: number;
}

/**
 * Classify every local payment record against the on-chain snapshot, then flag
 * on-chain balances that have no local counterpart.
 *
 * Deterministic and side-effect free: the same inputs always produce the same
 * output, in the same order.
 */
export function detectPaymentDrift(
  localRecords: readonly PaymentRecord[],
  onChainBalances: readonly ClaimableBalanceOnChain[],
  options: DriftDetectionOptions,
  releaseVerifications?: ReadonlyMap<string, ReleaseVerification>,
): DriftDetectionResult {
  const { escrowExpiryMs, now, taskState } = options;
  const onChainByBalanceId = new Map(
    onChainBalances.map((balance) => [balance.balanceId, balance]),
  );
  const localBalanceIds = new Set<string>();
  const matchedBalanceIds = new Set<string>();
  const discrepancies: ReconciliationDiscrepancy[] = [];
  let releaseVerified = 0;
  let releaseUnverified = 0;

  for (const record of localRecords) {
    localBalanceIds.add(record.balanceId);
    const onChain = onChainByBalanceId.get(record.balanceId);
    const status: PaymentStatus = record.status;

    // ── Settled records: the claimable balance is expected to be gone ────────
    if (isSettledPaymentStatus(status)) {
      if (onChain) {
        // Scenario 3 — the DB says the money moved but the chain disagrees.
        discrepancies.push(detectUnconfirmedRelease(record, onChain));
        releaseUnverified += 1;
        continue;
      }
      // Scenario 2 — the balance is gone (consistent), but is the *proof* there?
      if (status === "released") {
        const verification = releaseVerifications?.get(recordKey(record));
        if (verification) {
          const missing = detectMissingReleaseTx(
            record,
            verification,
            undefined,
          );
          if (missing) {
            discrepancies.push(missing);
            releaseUnverified += 1;
          } else {
            releaseVerified += 1;
          }
        } else {
          // No verifier wired: treat the absent balance as sufficient proof.
          releaseVerified += 1;
        }
      }
      continue;
    }

    // ── `locked` records ─────────────────────────────────────────────────────
    if (!onChain) {
      // Scenario 1 — the escrow never landed, or was already claimed.
      discrepancies.push(detectOrphanedLock(record));
      continue;
    }

    matchedBalanceIds.add(record.balanceId);

    // Scenario 4 — the funds are genuinely still escrowed; is anyone going to
    // release them?
    const task = taskState?.(record.taskId);
    if (isTerminalUnsuccessful(task?.status)) {
      const ageMs = paymentAgeMs(record, task, now());
      if (isEscrowExpired(ageMs, escrowExpiryMs)) {
        discrepancies.push(
          detectExpiredEscrow(record, onChain, task, ageMs, escrowExpiryMs),
        );
        continue;
      }
    }

    const onChainStroops = BigInt(onChain.amountStroops);
    const expectedStroops = record.amountStroops;
    if (expectedStroops !== onChainStroops) {
      discrepancies.push(
        detectAmountMismatch(record, onChain, expectedStroops),
      );
    }
  }

  for (const balance of onChainBalances) {
    if (!localBalanceIds.has(balance.balanceId)) {
      discrepancies.push(detectMissingLocal(balance));
    }
  }

  return {
    discrepancies,
    matched: matchedBalanceIds.size,
    releaseVerified,
    releaseUnverified,
  };
}

/** Stable key for a payment record. */
export function recordKey(
  record: Pick<PaymentRecord, "taskId" | "nodeId">,
): string {
  return `${record.taskId}:${record.nodeId}`;
}

/** Resolve the release-transaction verifications for every `released` record. */
export async function verifyReleaseTransactions(
  localRecords: readonly PaymentRecord[],
  resolve: ReleaseTransactionResolver,
  limit: number,
): Promise<Map<string, ReleaseVerification>> {
  const out = new Map<string, ReleaseVerification>();
  let checked = 0;
  for (const record of localRecords) {
    if (record.status !== "released" || !record.txHash) continue;
    if (checked >= limit) break;
    checked += 1;
    out.set(recordKey(record), await resolve(record));
  }
  return out;
}

/** All drift categories present in a list of discrepancies. */
export function driftCounts(
  discrepancies: readonly ReconciliationDiscrepancy[],
): Record<DriftType, number> {
  const counts = emptyDriftCounters<DriftType>([
    "orphaned_locked",
    "missing_release_tx",
    "release_unconfirmed",
    "expired_escrow",
    "missing_local",
    "amount_mismatch",
  ] as const);
  for (const d of discrepancies) {
    counts[d.driftType] = (counts[d.driftType] ?? 0) + 1;
  }
  return counts;
}
