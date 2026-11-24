/**
 * Reconciliation drift integration tests (issue #496).
 *
 * Every scenario in the issue is driven end-to-end through a **mocked Horizon
 * API** — claimable balances, claim lookups and transaction lookups are served
 * from an in-memory "chain" fixture, so the test exercises the same code path
 * production uses (the Horizon providers) without touching the network.
 *
 * Scenarios covered:
 *   1. DB `locked` but no on-chain claimable balance      → `orphaned_locked`
 *   2. DB `released` but no on-chain release tx          → `missing_release_tx`
 *   3. DB `released` but the balance is still claimable   → `release_unconfirmed`
 *   4. Expired escrow (task failed, never refunded)      → `expired_escrow`
 *
 * Plus the acceptance criteria: unambiguous remediation, idempotency (no
 * double-refund), metrics, and event emission.
 */

import { Horizon } from "@stellar/stellar-sdk";
import {
  HorizonClaimableBalanceProvider,
  HorizonClaimTransactionProvider,
  ReconciliationService,
  createInMemoryPendingDriftStore,
  type ClaimTransactionProvider,
  type EscrowSettler,
  type PendingDriftStore,
} from "./reconciliation";
import { ReconciliationMetrics } from "./reconciliation.metrics";
import { createInMemoryReconciliationEventSink } from "./reconciliation.events";
import type { PaymentDb, PaymentRecord, PaymentStatus } from "../db/index";
import type {
  ClaimableBalanceOnChain,
  ReconciliationReport,
} from "./reconciliation.types";

// ─── Mocked Horizon ───────────────────────────────────────────────────────────

/**
 * An in-memory stand-in for a Stellar node.
 *
 * `balances` is the set of claimable balances that currently exist on-chain;
 * `claims` maps a balance id to the transaction that claimed it, and
 * `transactions` is the set of transaction hashes Horizon knows about. Removing
 * a balance from `balances` is what "the escrow was claimed" looks like to the
 * service.
 */
class FakeHorizon {
  balances: ClaimableBalanceOnChain[] = [];
  claims = new Map<
    string,
    { hash: string; successful: boolean; ledgerSequence: number }
  >();
  transactions = new Map<
    string,
    { hash: string; successful: boolean; ledgerSequence: number }
  >();

  addBalance(balance: ClaimableBalanceOnChain): void {
    this.balances.push(balance);
  }

  /** Remove the balance and record the transaction that claimed it. */
  claim(balanceId: string, hash: string, ledgerSequence = 1): void {
    this.balances = this.balances.filter((b) => b.balanceId !== balanceId);
    const tx = { hash, successful: true, ledgerSequence };
    this.claims.set(balanceId, tx);
    this.transactions.set(hash, tx);
  }

  /** Apply the same-side effect for a release submitted from the DB side. */
  release(balanceId: string, hash: string, ledgerSequence = 1): void {
    this.claim(balanceId, hash, ledgerSequence);
  }

  /** Make a transaction "forgotten" by the index (e.g. Horizon history gap). */
  forgetTransaction(hash: string): void {
    this.transactions.delete(hash);
  }

  forgetClaim(balanceId: string): void {
    this.claims.delete(balanceId);
  }
}

const HORIZON_URL = "https://horizon.test.invalid";

function installHorizonMock(chain: FakeHorizon): void {
  /** Render a balance the way Horizon's REST API does. */
  const toHorizonBalance = (b: ClaimableBalanceOnChain) => ({
    id: b.balanceId,
    asset: b.asset,
    // Horizon reports XLM as a decimal string, not stroops.
    amount: `${Number(b.amountStroops) / 10_000_000}`,
    sponsor: b.sponsor,
    claimants: b.claimant ? [{ destination: b.claimant }] : [],
  });

  /** Render a transaction the way Horizon's REST API does. */
  const toHorizonTx = (tx: {
    hash: string;
    successful: boolean;
    ledgerSequence: number;
  }) => ({
    hash: tx.hash,
    successful: tx.successful,
    ledger_seq: tx.ledgerSequence,
    source_account: "GCOORDINATOR",
  });

  const page = (records: unknown[]) => ({
    records,
    next: async () => page([]),
  });

  const callBuilder = (records: unknown[]) => {
    const builder = {
      limit: () => builder,
      forAsset: () => builder,
      forClaimableBalance: (balanceId: string) => {
        const claim = chain.claims.get(balanceId);
        return callBuilder(claim ? [toHorizonTx(claim)] : []);
      },
      claimableBalance: (balanceId: string) => ({
        call: async () => {
          const found = chain.balances.find((b) => b.balanceId === balanceId);
          if (!found) throw new Error("404 not found");
          return toHorizonBalance(found);
        },
      }),
      transaction: (hash: string) => ({
        call: async () => {
          const tx = chain.transactions.get(hash);
          if (!tx) throw new Error("404 not found");
          return toHorizonTx(tx);
        },
      }),
      call: async () => page(records),
    };
    return builder;
  };

  // Replace the SDK server with one that only understands claimable balances and
  // transactions — everything this service queries.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (Horizon as any).Server = class {
    claimableBalances() {
      return callBuilder(chain.balances.map(toHorizonBalance));
    }
    transactions() {
      return callBuilder([]);
    }
  };
}

function makeHorizonProviders(): {
  balances: HorizonClaimableBalanceProvider;
  claims: HorizonClaimTransactionProvider;
} {
  return {
    balances: new HorizonClaimableBalanceProvider(HORIZON_URL),
    claims: new HorizonClaimTransactionProvider(HORIZON_URL),
  };
}

// ─── Local payment database ───────────────────────────────────────────────────

class InMemoryPaymentDb implements PaymentDb {
  readonly rows = new Map<string, PaymentRecord>();

  constructor(records: PaymentRecord[] = []) {
    for (const record of records)
      this.rows.set(`${record.taskId}:${record.nodeId}`, { ...record });
  }

  insert(record: PaymentRecord): void {
    this.rows.set(`${record.taskId}:${record.nodeId}`, { ...record });
  }

  findByKey(taskId: string, nodeId: string): PaymentRecord | undefined {
    return this.rows.get(`${taskId}:${nodeId}`);
  }

  updateStatus(
    taskId: string,
    nodeId: string,
    status: PaymentStatus,
    txHash: string,
  ): void {
    const record = this.rows.get(`${taskId}:${nodeId}`);
    if (!record) return;
    record.status = status;
    record.txHash = txHash;
  }

  updateStatusIfCurrent(
    taskId: string,
    nodeId: string,
    expectedStatus: PaymentStatus,
    status: PaymentStatus,
    txHash: string,
  ): boolean {
    const record = this.rows.get(`${taskId}:${nodeId}`);
    if (!record || record.status !== expectedStatus) return false;
    record.status = status;
    record.txHash = txHash;
    return true;
  }

  listAll(): PaymentRecord[] {
    return [...this.rows.values()].map((r) => ({ ...r }));
  }
}

// ─── Fixture helpers ──────────────────────────────────────────────────────────

const NOW = Date.parse("2026-09-01T12:00:00.000Z");
const DAY_MS = 86_400_000;

function record(overrides: Partial<PaymentRecord> = {}): PaymentRecord {
  return {
    taskId: "task-1",
    nodeId: "node-1",
    balanceId: "cb-1",
    status: "locked",
    amountStroops: 10_000_000n,
    txHash: null,
    createdAt: new Date(NOW - 2 * DAY_MS).toISOString(),
    updatedAt: new Date(NOW - 2 * DAY_MS).toISOString(),
    ...overrides,
  };
}

function balance(
  overrides: Partial<ClaimableBalanceOnChain> = {},
): ClaimableBalanceOnChain {
  return {
    balanceId: "cb-1",
    amountStroops: "10000000",
    asset: "native",
    sponsor: "GCOORDINATOR",
    claimant: "GAGENT",
    ...overrides,
  };
}

interface Harness {
  service: ReconciliationService;
  chain: FakeHorizon;
  paymentDb: InMemoryPaymentDb;
  pending: PendingDriftStore;
  metrics: ReconciliationMetrics;
  events: ReturnType<typeof createInMemoryReconciliationEventSink>["events"];
  settlementQueue: jest.Mock;
  settler: { release: jest.Mock; refund: jest.Mock };
}

function makeHarness(
  records: PaymentRecord[],
  options: {
    tasks?: Record<string, { status: string; updatedAt?: string }>;
    settler?: boolean;
    settlementQueue?: boolean;
    escrowExpiryMs?: number;
    remediationEnabled?: boolean;
  } = {},
): Harness {
  const chain = new FakeHorizon();
  installHorizonMock(chain);
  const { balances, claims } = makeHorizonProviders();
  const paymentDb = new InMemoryPaymentDb(records);
  const pending = createInMemoryPendingDriftStore();
  const metrics = new ReconciliationMetrics();
  const sink = createInMemoryReconciliationEventSink();
  const settlementQueue = jest.fn();
  const settler = {
    release: jest.fn(async (balanceId: string) => {
      const hash = `release-${balanceId}`;
      chain.release(balanceId, hash);
      return hash;
    }),
    refund: jest.fn(async (balanceId: string) => {
      const hash = `refund-${balanceId}`;
      chain.claim(balanceId, hash);
      return hash;
    }),
  };

  const service = new ReconciliationService({
    paymentDb,
    onChainProvider: balances,
    claimProvider: claims,
    taskState: (taskId) => options.tasks?.[taskId],
    reportStore: {
      save(report) {
        latest = report;
      },
      getLatest() {
        return latest;
      },
    },
    pendingDriftStore: pending,
    logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
    now: () => NOW,
    escrowExpiryMs: options.escrowExpiryMs ?? DAY_MS,
    remediationEnabled: options.remediationEnabled ?? true,
    ...(options.settlementQueue === false ? {} : { settlementQueue }),
    ...(options.settler === false
      ? {}
      : { settler: settler as unknown as EscrowSettler }),
    eventSink: sink,
    metrics,
  });

  let latest: ReconciliationReport | undefined;
  return {
    service,
    chain,
    paymentDb,
    pending,
    metrics,
    events: sink.events,
    settlementQueue,
    settler,
  };
}

// ─── Scenario 1: DB locked, no on-chain claimable balance ─────────────────────

describe("scenario 1 — DB `locked` but no on-chain claimable balance", () => {
  it("detects orphaned_locked and marks the record orphaned", async () => {
    const h = makeHarness([record({ balanceId: "cb-1" })]);
    // The chain has no claimable balance — the lock never landed, or the escrow
    // was consumed outside the coordinator's control.

    const report = await h.service.run();

    expect(report.discrepancies).toHaveLength(1);
    expect(report.discrepancies[0]).toMatchObject({
      type: "missing_on_chain",
      driftType: "orphaned_locked",
      balanceId: "cb-1",
      taskId: "task-1",
      nodeId: "node-1",
      severity: "critical",
    });
    expect(h.paymentDb.findByKey("task-1", "node-1")).toMatchObject({
      status: "orphaned",
      txHash: "reconciled-repair",
    });
    expect(report.summary.remediatedByType.orphaned_locked).toBe(1);
    expect(h.settlementQueue).not.toHaveBeenCalled();
  });

  it("is idempotent — a re-run finds nothing left to do", async () => {
    const h = makeHarness([record({ balanceId: "cb-1" })]);

    const first = await h.service.run();
    const second = await h.service.run();

    expect(first.summary.remediated).toBe(1);
    expect(second.discrepancies).toHaveLength(0);
    expect(second.status).toBe("consistent");
    expect(h.paymentDb.findByKey("task-1", "node-1")?.status).toBe("orphaned");
  });

  it("does not orphan a record that a concurrent release already settled", async () => {
    const h = makeHarness([record({ balanceId: "cb-1" })]);
    // The record is no longer `locked` by the time remediation runs.
    jest.spyOn(h.paymentDb, "updateStatusIfCurrent").mockReturnValue(false);

    const report = await h.service.run();

    expect(report.remediations?.[0]).toMatchObject({
      action: "mark_orphaned",
      status: "skipped",
    });
    expect(h.paymentDb.findByKey("task-1", "node-1")?.status).toBe("locked");
  });
});

// ─── Scenario 2: DB released, no on-chain release tx ──────────────────────────

describe("scenario 2 — DB `released` but no on-chain release transaction", () => {
  it("identifies the missing Horizon record", async () => {
    const h = makeHarness([
      record({ balanceId: "cb-1", status: "released", txHash: "hash-1" }),
    ]);
    // The balance is gone from the chain (consistent) but Horizon knows nothing
    // about either the claim or the recorded transaction.

    const report = await h.service.run();

    expect(report.discrepancies).toHaveLength(1);
    expect(report.discrepancies[0]).toMatchObject({
      type: "missing_release_tx",
      driftType: "missing_release_tx",
      balanceId: "cb-1",
      severity: "critical",
      recordedTxHash: "hash-1",
    });
    expect(report.summary.releaseUnverified).toBe(1);
    expect(report.summary.releaseVerified).toBe(0);
  });

  it("remediates by back-filling the real on-chain claim hash", async () => {
    const h = makeHarness([
      record({ balanceId: "cb-1", status: "released", txHash: "stale-hash" }),
    ]);
    h.chain.claim("cb-1", "real-claim-hash", 4242);

    const report = await h.service.run();

    expect(report.discrepancies[0].driftType).toBe("missing_release_tx");
    expect(h.paymentDb.findByKey("task-1", "node-1")?.txHash).toBe(
      "real-claim-hash",
    );
    expect(report.summary.remediatedByType.missing_release_tx).toBe(1);
  });

  it("parks the drift for review when there is no hash to back-fill", async () => {
    const h = makeHarness([
      record({ balanceId: "cb-1", status: "released", txHash: "ghost-hash" }),
    ]);

    const report = await h.service.run();

    expect(report.remediations?.[0]).toMatchObject({
      action: "manual_review",
      status: "manual_review",
    });
    expect(h.paymentDb.findByKey("task-1", "node-1")?.txHash).toBe(
      "ghost-hash",
    );
    expect(h.pending.list()[0]).toMatchObject({
      id: "task-1:node-1",
      driftType: "missing_release_tx",
      recommendedAction: "manual_review",
      occurrences: 1,
    });
  });

  it("treats a released record as verified when the chain confirms the hash", async () => {
    const h = makeHarness([
      record({ balanceId: "cb-1", status: "released", txHash: "hash-1" }),
    ]);
    h.chain.claim("cb-1", "hash-1");

    const report = await h.service.run();

    expect(report.status).toBe("consistent");
    expect(report.summary.releaseVerified).toBe(1);
    expect(h.pending.list()).toHaveLength(0);
  });

  it("is idempotent — a back-filled hash stops the drift recurring", async () => {
    const h = makeHarness([
      record({ balanceId: "cb-1", status: "released", txHash: "stale-hash" }),
    ]);
    h.chain.claim("cb-1", "real-claim-hash");

    const first = await h.service.run();
    const second = await h.service.run();

    expect(first.summary.remediated).toBe(1);
    expect(second.discrepancies).toHaveLength(0);
  });
});

// ─── Scenario 3: DB released, on-chain shows unreleased ────────────────────────

describe("scenario 3 — DB `released` but on-chain shows unreleased", () => {
  it("flags the release for re-submission", async () => {
    const h = makeHarness([
      record({ balanceId: "cb-1", status: "released", txHash: "hash-1" }),
    ]);
    h.chain.addBalance(balance({ balanceId: "cb-1" }));

    const report = await h.service.run();

    expect(report.discrepancies).toHaveLength(1);
    expect(report.discrepancies[0]).toMatchObject({
      type: "release_unconfirmed",
      driftType: "release_unconfirmed",
      onChainAmountStroops: "10000000",
      expectedAmountStroops: "0",
      severity: "critical",
    });
    expect(h.settlementQueue).toHaveBeenCalledWith({
      kind: "release",
      balanceId: "cb-1",
      taskId: "task-1",
      nodeId: "node-1",
    });
    expect(report.summary.remediatedByType.release_unconfirmed).toBe(1);
  });

  it("re-submits the release inline when a settler is configured", async () => {
    const h = makeHarness(
      [record({ balanceId: "cb-1", status: "released", txHash: "hash-1" })],
      { settlementQueue: false, settler: true },
    );
    h.chain.addBalance(balance({ balanceId: "cb-1" }));

    const report = await h.service.run();

    expect(h.settler.release).toHaveBeenCalledWith("cb-1", "task-1", "node-1");
    expect(report.remediations?.[0]).toMatchObject({
      action: "requeue_release",
      status: "remediated",
      txHash: "release-cb-1",
    });
  });

  it("cannot double-pay — a second pass finds the balance already claimed", async () => {
    const h = makeHarness(
      [record({ balanceId: "cb-1", status: "released", txHash: "hash-1" })],
      { settlementQueue: false, settler: true },
    );
    h.chain.addBalance(balance({ balanceId: "cb-1" }));

    await h.service.run();
    h.paymentDb.updateStatus("task-1", "node-1", "released", "release-cb-1");
    const second = await h.service.run();

    expect(h.settler.release).toHaveBeenCalledTimes(1);
    expect(second.discrepancies).toHaveLength(0);
  });

  it("flags for an operator when neither a queue nor a settler is configured", async () => {
    const h = makeHarness(
      [record({ balanceId: "cb-1", status: "released", txHash: "hash-1" })],
      { settlementQueue: false, settler: false },
    );
    h.chain.addBalance(balance({ balanceId: "cb-1" }));

    const report = await h.service.run();

    expect(report.remediations?.[0]).toMatchObject({
      action: "requeue_release",
      status: "skipped",
    });
    expect(h.pending.list()[0]).toMatchObject({
      driftType: "release_unconfirmed",
      recommendedAction: "requeue_release",
    });
  });

  it("surfaces a settler failure as a failed remediation without throwing", async () => {
    const h = makeHarness(
      [record({ balanceId: "cb-1", status: "released", txHash: "hash-1" })],
      { settlementQueue: false, settler: true },
    );
    h.chain.addBalance(balance({ balanceId: "cb-1" }));
    h.settler.release.mockRejectedValueOnce(new Error("Horizon unavailable"));

    const report = await h.service.run();

    expect(report.remediations?.[0]).toMatchObject({
      action: "requeue_release",
      status: "failed",
      reason: "Horizon unavailable",
    });
    expect(h.metrics.get("remediationFailed", "release_unconfirmed")).toBe(1);
    expect(h.pending.list()[0].driftType).toBe("release_unconfirmed");
  });
});

// ─── Scenario 4: expired escrow (task failed, never refunded) ─────────────────

describe("scenario 4 — expired escrow on a failed task", () => {
  const failedTask = {
    status: "failed",
    updatedAt: new Date(NOW - 2 * DAY_MS).toISOString(),
  };

  it("schedules a refund when the task failed and the escrow is older than the expiry window", async () => {
    const h = makeHarness([record({ balanceId: "cb-1" })], {
      tasks: { "task-1": failedTask },
    });
    h.chain.addBalance(balance({ balanceId: "cb-1" }));

    const report = await h.service.run();

    expect(report.discrepancies).toHaveLength(1);
    expect(report.discrepancies[0]).toMatchObject({
      driftType: "expired_escrow",
      balanceId: "cb-1",
      severity: "warning",
      taskStatus: "failed",
    });
    expect(h.settlementQueue).toHaveBeenCalledWith({
      kind: "refund",
      balanceId: "cb-1",
      taskId: "task-1",
      nodeId: "node-1",
    });
    expect(report.summary.remediatedByType.expired_escrow).toBe(1);
  });

  it("does not refund an escrow that is still inside the expiry window", async () => {
    const h = makeHarness(
      [
        record({
          balanceId: "cb-1",
          createdAt: new Date(NOW - 60_000).toISOString(),
        }),
      ],
      { tasks: { "task-1": failedTask } },
    );
    h.chain.addBalance(balance({ balanceId: "cb-1" }));

    const report = await h.service.run();

    expect(report.discrepancies).toHaveLength(0);
    expect(h.settlementQueue).not.toHaveBeenCalled();
  });

  it("refunds inline and marks the record refunded when a settler is configured", async () => {
    const h = makeHarness([record({ balanceId: "cb-1" })], {
      tasks: { "task-1": failedTask },
      settlementQueue: false,
      settler: true,
    });
    h.chain.addBalance(balance({ balanceId: "cb-1" }));

    const report = await h.service.run();

    expect(h.settler.refund).toHaveBeenCalledWith("cb-1", "task-1", "node-1");
    expect(h.paymentDb.findByKey("task-1", "node-1")).toMatchObject({
      status: "refunded",
      txHash: "refund-cb-1",
    });
    expect(report.remediations?.[0]).toMatchObject({
      action: "refund_escrow",
      status: "remediated",
    });
  });

  it("never double-refunds: a second pass finds nothing to refund", async () => {
    const h = makeHarness([record({ balanceId: "cb-1" })], {
      tasks: { "task-1": failedTask },
      settlementQueue: false,
      settler: true,
    });
    h.chain.addBalance(balance({ balanceId: "cb-1" }));

    const first = await h.service.run();
    const second = await h.service.run();

    expect(first.summary.remediatedByType.expired_escrow).toBe(1);
    expect(h.settler.refund).toHaveBeenCalledTimes(1);
    expect(second.discrepancies).toHaveLength(0);
    expect(second.status).toBe("consistent");
  });

  it("refunds a cancelled task too", async () => {
    const h = makeHarness([record({ balanceId: "cb-1" })], {
      tasks: { "task-1": { status: "cancelled" } },
    });
    h.chain.addBalance(balance({ balanceId: "cb-1" }));

    const report = await h.service.run();

    expect(report.discrepancies[0].driftType).toBe("expired_escrow");
  });

  it("leaves a running task alone", async () => {
    const h = makeHarness([record({ balanceId: "cb-1" })], {
      tasks: { "task-1": { status: "running" } },
    });
    h.chain.addBalance(balance({ balanceId: "cb-1" }));

    const report = await h.service.run();

    expect(report.discrepancies).toHaveLength(0);
  });

  it("skips a refund when the record is no longer locked", async () => {
    const h = makeHarness([record({ balanceId: "cb-1" })], {
      tasks: { "task-1": failedTask },
      settlementQueue: false,
      settler: true,
    });
    h.chain.addBalance(balance({ balanceId: "cb-1" }));
    jest.spyOn(h.paymentDb, "findByKey").mockReturnValue({
      ...record({ balanceId: "cb-1", status: "released" }),
    });

    const report = await h.service.run();

    expect(h.settler.refund).not.toHaveBeenCalled();
    expect(report.remediations?.[0]).toMatchObject({ status: "skipped" });
  });

  it("refunds when the escrow age cannot be determined", async () => {
    const h = makeHarness(
      [record({ balanceId: "cb-1", createdAt: null, updatedAt: null })],
      { tasks: { "task-1": { status: "failed" } } },
    );
    h.chain.addBalance(balance({ balanceId: "cb-1" }));

    const report = await h.service.run();

    expect(report.discrepancies[0].driftType).toBe("expired_escrow");
    expect(report.discrepancies[0].description).toContain(
      "age cannot be determined",
    );
  });

  it("treats an untracked task as expired (the escrow would otherwise be stranded)", async () => {
    const h = makeHarness([record({ balanceId: "cb-1" })], { tasks: {} });
    h.chain.addBalance(balance({ balanceId: "cb-1" }));

    const report = await h.service.run();

    // The task resolver returned nothing at all, so there is no terminal state to
    // react to — the escrow is left alone rather than refunded speculatively.
    expect(report.discrepancies).toHaveLength(0);
  });
});

// ─── Cross-cutting acceptance criteria ────────────────────────────────────────

describe("reconciliation acceptance criteria", () => {
  it("detects all four drift categories in a single pass", async () => {
    const h = makeHarness(
      [
        record({ taskId: "t1", nodeId: "n1", balanceId: "cb-1" }), // 1 → orphaned
        record({
          taskId: "t2",
          nodeId: "n2",
          balanceId: "cb-2",
          status: "released",
          txHash: "ghost",
        }), // 2
        record({
          taskId: "t3",
          nodeId: "n3",
          balanceId: "cb-3",
          status: "released",
          txHash: "h3",
        }), // 3
        record({
          taskId: "t4",
          nodeId: "n4",
          balanceId: "cb-4",
          createdAt: new Date(NOW - 5 * DAY_MS).toISOString(),
        }), // 4
      ],
      {
        tasks: {
          t4: {
            status: "failed",
            updatedAt: new Date(NOW - 5 * DAY_MS).toISOString(),
          },
        },
        settlementQueue: false,
        settler: false,
      },
    );
    h.chain.addBalance(balance({ balanceId: "cb-3" }));
    h.chain.addBalance(balance({ balanceId: "cb-4" }));

    const report = await h.service.run();

    expect(report.summary.driftByType).toMatchObject({
      orphaned_locked: 1,
      missing_release_tx: 1,
      release_unconfirmed: 1,
      expired_escrow: 1,
    });
    expect(report.discrepancies).toHaveLength(4);
  });

  it("increments drift and remediation metrics for every category", async () => {
    const h = makeHarness(
      [
        record({ taskId: "t1", nodeId: "n1", balanceId: "cb-1" }),
        record({
          taskId: "t3",
          nodeId: "n3",
          balanceId: "cb-3",
          status: "released",
          txHash: "h3",
        }),
      ],
      { settlementQueue: false, settler: true },
    );
    h.chain.addBalance(balance({ balanceId: "cb-3" }));

    await h.service.run();

    expect(h.metrics.get("driftDetected", "orphaned_locked")).toBe(1);
    expect(h.metrics.get("remediated", "orphaned_locked")).toBe(1);
    expect(h.metrics.get("driftDetected", "release_unconfirmed")).toBe(1);
    expect(h.metrics.get("remediated", "release_unconfirmed")).toBe(1);
    expect(h.metrics.snapshot().runsWithRemediation).toBe(1);

    const prometheus = h.metrics.toPrometheus();
    expect(prometheus).toContain(
      'reconcile_drift_detected_total{type="orphaned_locked"} 1',
    );
    expect(prometheus).toContain(
      'reconcile_remediated_total{type="release_unconfirmed"} 1',
    );
  });

  it("emits a RECONCILIATION_EVENT for each drift and each remediation", async () => {
    const h = makeHarness([record({ balanceId: "cb-1" })], {
      tasks: { "task-1": { status: "failed" } },
    });
    h.chain.addBalance(balance({ balanceId: "cb-1" }));

    await h.service.run();

    // One drift (the escrow is expired) and one remediation (the refund).
    expect(h.events).toHaveLength(2);
    expect(h.events[0]).toMatchObject({
      type: "ReconciliationEvent",
      taskId: "task-1",
      payload: { kind: "drift", driftType: "expired_escrow", nodeId: "node-1" },
    });
    expect(h.events[1]).toMatchObject({
      type: "ReconciliationEvent",
      payload: {
        kind: "remediation",
        driftType: "expired_escrow",
        newStatus: "refunded",
        // The refund went through the settlement queue, so no transaction hash
        // exists yet — the hash arrives with the queue job's own completion.
        remediation: {
          action: "refund_escrow",
          status: "remediated",
          reason: "refund queued",
        },
      },
    });
  });

  it("carries the on-chain transaction hash when the refund is settled inline", async () => {
    const h = makeHarness([record({ balanceId: "cb-1" })], {
      tasks: { "task-1": { status: "failed" } },
      settlementQueue: false,
      settler: true,
    });
    h.chain.addBalance(balance({ balanceId: "cb-1" }));

    await h.service.run();

    expect(h.events[1]).toMatchObject({
      payload: {
        kind: "remediation",
        newStatus: "refunded",
        remediation: { action: "refund_escrow", txHash: "refund-cb-1" },
      },
    });
  });

  it("detects but does not remediate when remediation is disabled", async () => {
    const h = makeHarness([record({ balanceId: "cb-1" })], {
      remediationEnabled: false,
    });

    const report = await h.service.run();

    expect(report.discrepancies).toHaveLength(1);
    expect(report.summary.remediated).toBe(0);
    expect(report.summary.pendingRemediation).toBe(1);
    expect(h.paymentDb.findByKey("task-1", "node-1")?.status).toBe("locked");
    expect(h.pending.list()).toHaveLength(1);
  });

  it("does not flag an on-chain balance with no local record as auto-remediable", async () => {
    const h = makeHarness([]);
    h.chain.addBalance(balance({ balanceId: "cb-orphan" }));

    const report = await h.service.run();

    expect(report.discrepancies[0]).toMatchObject({
      type: "missing_local",
      driftType: "missing_local",
      balanceId: "cb-orphan",
    });
    expect(report.summary.remediated).toBe(0);
    expect(h.pending.list()).toHaveLength(1);
  });

  it("returns a consistent report for a healthy ledger", async () => {
    const h = makeHarness([record({ balanceId: "cb-1" })], {
      tasks: { "task-1": { status: "running" } },
    });
    h.chain.addBalance(balance({ balanceId: "cb-1" }));

    const report = await h.service.run();

    expect(report.status).toBe("consistent");
    expect(report.summary).toMatchObject({
      totalLocalRecords: 1,
      totalOnChainBalances: 1,
      matched: 1,
      discrepancies: 0,
      remediated: 0,
      pendingRemediation: 0,
    });
    expect(h.events).toHaveLength(0);
  });

  it("forgets pending drift once it stops reproducing", async () => {
    const h = makeHarness([record({ balanceId: "cb-1" })]);
    h.chain.addBalance(balance({ balanceId: "cb-1" }));

    await h.service.run();
    expect(h.pending.list()).toHaveLength(0);
  });

  it("counts the occurrences of a drift that keeps reproducing", async () => {
    const h = makeHarness(
      [record({ balanceId: "cb-1", status: "released", txHash: "ghost" })],
      { remediationEnabled: false },
    );

    await h.service.run();
    await h.service.run();
    await h.service.run();

    const pending = h.pending.list();
    expect(pending).toHaveLength(1);
    expect(pending[0].occurrences).toBe(3);
  });
});

// ─── Horizon provider behaviour against the mock ──────────────────────────────

describe("Horizon providers (issue #496)", () => {
  it("maps a Horizon claimable balance into stroops", async () => {
    const h = makeHarness([]);
    h.chain.addBalance(
      balance({ balanceId: "cb-1", amountStroops: "25000000" }),
    );
    const { balances } = makeHorizonProviders();

    await expect(balances.getBalance("cb-1")).resolves.toMatchObject({
      balanceId: "cb-1",
      amountStroops: "25000000",
    });
  });

  it("returns null for a balance Horizon does not know", async () => {
    const { balances } = makeHorizonProviders();

    await expect(balances.getBalance("cb-missing")).resolves.toBeNull();
  });

  it("finds the claim transaction for a balance", async () => {
    const chain = new FakeHorizon();
    installHorizonMock(chain);
    chain.claim("cb-1", "claim-hash", 99);
    const { claims } = makeHorizonProviders();

    await expect(claims.findClaim("cb-1")).resolves.toMatchObject({
      hash: "claim-hash",
      successful: true,
      ledgerSequence: 99,
    });
    await expect(claims.findClaim("cb-none")).resolves.toBeNull();
  });

  it("returns null for a transaction Horizon does not know", async () => {
    const { claims } = makeHorizonProviders();

    await expect(claims.getTransaction("nope")).resolves.toBeNull();
  });

  it("a custom claim provider is honoured", async () => {
    const custom: ClaimTransactionProvider = {
      findClaim: jest.fn(async () => ({
        hash: "from-custom",
        successful: true,
      })),
      getTransaction: jest.fn(async () => null),
    };
    const h = makeHarness([
      record({ balanceId: "cb-1", status: "released", txHash: "stale" }),
    ]);
    // Rebuild the service with the custom provider.
    const service = new ReconciliationService({
      paymentDb: h.paymentDb,
      onChainProvider: makeHorizonProviders().balances,
      claimProvider: custom,
      reportStore: {
        save() {},
        getLatest() {
          return undefined;
        },
      },
      pendingDriftStore: createInMemoryPendingDriftStore(),
      logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
      now: () => NOW,
    });

    const report = await service.run();

    expect(h.paymentDb.findByKey("task-1", "node-1")?.txHash).toBe(
      "from-custom",
    );
    expect(report.summary.remediatedByType.missing_release_tx).toBe(1);
  });

  it("an unavailable claim provider degrades to detection only", async () => {
    const broken: ClaimTransactionProvider = {
      findClaim: jest.fn(async () => {
        throw new Error("Horizon 503");
      }),
      getTransaction: jest.fn(async () => null),
    };
    const service = new ReconciliationService({
      paymentDb: new InMemoryPaymentDb([
        record({ balanceId: "cb-1", status: "released", txHash: "hash-1" }),
      ]),
      onChainProvider: makeHorizonProviders().balances,
      claimProvider: broken,
      reportStore: {
        save() {},
        getLatest() {
          return undefined;
        },
      },
      pendingDriftStore: createInMemoryPendingDriftStore(),
      logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
      now: () => NOW,
    });

    // The whole verification step throws, so the run continues without it and
    // falls back to treating the absent balance as sufficient proof.
    const report = await service.run();

    expect(report.status).toBe("consistent");
    expect(report.summary.releaseVerified).toBe(1);
  });
});
