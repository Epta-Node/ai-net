import {
  Keypair,
  Server,
  TransactionBuilder,
  Operation,
  Asset,
  Claimant,
  BASE_FEE,
  Networks,
} from "@stellar/stellar-sdk";
import type { PaymentDb, PaymentRecord } from "../db/index";
import {
  PaymentAlreadyReleasedError,
  HorizonUnavailableError,
  xlmToStroops,
  stroopsToXlm,
} from "./utils";
import { tracingService } from "../services/tracing";

const STELLAR_HORIZON =
  process.env.STELLAR_HORIZON ?? "https://horizon-testnet.stellar.org";
const STELLAR_NETWORK =
  process.env.STELLAR_NETWORK ?? Networks.TESTNET;
const MAX_RETRIES = 5;

function isRetryable(err: unknown): boolean {
  const message = (err as { message?: string })?.message ?? "";
  // Horizon error codes for TIMEOUT and TOO_MANY_REQUESTS
  const extras = (
    err as {
      response?: { data?: { extras?: { result_codes?: { transaction?: string } } } };
    }
  )?.response?.data?.extras?.result_codes?.transaction ?? "";
  return (
    message.includes("TIMEOUT") ||
    message.includes("TOO_MANY_REQUESTS") ||
    message.includes("504") ||
    message.includes("429") ||
    extras === "tx_too_late"
  );
}

async function withRetry<T>(fn: () => Promise<T>): Promise<T> {
  let attempt = 0;
  while (true) {
    try {
      return await fn();
    } catch (err) {
      attempt++;
      if (!isRetryable(err) || attempt >= MAX_RETRIES) {
        if (isRetryable(err)) throw new HorizonUnavailableError(MAX_RETRIES);
        throw err;
      }
      await new Promise((r) => setTimeout(r, 200 * 2 ** (attempt - 1)));
    }
  }
}

export interface PaymentServiceHooks {
  /**
   * Invoked after a payment is successfully released on-chain so callers can
   * trigger a reconciliation check (e.g. `ReconciliationService.run('release')`).
   */
  reconciliationHook?: (record: PaymentRecord) => void;
}

export class PaymentService {
  private server: Server;

  constructor(
    private db: PaymentDb,
    private hooks: PaymentServiceHooks = {}
  ) {
    this.server = new Server(STELLAR_HORIZON);
  }

  /**
   * Enumerate all local payment records — the reconciliation source of truth.
   */
  listLocalRecords(): PaymentRecord[] {
    return this.db.listAll();
  }

  async lock(
    taskId: string,
    nodeId: string,
    coordinatorKeypair: Keypair,
    agentPublicKey: string,
    amountXLM: number,
    correlationId?: string
  ): Promise<string> {
    const span = correlationId
      ? tracingService.startSpan(correlationId, 'payment', 'lock', { taskId, nodeId, amountXLM })
      : null;

    try {
      const amountStroops = xlmToStroops(amountXLM);
      const amountStr = stroopsToXlm(amountStroops);

      const account = await withRetry(() =>
        this.server.loadAccount(coordinatorKeypair.publicKey())
      );

      const tx = new TransactionBuilder(account, {
        fee: BASE_FEE,
        networkPassphrase: STELLAR_NETWORK,
      })
        .addOperation(
          Operation.createClaimableBalance({
            asset: Asset.native(),
            amount: amountStr,
            claimants: [
              new Claimant(agentPublicKey, Claimant.predicateUnconditional()),
              new Claimant(coordinatorKeypair.publicKey(), Claimant.predicateUnconditional()),
            ],
          })
        )
        .setTimeout(30)
        .build();

      // Derive balance ID before signing — deterministic from the operation
      const balanceId = tx.getClaimableBalanceId(0);

      tx.sign(coordinatorKeypair);

      await withRetry(() => this.server.submitTransaction(tx));

      this.db.insert({
        taskId,
        nodeId,
        balanceId,
        status: "locked",
        amountStroops,
        txHash: null,
      });

      if (span) tracingService.endSpan(span.spanId, 'completed', { balanceId });
      return balanceId;
    } catch (err) {
      if (span) tracingService.endSpan(span.spanId, 'failed', { error: String(err) });
      throw err;
    }
  }

  async release(
    taskId: string,
    nodeId: string,
    coordinatorKeypair: Keypair,
    correlationId?: string
  ): Promise<string> {
    const record = this.db.findByKey(taskId, nodeId);
    if (!record) throw new Error(`No payment record for task=${taskId} node=${nodeId}`);

    // Idempotency: return existing hash without a second Stellar tx
    if (record.status === "released" && record.txHash) {
      return record.txHash;
    }

    const span = correlationId
      ? tracingService.startSpan(correlationId, 'payment', 'release', { taskId, nodeId })
      : null;

    try {
      const account = await withRetry(() =>
        this.server.loadAccount(coordinatorKeypair.publicKey())
      );

      const tx = new TransactionBuilder(account, {
        fee: BASE_FEE,
        networkPassphrase: STELLAR_NETWORK,
      })
        .addOperation(
          Operation.claimClaimableBalance({ balanceId: record.balanceId })
        )
        .setTimeout(30)
        .build();

      tx.sign(coordinatorKeypair);

      const result = await withRetry(() => this.server.submitTransaction(tx));
      const txHash = (result as unknown as { hash: string }).hash;

      this.db.updateStatus(taskId, nodeId, "released", txHash);

      this.hooks.reconciliationHook?.({
        ...record,
        status: "released",
        txHash,
      });

      if (span) tracingService.endSpan(span.spanId, 'completed', { txHash });
      return txHash;
    } catch (err) {
      if (span) tracingService.endSpan(span.spanId, 'failed', { error: String(err) });
      throw err;
    }
  }

  async refund(
    taskId: string,
    nodeId: string,
    coordinatorKeypair: Keypair
  ): Promise<string> {
    const record = this.db.findByKey(taskId, nodeId);
    if (!record) throw new Error(`No payment record for task=${taskId} node=${nodeId}`);

    if (record.status === "released") {
      throw new PaymentAlreadyReleasedError(taskId, nodeId);
    }

    const account = await withRetry(() =>
      this.server.loadAccount(coordinatorKeypair.publicKey())
    );

    const tx = new TransactionBuilder(account, {
      fee: BASE_FEE,
      networkPassphrase: STELLAR_NETWORK,
    })
      .addOperation(
        Operation.claimClaimableBalance({ balanceId: record.balanceId })
      )
      .setTimeout(30)
      .build();

    tx.sign(coordinatorKeypair);

    const result = await withRetry(() => this.server.submitTransaction(tx));
    const txHash = (result as unknown as { hash: string }).hash;

    this.db.updateStatus(taskId, nodeId, "refunded", txHash);
    return txHash;
  }

  getPaymentStatus(taskId: string, nodeId: string): PaymentRecord | undefined {
    return this.db.findByKey(taskId, nodeId);
  }
}
