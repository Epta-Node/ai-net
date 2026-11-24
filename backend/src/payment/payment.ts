import {
  Keypair,
  Server,
  TransactionBuilder,
  Operation,
  Asset,
  Claimant,
  Memo,
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
import { currentTraceId, toW3cTraceId } from "../services/traceContext";
import { getConfig, stellarClientOptions } from "../config";
import { getCircuitBreaker } from "../services/circuitBreaker.js";
import { createLogger } from "../utils/logger";

const logger = createLogger({ component: "payment" });

const TRANSIENT_HTTP_STATUSES = new Set([408, 429, 500, 502, 503, 504]);
const TRANSIENT_NETWORK_CODES = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ENOTFOUND",
  "EAI_AGAIN",
  "ECONNABORTED",
  "ETIMEDOUT",
]);

interface StellarFailure {
  name?: string;
  code?: string;
  message?: string;
  status?: number;
  response?: {
    status?: number;
    data?: {
      status?: number;
      extras?: { result_codes?: { transaction?: string } };
    };
  };
}

export function isTransientStellarError(err: unknown): boolean {
  const failure = (err ?? {}) as StellarFailure;
  const status = Number(
    failure.status ?? failure.response?.status ?? failure.response?.data?.status ?? 0,
  );
  const transactionCode = failure.response?.data?.extras?.result_codes?.transaction ?? "";

  if (
    failure.name === "NotFoundError" ||
    failure.name === "BadRequestError" ||
    failure.name === "AccountRequiresMemoError" ||
    [400, 401, 403, 404, 422].includes(status)
  ) {
    return false;
  }
  if (transactionCode === "tx_too_late") return true;
  if (transactionCode) return false;
  if (TRANSIENT_NETWORK_CODES.has(failure.code ?? "")) return true;
  if (TRANSIENT_HTTP_STATUSES.has(status)) return true;

  const message = failure.message ?? "";
  return (
    /network error|timeout|service unavailable|too[_\s]many[_\s]requests/i.test(message) ||
    /\b(408|429|500|502|503|504)\b/.test(message)
  );
}

export function retryDelayMs(attempt: number, baseMs: number, maxMs: number): number {
  return Math.min(maxMs, baseMs * 2 ** Math.max(0, attempt - 1));
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
  private readonly maxRetries: number;
  private readonly retryBaseMs: number;
  private readonly retryMaxMs: number;
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
    this.maxRetries = config.STELLAR_PAYMENT_MAX_RETRIES;
    this.retryBaseMs = config.STELLAR_PAYMENT_RETRY_BASE_MS;
    this.retryMaxMs = config.STELLAR_PAYMENT_RETRY_MAX_MS;
  }

  private async withRetry<T>(operation: string, fn: () => Promise<T>): Promise<T> {
    let attempt = 0;
    for (;;) {
      try {
        return await fn();
      } catch (err) {
        if (!isTransientStellarError(err)) throw err;
        if (attempt >= this.maxRetries) {
          throw new HorizonUnavailableError(this.maxRetries + 1);
        }

        attempt += 1;
        const delayMs = retryDelayMs(attempt, this.retryBaseMs, this.retryMaxMs);
        logger.warn(
          { err, operation, attempt, maxRetries: this.maxRetries, delayMs },
          "transient Stellar Horizon failure; retrying"
        );
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }
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
        this.withRetry("loadAccount", () => this.server.loadAccount(coordinatorKeypair.publicKey()))
      );

      const txBuilder = new TransactionBuilder(account, {
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
        );
      // Carry the W3C trace id on-chain so an escrow can be tied back to the
      // request that locked it (#856). Stellar memos cap at 28 bytes, so the
      // 32-char hex trace id is truncated.
      if (traceId) {
        txBuilder.addMemo(Memo.text(toW3cTraceId(traceId).slice(0, 28)));
      }
      const tx = txBuilder.setTimeout(30).build();

      const balanceId = tx.getClaimableBalanceId(0);
      tx.sign(coordinatorKeypair);

      await this.horizonBreaker.execute(() =>
        this.withRetry("submitTransaction", () => this.server.submitTransaction(tx))
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
      logger.info(
        { paymentId: balanceId, taskId, nodeId, amount: amountXLM, amountStroops, recipient: agentPublicKey },
        "payment escrow locked"
      );
      return balanceId;
    } catch (err) {
      if (span) tracingService.endSpan(span.spanId, 'failed', { error: String(err) });
      logger.error(
        { err, paymentId: taskId, taskId, nodeId, amount: amountXLM, recipient: agentPublicKey },
        "failed to lock payment escrow"
      );
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
        this.withRetry("loadAccount", () => this.server.loadAccount(coordinatorKeypair.publicKey()))
      );

      const txBuilder = new TransactionBuilder(account, {
        fee: BASE_FEE,
        networkPassphrase: this.networkPassphrase,
      })
        .addOperation(
          Operation.claimClaimableBalance({ balanceId: record.balanceId })
        );
      // Mirror the lock memo so release and escrow stay joinable by trace id.
      if (traceId) {
        txBuilder.addMemo(Memo.text(toW3cTraceId(traceId).slice(0, 28)));
      }
      const tx = txBuilder.setTimeout(30).build();

      tx.sign(coordinatorKeypair);

      const result = await this.horizonBreaker.execute(() =>
        this.withRetry("submitTransaction", () => this.server.submitTransaction(tx))
      );
      const txHash = (result as unknown as { hash: string }).hash;

      this.db.updateStatus(taskId, nodeId, "released", txHash);

      this.hooks.reconciliationHook?.({
        ...record,
        status: "released",
        txHash,
      });

      if (span) tracingService.endSpan(span.spanId, 'completed', { txHash });
      logger.info(
        { paymentId: record.balanceId, txHash, taskId, nodeId, amount: record.amountStroops.toString(), recipient: nodeId },
        "payment released"
      );
      return txHash;
    } catch (err) {
      if (span) tracingService.endSpan(span.spanId, 'failed', { error: String(err) });
      logger.error(
        { err, paymentId: record.balanceId, taskId, nodeId, amount: record.amountStroops.toString(), recipient: nodeId },
        "failed to release payment"
      );
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
      logger.warn(
        { paymentId: record.balanceId, taskId, nodeId, amount: record.amountStroops.toString(), recipient: nodeId },
        "attempted to refund an already released payment"
      );
      throw new PaymentAlreadyReleasedError(taskId, nodeId);
    }

    try {
      const account = await this.horizonBreaker.execute(() =>
        this.withRetry("loadAccount", () => this.server.loadAccount(coordinatorKeypair.publicKey()))
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
        this.withRetry("submitTransaction", () => this.server.submitTransaction(tx))
      );
      const txHash = (result as unknown as { hash: string }).hash;

      this.db.updateStatus(taskId, nodeId, "refunded", txHash);
      logger.info(
        { paymentId: record.balanceId, txHash, taskId, nodeId, amount: record.amountStroops.toString(), recipient: nodeId },
        "payment refunded"
      );
      return txHash;
    } catch (err) {
      logger.error(
        { err, paymentId: record.balanceId, taskId, nodeId, amount: record.amountStroops.toString(), recipient: nodeId },
        "failed to refund payment"
      );
      throw err;
    }
  }

  getPaymentStatus(taskId: string, nodeId: string): PaymentRecord | undefined {
    return this.db.findByKey(taskId, nodeId);
  }
}
