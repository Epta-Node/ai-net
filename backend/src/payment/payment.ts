import {
  Keypair,
  Server,
  TransactionBuilder,
  Operation,
  Asset,
  Claimant,
  BASE_FEE,
} from "@stellar/stellar-sdk";
import type { PaymentDb, PaymentRecord } from "../db/index";
import {
  PaymentAlreadyReleasedError,
  HorizonUnavailableError,
  xlmToStroops,
  stroopsToXlm,
} from "./utils";
import { tracingService } from "../services/tracing";
import { currentTraceId } from "../services/traceContext";
import { getConfig, stellarClientOptions } from "../config";
import { getCircuitBreaker } from "../services/circuitBreaker.js";

const MAX_RETRIES = 5;

function isRetryable(err: unknown): boolean {
  const message = (err as { message?: string })?.message ?? "";
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
  for (;;) {
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
  private networkPassphrase: string;
  private readonly horizonBreaker = getCircuitBreaker({
    name: 'stellar-horizon',
    failureThreshold: 3,
    recoveryTimeoutMs: 60_000,
  });

  constructor(
    private db: PaymentDb,
    private hooks: PaymentServiceHooks = {}
  ) {
    const config = getConfig();
    this.server = new Server(config.STELLAR_HORIZON_URL, stellarClientOptions(config));
    this.networkPassphrase = config.STELLAR_NETWORK_PASSPHRASE;
  }

  /** Enumerate all local payment records — the reconciliation source of truth. */
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
    const traceId = correlationId ?? currentTraceId();
    const span = traceId
      ? tracingService.startSpan(traceId, 'payment', 'lock', { taskId, nodeId, amountXLM })
      : null;

    try {
      const amountStroops = xlmToStroops(amountXLM);
      const amountStr = stroopsToXlm(amountStroops);

      const account = await this.horizonBreaker.execute(() =>
        withRetry(() => this.server.loadAccount(coordinatorKeypair.publicKey()))
      );

      const tx = new TransactionBuilder(account, {
        fee: BASE_FEE,
        networkPassphrase: this.networkPassphrase,
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

      const balanceId = tx.getClaimableBalanceId(0);
      tx.sign(coordinatorKeypair);

      await this.horizonBreaker.execute(() =>
        withRetry(() => this.server.submitTransaction(tx))
      );

      const now = new Date().toISOString();
      this.db.insert({
        taskId,
        nodeId,
        balanceId,
        status: "locked",
        amountStroops,
        txHash: null,
        // The escrow's age is what lets reconciliation decide whether a still
        // locked payment is expired (issue #496).
        createdAt: now,
        updatedAt: now,
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

    if (record.status === "released" && record.txHash) {
      return record.txHash;
    }

    const traceId = correlationId ?? currentTraceId();
    const span = traceId
      ? tracingService.startSpan(traceId, 'payment', 'release', { taskId, nodeId })
      : null;

    try {
      const account = await this.horizonBreaker.execute(() =>
        withRetry(() => this.server.loadAccount(coordinatorKeypair.publicKey()))
      );

      const tx = new TransactionBuilder(account, {
        fee: BASE_FEE,
        networkPassphrase: this.networkPassphrase,
      })
        .addOperation(
          Operation.claimClaimableBalance({ balanceId: record.balanceId })
        )
        .setTimeout(30)
        .build();

      tx.sign(coordinatorKeypair);

      const result = await this.horizonBreaker.execute(() =>
        withRetry(() => this.server.submitTransaction(tx))
      );
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

    const account = await this.horizonBreaker.execute(() =>
      withRetry(() => this.server.loadAccount(coordinatorKeypair.publicKey()))
    );

    const tx = new TransactionBuilder(account, {
      fee: BASE_FEE,
      networkPassphrase: this.networkPassphrase,
    })
      .addOperation(
        Operation.claimClaimableBalance({ balanceId: record.balanceId })
      )
      .setTimeout(30)
      .build();

    tx.sign(coordinatorKeypair);

    const result = await this.horizonBreaker.execute(() =>
      withRetry(() => this.server.submitTransaction(tx))
    );
    const txHash = (result as unknown as { hash: string }).hash;

    this.db.updateStatus(taskId, nodeId, "refunded", txHash);
    return txHash;
  }

  getPaymentStatus(taskId: string, nodeId: string): PaymentRecord | undefined {
    return this.db.findByKey(taskId, nodeId);
  }
}
