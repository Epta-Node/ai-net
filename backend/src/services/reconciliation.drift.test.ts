/**
 * Unit tests for the pure payment-drift detectors (issue #496).
 *
 * These exercise the classification logic in isolation — no service, no clock
 * reads beyond the injected one, no I/O — so every branch of every scenario can
 * be pinned down deterministically.
 */

import type { PaymentRecord } from "../db/index";
import type { ClaimableBalanceOnChain } from "./reconciliation.types";
import {
  detectAmountMismatch,
  detectExpiredEscrow,
  detectMissingLocal,
  detectMissingReleaseTx,
  detectOrphanedLock,
  detectPaymentDrift,
  detectUnconfirmedRelease,
  driftCounts,
  emptyDriftCounters,
  isEscrowExpired,
  isTerminalUnsuccessful,
  paymentAgeMs,
  planRemediation,
  recordKey,
  verifyReleaseTransactions,
  type ReleaseVerification,
} from "./reconciliation.drift";

const NOW = Date.parse("2026-09-01T12:00:00.000Z");
const DAY_MS = 86_400_000;

function record(overrides: Partial<PaymentRecord> = {}): PaymentRecord {
  return {
    taskId: "t1",
    nodeId: "n1",
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
  return { balanceId: "cb-1", amountStroops: "10000000", ...overrides };
}

function verification(
  overrides: Partial<ReleaseVerification> = {},
): ReleaseVerification {
  return { recordedTxHash: "hash-1", onChainTx: null, ...overrides };
}

// ─── Small predicates ─────────────────────────────────────────────────────────

describe("isTerminalUnsuccessful", () => {
  it.each(["failed", "cancelled", "canceled", "FAILED", "Cancelled"])(
    "treats %s as terminal",
    (status) => {
      expect(isTerminalUnsuccessful(status)).toBe(true);
    },
  );

  it.each(["running", "queued", "completed", ""])(
    "treats %s as non-terminal",
    (status) => {
      expect(isTerminalUnsuccessful(status)).toBe(false);
    },
  );

  it("treats an unknown task as non-terminal", () => {
    expect(isTerminalUnsuccessful(undefined)).toBe(false);
  });
});

describe("paymentAgeMs", () => {
  it("prefers the record createdAt", () => {
    const age = paymentAgeMs(
      record({ createdAt: new Date(NOW - 3_600_000).toISOString() }),
      { status: "failed", updatedAt: new Date(NOW - 10).toISOString() },
      NOW,
    );
    expect(age).toBe(3_600_000);
  });

  it("falls back to the task updatedAt", () => {
    const age = paymentAgeMs(
      record({ createdAt: null }),
      { status: "failed", updatedAt: new Date(NOW - 5_000).toISOString() },
      NOW,
    );
    expect(age).toBe(5_000);
  });

  it("returns null when no age can be determined", () => {
    expect(
      paymentAgeMs(record({ createdAt: null }), { status: "failed" }, NOW),
    ).toBeNull();
  });

  it("clamps a future timestamp to zero", () => {
    const age = paymentAgeMs(
      record({ createdAt: new Date(NOW + 60_000).toISOString() }),
      undefined,
      NOW,
    );
    expect(age).toBe(0);
  });
});

describe("isEscrowExpired", () => {
  it("is expired past the window", () => {
    expect(isEscrowExpired(DAY_MS, DAY_MS)).toBe(true);
    expect(isEscrowExpired(DAY_MS + 1, DAY_MS)).toBe(true);
  });

  it("is not expired inside the window", () => {
    expect(isEscrowExpired(DAY_MS - 1, DAY_MS)).toBe(false);
  });

  it("fails open when the age is unknown", () => {
    expect(isEscrowExpired(null, DAY_MS)).toBe(true);
  });

  it('treats a zero window as "always expired"', () => {
    expect(isEscrowExpired(0, 0)).toBe(true);
  });
});

describe("recordKey", () => {
  it("joins the task and node ids", () => {
    expect(recordKey({ taskId: "a", nodeId: "b" })).toBe("a:b");
  });
});

describe("emptyDriftCounters", () => {
  it("zeroes every supplied key", () => {
    expect(emptyDriftCounters(["a", "b"] as const)).toEqual({ a: 0, b: 0 });
  });
});

// ─── Individual detectors ─────────────────────────────────────────────────────

describe("detectOrphanedLock", () => {
  it("classifies a locked record with no on-chain balance as orphaned_locked", () => {
    const d = detectOrphanedLock(record());
    expect(d).toMatchObject({
      type: "missing_on_chain",
      driftType: "orphaned_locked",
      severity: "critical",
      balanceId: "cb-1",
      taskId: "t1",
      nodeId: "n1",
    });
    expect(d.description).toContain("no matching on-chain claimable balance");
  });
});

describe("detectMissingReleaseTx", () => {
  it("returns null when the on-chain claim matches the recorded hash", () => {
    const d = detectMissingReleaseTx(
      record({ status: "released", txHash: "hash-1" }),
      verification({ onChainTx: { hash: "hash-1", successful: true } }),
      undefined,
    );
    expect(d).toBeNull();
  });

  it("returns null while the balance is still claimable (scenario 3 wins)", () => {
    const d = detectMissingReleaseTx(
      record({ status: "released", txHash: "hash-1" }),
      verification(),
      balance(),
    );
    expect(d).toBeNull();
  });

  it("flags a recorded hash Horizon cannot find", () => {
    const d = detectMissingReleaseTx(
      record({ status: "released", txHash: "hash-1" }),
      verification({ lookupError: "transaction not found in Horizon" }),
      undefined,
    );
    expect(d).toMatchObject({
      driftType: "missing_release_tx",
      recordedTxHash: "hash-1",
    });
    expect(d?.description).toContain("transaction not found in Horizon");
    expect(d?.description).toContain(
      "No on-chain claim transaction is available",
    );
  });

  it("surfaces the real on-chain hash for back-fill", () => {
    const d = detectMissingReleaseTx(
      record({ status: "released", txHash: "stale" }),
      verification({ onChainTx: { hash: "real", successful: true } }),
      undefined,
    );
    expect(d?.onChainTxHash).toBe("real");
    expect(d?.description).toContain("will be back-filled");
  });

  it("handles a released record with no recorded hash at all", () => {
    const d = detectMissingReleaseTx(
      record({ status: "released", txHash: null }),
      verification({
        recordedTxHash: null,
        lookupError: "no claim transaction and no recorded hash",
      }),
      undefined,
    );
    expect(d?.recordedTxHash).toBeNull();
    expect(d?.description).toContain("(none recorded)");
  });
});

describe("detectUnconfirmedRelease", () => {
  it("classifies a released record whose balance is still claimable", () => {
    const d = detectUnconfirmedRelease(
      record({ status: "released", txHash: "h1" }),
      balance(),
    );
    expect(d).toMatchObject({
      type: "release_unconfirmed",
      driftType: "release_unconfirmed",
      severity: "critical",
      onChainAmountStroops: "10000000",
      expectedAmountStroops: "0",
    });
  });
});

describe("detectExpiredEscrow", () => {
  it("describes the terminal task and the escrow age", () => {
    const d = detectExpiredEscrow(
      record(),
      balance(),
      { status: "failed" },
      2 * DAY_MS,
      DAY_MS,
    );
    expect(d).toMatchObject({
      driftType: "expired_escrow",
      severity: "warning",
      taskStatus: "failed",
    });
    expect(d.description).toContain("status=failed");
    expect(d.description).toContain("172800s old");
  });

  it("describes an untracked task", () => {
    const d = detectExpiredEscrow(
      record(),
      balance(),
      undefined,
      2 * DAY_MS,
      DAY_MS,
    );
    expect(d.description).toContain("no longer tracked");
  });

  it("describes an unknown age", () => {
    const d = detectExpiredEscrow(
      record(),
      balance(),
      { status: "failed" },
      null,
      DAY_MS,
    );
    expect(d.description).toContain("age cannot be determined");
  });
});

describe("detectMissingLocal / detectAmountMismatch", () => {
  it("classifies an on-chain balance with no local record", () => {
    expect(
      detectMissingLocal(balance({ balanceId: "cb-orphan" })),
    ).toMatchObject({
      type: "missing_local",
      driftType: "missing_local",
      severity: "warning",
    });
  });

  it("reports a locked amount mismatch as critical", () => {
    const d = detectAmountMismatch(
      record(),
      balance({ amountStroops: "1" }),
      10_000_000n,
    );
    expect(d).toMatchObject({
      driftType: "amount_mismatch",
      severity: "critical",
    });
  });

  it("reports a settled amount mismatch as a warning", () => {
    const d = detectAmountMismatch(
      record({ status: "refunded" }),
      balance(),
      0n,
    );
    expect(d.severity).toBe("warning");
  });
});

// ─── Remediation planning ─────────────────────────────────────────────────────

describe("planRemediation", () => {
  it("orphans an orphaned lock automatically", () => {
    expect(planRemediation(detectOrphanedLock(record()))).toMatchObject({
      action: "mark_orphaned",
      automatic: true,
    });
  });

  it("back-fills a missing release hash when one is known", () => {
    const d = detectMissingReleaseTx(
      record({ status: "released", txHash: "stale" }),
      verification({ onChainTx: { hash: "real", successful: true } }),
      undefined,
    );
    expect(planRemediation(d!)).toMatchObject({
      action: "backfill_tx_hash",
      automatic: true,
    });
  });

  it("defers a missing release hash that cannot be sourced", () => {
    const d = detectMissingReleaseTx(
      record({ status: "released", txHash: "stale" }),
      verification(),
      undefined,
    );
    expect(planRemediation(d!)).toMatchObject({
      action: "manual_review",
      automatic: false,
    });
  });

  it("refunds an expired escrow automatically", () => {
    const d = detectExpiredEscrow(
      record(),
      balance(),
      { status: "failed" },
      DAY_MS,
      DAY_MS,
    );
    expect(planRemediation(d)).toMatchObject({
      action: "refund_escrow",
      automatic: true,
    });
  });

  it("re-submits an unconfirmed release automatically", () => {
    const d = detectUnconfirmedRelease(
      record({ status: "released" }),
      balance(),
    );
    expect(planRemediation(d)).toMatchObject({
      action: "requeue_release",
      automatic: true,
    });
  });

  it("never automates an ambiguous drift", () => {
    expect(planRemediation(detectMissingLocal(balance()))).toMatchObject({
      action: "manual_review",
      automatic: false,
    });
    expect(
      planRemediation(
        detectAmountMismatch(
          record(),
          balance({ amountStroops: "1" }),
          10_000_000n,
        ),
      ),
    ).toMatchObject({
      action: "manual_review",
      automatic: false,
    });
  });
});

// ─── Whole-ledger detection ───────────────────────────────────────────────────

describe("detectPaymentDrift", () => {
  const baseOptions = { escrowExpiryMs: DAY_MS, now: () => NOW };

  it("reports nothing for a healthy ledger", () => {
    const result = detectPaymentDrift([record()], [balance()], baseOptions);
    expect(result).toEqual({
      discrepancies: [],
      matched: 1,
      releaseVerified: 0,
      releaseUnverified: 0,
    });
  });

  it("is deterministic for the same inputs", () => {
    const records = [
      record(),
      record({ taskId: "t2", nodeId: "n2", balanceId: "cb-2" }),
    ];
    const balances = [balance({ balanceId: "cb-2" })];
    const a = detectPaymentDrift(records, balances, baseOptions);
    const b = detectPaymentDrift(records, balances, baseOptions);
    expect(a.discrepancies).toEqual(b.discrepancies);
  });

  it("does not verify releases for records without a txHash", () => {
    const result = detectPaymentDrift(
      [record({ status: "released", txHash: null })],
      [],
      baseOptions,
    );
    expect(result.releaseVerified).toBe(1);
    expect(result.discrepancies).toHaveLength(0);
  });

  it("marks a released record as verified when the chain confirms the hash", () => {
    const verifications = new Map([
      [
        "t1:n1",
        verification({ onChainTx: { hash: "hash-1", successful: true } }),
      ],
    ]);
    const result = detectPaymentDrift(
      [record({ status: "released", txHash: "hash-1" })],
      [],
      baseOptions,
      verifications,
    );
    expect(result.releaseVerified).toBe(1);
    expect(result.discrepancies).toHaveLength(0);
  });

  it("marks a released record as unverified when the chain contradicts it", () => {
    const verifications = new Map([["t1:n1", verification()]]);
    const result = detectPaymentDrift(
      [record({ status: "released", txHash: "hash-1" })],
      [],
      baseOptions,
      verifications,
    );
    expect(result.releaseUnverified).toBe(1);
    expect(result.discrepancies[0].driftType).toBe("missing_release_tx");
  });

  it("treats a refunded record as settled without demanding a transaction", () => {
    const result = detectPaymentDrift(
      [record({ status: "refunded", txHash: "r1" })],
      [],
      baseOptions,
      new Map(),
    );
    expect(result.discrepancies).toHaveLength(0);
  });

  it("flags an orphaned record whose on-chain balance vanished", () => {
    const result = detectPaymentDrift([record()], [], baseOptions);
    expect(result.discrepancies[0].driftType).toBe("orphaned_locked");
  });

  it("flags an on-chain balance with no local record", () => {
    const result = detectPaymentDrift(
      [],
      [balance({ balanceId: "cb-x" })],
      baseOptions,
    );
    expect(result.discrepancies[0].driftType).toBe("missing_local");
  });

  it("flags an amount mismatch for a locked record", () => {
    const result = detectPaymentDrift(
      [record()],
      [balance({ amountStroops: "5" })],
      baseOptions,
    );
    expect(result.discrepancies[0].driftType).toBe("amount_mismatch");
    // The balance matched a local record, so it counts as matched.
    expect(result.matched).toBe(1);
  });

  it("detects an expired escrow on a failed task", () => {
    const result = detectPaymentDrift([record()], [balance()], {
      ...baseOptions,
      taskState: () => ({ status: "failed" }),
    });
    expect(result.discrepancies[0].driftType).toBe("expired_escrow");
  });

  it("leaves a healthy in-flight escrow alone", () => {
    const result = detectPaymentDrift([record()], [balance()], {
      ...baseOptions,
      taskState: () => ({ status: "running" }),
    });
    expect(result.discrepancies).toHaveLength(0);
  });

  it("leaves a young escrow on a failed task alone", () => {
    const result = detectPaymentDrift(
      [record({ createdAt: new Date(NOW - 1_000).toISOString() })],
      [balance()],
      { ...baseOptions, taskState: () => ({ status: "failed" }) },
    );
    expect(result.discrepancies).toHaveLength(0);
  });

  it("flags release_unconfirmed ahead of amount_mismatch for settled records", () => {
    const result = detectPaymentDrift(
      [record({ status: "released", txHash: "h1" })],
      [balance()],
      baseOptions,
    );
    expect(result.discrepancies.map((d) => d.driftType)).toEqual([
      "release_unconfirmed",
    ]);
    expect(result.releaseUnverified).toBe(1);
  });
});

describe("verifyReleaseTransactions", () => {
  it("verifies only released records that carry a txHash", async () => {
    const resolve = jest.fn(async (r: PaymentRecord) =>
      verification({ recordedTxHash: r.txHash }),
    );
    const out = await verifyReleaseTransactions(
      [
        record({ status: "released", txHash: "a" }),
        record({ taskId: "t2", status: "locked", txHash: null }),
        record({ taskId: "t3", status: "refunded", txHash: "c" }),
      ],
      resolve,
      10,
    );
    expect(resolve).toHaveBeenCalledTimes(1);
    expect([...out.keys()]).toEqual(["t1:n1"]);
  });

  it("honours the lookup limit", async () => {
    const resolve = jest.fn(async (r: PaymentRecord) =>
      verification({ recordedTxHash: r.txHash }),
    );
    const records = Array.from({ length: 5 }, (_, i) =>
      record({
        taskId: `t${i}`,
        nodeId: `n${i}`,
        status: "released",
        txHash: `h${i}`,
      }),
    );
    const out = await verifyReleaseTransactions(records, resolve, 2);
    expect(resolve).toHaveBeenCalledTimes(2);
    expect(out.size).toBe(2);
  });
});

describe("driftCounts", () => {
  it("counts every drift category, including zeroes", () => {
    const counts = driftCounts([detectOrphanedLock(record())]);
    expect(counts).toEqual({
      orphaned_locked: 1,
      missing_release_tx: 0,
      release_unconfirmed: 0,
      expired_escrow: 0,
      missing_local: 0,
      amount_mismatch: 0,
    });
  });
});
