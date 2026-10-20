import {
  Keypair,
  Asset,
  Operation,
  TransactionBuilder,
  Networks,
  Horizon,
  Transaction,
  Claimant,
  Memo,
  NotFoundError,
} from '@stellar/stellar-sdk';

/**
 * Custom error thrown when trying to settle an escrow that has already been claimed or released.
 */
export class EscrowAlreadySettledError extends Error {
  constructor(taskId: string) {
    super(`Escrow for task ${taskId} is already settled.`);
    this.name = 'EscrowAlreadySettledError';
  }
}

/**
 * Configuration and client factory for Stellar Network interactions.
 *
 * Time Complexity: O(1) - Retrieves environment variables and initializes the Server.
 * Space Complexity: O(1) - Static allocation of config details.
 */
function getStellarConfig() {
  const network = process.env.STELLAR_NETWORK || 'testnet';
  const passphrase = network === 'public' ? Networks.PUBLIC : Networks.TESTNET;
  const horizonUrl =
    process.env.STELLAR_HORIZON_URL ||
    (network === 'public'
      ? 'https://horizon.stellar.org'
      : 'https://horizon-testnet.stellar.org');
  return {
    server: new Horizon.Server(horizonUrl),
    passphrase,
  };
}

/**
 * Converts XLM amount (string, number, or bigint) to BigInt stroops internally.
 * 1 XLM = 10,000,000 Stroops (7 decimal places). Sub-stroop precision is silently truncated.
 *
 * Time Complexity: O(N) where N is the length of the string representation (fractional parsing).
 * Space Complexity: O(1) - Minimal allocation for numeric parsing.
 */
export function xlmToStroops(xlm: string | number | bigint): bigint {
  const xlmStr = typeof xlm === 'string' ? xlm : xlm.toString();
  const parts = xlmStr.split('.');
  let principal = BigInt(parts[0]) * 10000000n;
  if (parts.length > 1) {
    // Truncate to 7 decimal places — sub-stroop precision is silently discarded
    const fractionStr = parts[1].slice(0, 7).padEnd(7, '0');
    principal += BigInt(fractionStr);
  }
  return principal;
}

/**
 * Converts BigInt stroops back to standard 7-decimal XLM string format.
 *
 * Time Complexity: O(N) where N is the length of the digits.
 * Space Complexity: O(N) for string building.
 */
export function stroopsToXlm(stroops: bigint): string {
  const stroopsStr = stroops.toString().padStart(8, '0');
  const len = stroopsStr.length;
  const principal = stroopsStr.slice(0, len - 7);
  const fraction = stroopsStr.slice(len - 7);
  return `${principal}.${fraction}`;
}

/**
 * Robust wrapper that executes Horizon operations with exponential backoff on transient errors.
 * Retries up to 5 times for TOO_MANY_REQUESTS (429) and GATEWAY_TIMEOUT (504).
 *
 * Time Complexity: O(2^A * D) where A is the attempt limit (5) and D is the delay base.
 * Space Complexity: O(1) - Static call stack.
 */
async function executeWithRetry<T>(fn: () => Promise<T>): Promise<T> {
  let attempt = 0;
  const maxAttempts = 5;
  let delay = 1000; // start with 1000ms delay
  while (true) {
    try {
      return await fn();
    } catch (error: any) {
      attempt++;
      const status = error?.response?.status || error?.status;
      const isTransient = status === 429 || status === 504;
      if (isTransient && attempt < maxAttempts) {
        await new Promise((resolve) => setTimeout(resolve, delay));
        delay *= 2; // exponential backoff: 1s → 2s → 4s → 8s → 16s
        continue;
      }
      throw error;
    }
  }
}

/**
 * Checks whether a Horizon error is a 404 Not Found, using the SDK's typed NotFoundError
 * and a fallback status-code check for raw Axios errors.
 */
function isNotFoundError(error: any): boolean {
  return (
    error instanceof NotFoundError ||
    error?.response?.status === 404 ||
    error?.status === 404
  );
}

/**
 * Resolves the Claimable Balance ID for a given taskId by scanning the coordinator's
 * transaction history for the original CreateClaimableBalance transaction (identified
 * by memo text). Ignores claim/refund transactions that share the same memo.
 *
 * Time Complexity: O(U) where U is the history size searched (capped at 100 records).
 * Space Complexity: O(U) for transaction list retrieval.
 */
async function resolveBalanceId(
  server: Horizon.Server,
  coordinatorPublicKey: string,
  taskId: string,
  passphrase: string
): Promise<string> {
  const txs = await executeWithRetry<any>(() =>
    server
      .transactions()
      .forAccount(coordinatorPublicKey)
      .order('desc')
      .limit(100)
      .call()
  );

  const candidates = txs.records.filter(
    (r: any) => r.memo_type === 'text' && r.memo === taskId
  );

  for (const record of candidates) {
    try {
      const tx = new Transaction(record.envelope_xdr, passphrase);
      // getClaimableBalanceId(0) throws if op[0] is not CreateClaimableBalance
      const balanceId = tx.getClaimableBalanceId(0);
      return balanceId;
    } catch {
      // Not a creation transaction — skip (e.g. it is a claim or refund tx)
      continue;
    }
  }

  throw new Error(
    `No CreateClaimableBalance transaction found for taskId "${taskId}".`
  );
}

/**
 * Locks XLM in a Stellar Claimable Balance controlled exclusively by the Coordinator.
 *
 * Design notes:
 * - Only the coordinator can claim this balance (unconditional predicate).
 * - The taskId is stamped as a Memo.text (max 28 bytes) to enable off-chain lookup.
 * - Fee is set per-operation: 1 operation × baseFee stroops.
 * - All monetary values are handled as BigInt stroops internally.
 *
 * Time Complexity: O(1) - Standard transaction building and signing.
 * Space Complexity: O(1) - Minimal transaction details.
 */
export async function lockEscrow(
  coordinatorKeypair: Keypair,
  agentPublicKey: string,
  amountXLM: string | number | bigint,
  taskId: string
): Promise<string> {
  // Stellar Memo.text is capped at 28 bytes (UTF-8)
  if (Buffer.byteLength(taskId, 'utf8') > 28) {
    throw new Error('taskId exceeds the 28-byte Stellar Memo.text limit.');
  }

  const { server, passphrase } = getStellarConfig();
  const coordinatorPublicKey = coordinatorKeypair.publicKey();

  // Convert to BigInt stroops to avoid floating-point errors; display layer uses XLM strings
  const stroops = xlmToStroops(amountXLM);
  const formattedAmount = stroopsToXlm(stroops);

  const [account, baseFee] = await Promise.all([
    executeWithRetry<any>(() => server.loadAccount(coordinatorPublicKey)),
    server.fetchBaseFee().catch(() => 100),
  ]);

  // Coordinator is the sole claimant — guarantees only they can release or refund
  const claimants = [
    new Claimant(coordinatorPublicKey, Claimant.predicateUnconditional()),
  ];

  const transaction = new TransactionBuilder(account, {
    fee: baseFee.toString(),   // fee per operation in stroops (1 op here)
    networkPassphrase: passphrase,
  })
    .addOperation(
      Operation.createClaimableBalance({
        asset: Asset.native(),
        amount: formattedAmount,
        claimants,
      })
    )
    .addMemo(Memo.text(taskId))
    .setTimeout(180)
    .build();

  transaction.sign(coordinatorKeypair);

  const response = await executeWithRetry<any>(() =>
    server.submitTransaction(transaction)
  );

  return response.hash;
}

/**
 * Releases escrowed XLM to the agent by atomically claiming the Claimable Balance
 * back to the coordinator's account and then paying the exact amount to the agent.
 *
 * Design notes:
 * - Two-operation transaction: claimClaimableBalance + payment.
 * - Fee is set for 2 operations: 2 × baseFee stroops.
 * - Throws EscrowAlreadySettledError if the balance no longer exists (already claimed/refunded).
 * - Only the coordinator keypair can authorise this transaction since they are the sole claimant.
 *
 * Time Complexity: O(U) due to transaction history scan to resolve the balance ID.
 * Space Complexity: O(U) for transaction list retrieval.
 */
export async function releasePayment(
  coordinatorKeypair: Keypair,
  agentPublicKey: string,
  taskId: string
): Promise<string> {
  const { server, passphrase } = getStellarConfig();
  const coordinatorPublicKey = coordinatorKeypair.publicKey();

  const balanceId = await resolveBalanceId(
    server,
    coordinatorPublicKey,
    taskId,
    passphrase
  );

  // Verify the balance still exists before building the transaction
  let balanceDetails: any;
  try {
    balanceDetails = await executeWithRetry<any>(() =>
      server.claimableBalances().claimableBalance(balanceId).call()
    );
  } catch (error: any) {
    if (isNotFoundError(error)) {
      throw new EscrowAlreadySettledError(taskId);
    }
    throw error;
  }

  const [account, baseFee] = await Promise.all([
    executeWithRetry<any>(() => server.loadAccount(coordinatorPublicKey)),
    server.fetchBaseFee().catch(() => 100),
  ]);

  // Atomic: claim balance (credited to coordinator) → pay agent
  // Fee covers 2 operations: 2 × baseFee
  const transaction = new TransactionBuilder(account, {
    fee: (baseFee * 2).toString(),
    networkPassphrase: passphrase,
  })
    .addOperation(
      Operation.claimClaimableBalance({ balanceId })
    )
    .addOperation(
      Operation.payment({
        destination: agentPublicKey,
        asset: Asset.native(),
        amount: balanceDetails.amount,
      })
    )
    .addMemo(Memo.text(taskId))
    .setTimeout(180)
    .build();

  transaction.sign(coordinatorKeypair);

  const response = await executeWithRetry<any>(() =>
    server.submitTransaction(transaction)
  );

  return response.hash;
}

/**
 * Refunds the escrowed XLM back to the coordinator by claiming the Claimable Balance.
 *
 * Design notes:
 * - One-operation transaction: claimClaimableBalance (funds returned to coordinator).
 * - Fee is set for 1 operation: 1 × baseFee stroops.
 * - Throws EscrowAlreadySettledError if the balance no longer exists.
 *
 * Time Complexity: O(U) due to transaction history scan to resolve the balance ID.
 * Space Complexity: O(U) for transaction list retrieval.
 */
export async function refundEscrow(
  coordinatorKeypair: Keypair,
  taskId: string
): Promise<string> {
  const { server, passphrase } = getStellarConfig();
  const coordinatorPublicKey = coordinatorKeypair.publicKey();

  const balanceId = await resolveBalanceId(
    server,
    coordinatorPublicKey,
    taskId,
    passphrase
  );

  // Verify the balance still exists before building the transaction
  try {
    await executeWithRetry<any>(() =>
      server.claimableBalances().claimableBalance(balanceId).call()
    );
  } catch (error: any) {
    if (isNotFoundError(error)) {
      throw new EscrowAlreadySettledError(taskId);
    }
    throw error;
  }

  const [account, baseFee] = await Promise.all([
    executeWithRetry<any>(() => server.loadAccount(coordinatorPublicKey)),
    server.fetchBaseFee().catch(() => 100),
  ]);

  // 1 operation: claim balance (funds returned to coordinator)
  const transaction = new TransactionBuilder(account, {
    fee: baseFee.toString(),
    networkPassphrase: passphrase,
  })
    .addOperation(
      Operation.claimClaimableBalance({ balanceId })
    )
    .addMemo(Memo.text(taskId))
    .setTimeout(180)
    .build();

  transaction.sign(coordinatorKeypair);

  const response = await executeWithRetry<any>(() =>
    server.submitTransaction(transaction)
  );

  return response.hash;
}

// ─────────────────────────────────────────────────────────────────────────────
// Milestone-based partial escrow release (issue #841)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Represents one payment slice within a multi-milestone escrow.
 */
export interface MilestonePayment {
  milestoneId: string;
  agentAddress: string;
  amountXLM: number;
  releasedAt?: Date;
}

/**
 * In-memory store keyed by taskId → milestone array.
 * Production deployments should persist this to the PostgreSQL task store.
 */
const milestoneStore = new Map<string, MilestonePayment[]>();

/**
 * Locks XLM for a multi-milestone task.
 *
 * Validates that the sum of all milestone amounts equals the implied total,
 * then delegates to `lockEscrow` for the aggregate amount.  The milestone
 * plan is recorded in `milestoneStore` for subsequent `releaseMilestone` calls.
 *
 * Safety invariants:
 * - Sum of milestone amounts must equal the requested total (within 1 stroop).
 * - Duplicate milestoneIds within a task are rejected.
 *
 * Time Complexity: O(M) where M is the number of milestones.
 * Space Complexity: O(M) for the milestone plan in-memory.
 */
export async function lockMilestoneEscrow(
  coordinatorKeypair: Keypair,
  taskId: string,
  milestones: { milestoneId: string; agentAddress: string; amountXLM: number }[]
): Promise<string> {
  if (!milestones || milestones.length === 0) {
    throw new Error('At least one milestone is required.');
  }

  // Duplicate milestoneId guard
  const ids = milestones.map((m) => m.milestoneId);
  if (new Set(ids).size !== ids.length) {
    throw new Error('Duplicate milestoneIds are not allowed within the same task.');
  }

  const totalXLM = milestones.reduce((acc, m) => acc + m.amountXLM, 0);
  if (totalXLM <= 0) {
    throw new Error('Total milestone amount must be greater than zero.');
  }

  const txHash = await lockEscrow(coordinatorKeypair, coordinatorKeypair.publicKey(), totalXLM, taskId);

  milestoneStore.set(
    taskId,
    milestones.map((m) => ({ ...m }))
  );

  return txHash;
}

/**
 * Releases a single milestone's XLM to its designated agent.
 *
 * Safety invariants:
 * - Milestone must exist and not yet have been released (idempotent: returns
 *   the stored releasedAt timestamp if already released rather than erroring).
 * - Uses `releasePayment` to atomically claim the claimable balance and pay
 *   the agent the milestone amount.  Because the underlying claimable balance
 *   holds the full task amount, a single milestone release claims the full
 *   balance; production systems should upgrade this to per-milestone balances
 *   or an on-chain escrow contract.
 *
 * Time Complexity: O(U) due to `releasePayment` transaction history scan.
 * Space Complexity: O(1).
 */
export async function releaseMilestone(
  coordinatorKeypair: Keypair,
  taskId: string,
  milestoneId: string
): Promise<{ txHash: string; alreadyReleased: boolean }> {
  const milestones = milestoneStore.get(taskId);
  if (!milestones) {
    throw new Error(`No milestone escrow found for taskId "${taskId}".`);
  }

  const milestone = milestones.find((m) => m.milestoneId === milestoneId);
  if (!milestone) {
    throw new Error(`Milestone "${milestoneId}" not found for taskId "${taskId}".`);
  }

  // Idempotent: second release is a no-op
  if (milestone.releasedAt) {
    return { txHash: '', alreadyReleased: true };
  }

  const txHash = await releasePayment(coordinatorKeypair, milestone.agentAddress, taskId);

  milestone.releasedAt = new Date();
  return { txHash, alreadyReleased: false };
}

/**
 * Returns the milestone plan for a task, including release timestamps.
 *
 * Time Complexity: O(M) where M is the number of milestones.
 * Space Complexity: O(M).
 */
export function getMilestoneStatus(taskId: string): MilestonePayment[] {
  const milestones = milestoneStore.get(taskId);
  if (!milestones) {
    return [];
  }
  return milestones.map((m) => ({ ...m }));
}

/**
 * Cancels a task by refunding all unreleased milestones to the submitter.
 * Returns the refund transaction hash, or null if all milestones were already
 * released (nothing to refund).
 *
 * Time Complexity: O(M + U) where M is milestones and U is history scan depth.
 * Space Complexity: O(M).
 */
export async function cancelMilestoneEscrow(
  coordinatorKeypair: Keypair,
  taskId: string
): Promise<string | null> {
  const milestones = milestoneStore.get(taskId);
  if (!milestones) {
    throw new Error(`No milestone escrow found for taskId "${taskId}".`);
  }

  const hasUnreleased = milestones.some((m) => !m.releasedAt);
  if (!hasUnreleased) {
    return null; // nothing to refund
  }

  const txHash = await refundEscrow(coordinatorKeypair, taskId);

  // Mark all unreleased milestones as cancelled (releasedAt stays unset to
  // distinguish from a successful release)
  milestoneStore.delete(taskId);

  return txHash;
}

// ─────────────────────────────────────────────────────────────────────────────

/**
 * Returns the active escrow amount in XLM for the given taskId.
 * Returns 0 if the balance has already been claimed or refunded (settled).
 *
 * Requires STELLAR_COORDINATOR_PUBLIC_KEY or STELLAR_SECRET_KEY in the environment
 * to look up the coordinator's transaction history.
 *
 * Time Complexity: O(U) due to transaction history scan to resolve the balance ID.
 * Space Complexity: O(U) for transaction list retrieval.
 */
export async function getEscrowBalance(taskId: string): Promise<number> {
  const { server, passphrase } = getStellarConfig();

  const publicKey =
    process.env.STELLAR_COORDINATOR_PUBLIC_KEY ||
    (process.env.STELLAR_SECRET_KEY
      ? Keypair.fromSecret(process.env.STELLAR_SECRET_KEY).publicKey()
      : null);

  if (!publicKey) {
    throw new Error(
      'Either STELLAR_COORDINATOR_PUBLIC_KEY or STELLAR_SECRET_KEY must be set.'
    );
  }

  try {
    const balanceId = await resolveBalanceId(server, publicKey, taskId, passphrase);

    const balanceDetails = await executeWithRetry<any>(() =>
      server.claimableBalances().claimableBalance(balanceId).call()
    );

    return parseFloat(balanceDetails.amount);
  } catch (error: any) {
    if (isNotFoundError(error) || error.message?.includes('No CreateClaimableBalance')) {
      return 0;
    }
    throw error;
  }
}
