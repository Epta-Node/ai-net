
import { xlmToStroops, stroopsToXlm, PaymentAlreadyReleasedError, HorizonUnavailableError } from "../src/payment/utils";
import { PaymentService } from "../src/payment/payment";
import type { PaymentDb, PaymentRecord, PaymentStatus } from "../src/db/index";

jest.mock("@stellar/stellar-sdk");

// ─── Stroop / XLM conversion tests ───────────────────────────────────────────

describe("xlmToStroops / stroopsToXlm", () => {
  it("converts 1 XLM to 10_000_000 stroops", () => {
    expect(xlmToStroops(1)).toBe(10_000_000n);
  });

  it("converts 0.0000001 XLM to 1 stroop", () => {
    expect(xlmToStroops(0.0000001)).toBe(1n);
  });

  it("converts 100.5 XLM correctly", () => {
    expect(xlmToStroops(100.5)).toBe(1_005_000_000n);
  });

  it("converts 0 XLM to 0 stroops", () => {
    expect(xlmToStroops(0)).toBe(0n);
  });

  it("round-trips 1 stroop back to XLM string", () => {
    expect(stroopsToXlm(1n)).toBe("0.0000001");
  });

  it("round-trips 10_000_000 stroops to '1.0000000'", () => {
    expect(stroopsToXlm(10_000_000n)).toBe("1.0000000");
  });

  it("round-trips arbitrary amount", () => {
    const stroops = xlmToStroops(42.123);
    expect(stroopsToXlm(stroops)).toBe("42.1230000");
  });
});

// ─── Error class tests ────────────────────────────────────────────────────────

describe("PaymentAlreadyReleasedError", () => {
  it("has correct name and message", () => {
    const err = new PaymentAlreadyReleasedError("t1", "n1");
    expect(err.name).toBe("PaymentAlreadyReleasedError");
    expect(err.message).toContain("t1");
    expect(err.message).toContain("n1");
  });
});

describe("HorizonUnavailableError", () => {
  it("has correct name and includes attempt count", () => {
    const err = new HorizonUnavailableError(5);
    expect(err.name).toBe("HorizonUnavailableError");
    expect(err.message).toContain("5");
  });
});

// ─── In-memory PaymentDb helper ───────────────────────────────────────────────

function makeDb(initial?: PaymentRecord): PaymentDb {
  const store = new Map<string, PaymentRecord>();
  if (initial) store.set(`${initial.taskId}:${initial.nodeId}`, initial);
  return {
    insert(r: PaymentRecord): void { store.set(`${r.taskId}:${r.nodeId}`, { ...r }); },
    findByKey(taskId: string, nodeId: string): PaymentRecord | undefined {
      return store.get(`${taskId}:${nodeId}`);
    },
    updateStatus(taskId: string, nodeId: string, status: PaymentStatus, txHash: string): void {
      const r = store.get(`${taskId}:${nodeId}`);
      if (r) { r.status = status; r.txHash = txHash; }
    },
  };
}

// ─── PaymentService unit tests ────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-require-imports
const StellarSdk = require("@stellar/stellar-sdk");

describe("PaymentService.lock", () => {
  beforeEach(() => { jest.clearAllMocks(); });

  it("inserts a locked record and returns balanceId", async () => {
    const db = makeDb();
    const svc = new PaymentService(db);
    const kp = StellarSdk.Keypair.fromSecret("SABC");

    const balanceId = await svc.lock("t1", "n1", kp, "GAGENT", 10);

    expect(balanceId).toBe("balance-id-abc");
    const record = db.findByKey("t1", "n1");
    expect(record).toBeDefined();
    expect(record!.status).toBe("locked");
    expect(record!.balanceId).toBe("balance-id-abc");
    expect(record!.amountStroops).toBe(100_000_000n);
  });

  it("stores amount as BigInt stroops (1 stroop = 0.0000001 XLM)", async () => {
    const db = makeDb();
    const svc = new PaymentService(db);
    const kp = StellarSdk.Keypair.fromSecret("SABC");
    await svc.lock("t2", "n1", kp, "GAGENT", 0.0000001);
    expect(db.findByKey("t2", "n1")!.amountStroops).toBe(1n);
  });
});

describe("PaymentService.release", () => {
  beforeEach(() => { jest.clearAllMocks(); });

  it("returns tx hash and sets status=released", async () => {
    const db = makeDb({
      taskId: "t1", nodeId: "n1", balanceId: "bal-123",
      status: "locked", amountStroops: 100n, txHash: null,
    });
    const svc = new PaymentService(db);
    const kp = StellarSdk.Keypair.fromSecret("SABC");

    const hash = await svc.release("t1", "n1", kp);
    expect(hash).toBe("txhash-001");
    expect(db.findByKey("t1", "n1")!.status).toBe("released");
  });

  it("is idempotent — second call returns same hash without new Stellar tx", async () => {
    const db = makeDb({
      taskId: "t1", nodeId: "n1", balanceId: "bal-123",
      status: "released", amountStroops: 100n, txHash: "existing-hash",
    });
    const svc = new PaymentService(db);
    const kp = StellarSdk.Keypair.fromSecret("SABC");

    // Get hold of the submitTransaction mock before calling release
    const serverInstance = (StellarSdk.Server as jest.Mock).mock.results[0]?.value as
      { submitTransaction?: jest.Mock } | undefined;
    const submitSpy = serverInstance?.submitTransaction;

    const hash = await svc.release("t1", "n1", kp);
    expect(hash).toBe("existing-hash");
    // No new server was created in release since record is already released
    if (submitSpy) expect(submitSpy).not.toHaveBeenCalled();
  });

  it("throws if no record exists", async () => {
    const db = makeDb();
    const svc = new PaymentService(db);
    const kp = StellarSdk.Keypair.fromSecret("SABC");
    await expect(svc.release("t1", "n1", kp)).rejects.toThrow("No payment record");
  });
});

describe("PaymentService.refund", () => {
  beforeEach(() => { jest.clearAllMocks(); });

  it("throws PaymentAlreadyReleasedError if already released", async () => {
    const db = makeDb({
      taskId: "t1", nodeId: "n1", balanceId: "bal-123",
      status: "released", amountStroops: 100n, txHash: "some-hash",
    });
    const svc = new PaymentService(db);
    const kp = StellarSdk.Keypair.fromSecret("SABC");
    await expect(svc.refund("t1", "n1", kp)).rejects.toThrow(PaymentAlreadyReleasedError);
  });

  it("refunds a locked balance and records status=refunded", async () => {
    const db = makeDb({
      taskId: "t1", nodeId: "n1", balanceId: "bal-123",
      status: "locked", amountStroops: 100n, txHash: null,
    });
    const svc = new PaymentService(db);
    const kp = StellarSdk.Keypair.fromSecret("SABC");
    const hash = await svc.refund("t1", "n1", kp);
    expect(hash).toBe("txhash-001");
    expect(db.findByKey("t1", "n1")!.status).toBe("refunded");
  });
});

describe("PaymentService.getPaymentStatus", () => {
  it("returns undefined for unknown records", () => {
    const svc = new PaymentService(makeDb());
    expect(svc.getPaymentStatus("t1", "n1")).toBeUndefined();
  });

  it("returns the current record", () => {
    const record: PaymentRecord = {
      taskId: "t1", nodeId: "n1", balanceId: "bal-x",
      status: "locked", amountStroops: 50n, txHash: null,
    };
    const svc = new PaymentService(makeDb(record));
    expect(svc.getPaymentStatus("t1", "n1")).toMatchObject({ status: "locked" });
  });
});

// ─── Retry / HorizonUnavailableError tests ────────────────────────────────────

describe("PaymentService retry logic", () => {
  beforeEach(() => { jest.clearAllMocks(); });

  it("throws HorizonUnavailableError after 5 TIMEOUT failures", async () => {
    (StellarSdk.Server as jest.Mock).mockImplementationOnce(() => ({
      loadAccount: jest.fn().mockRejectedValue(new Error("TIMEOUT") as never),
      submitTransaction: jest.fn(),
    }));

    const db = makeDb();
    const svc = new PaymentService(db);
    const kp = StellarSdk.Keypair.fromSecret("SABC");

    await expect(svc.lock("t1", "n1", kp, "GAGENT", 1)).rejects.toThrow(
      HorizonUnavailableError
    );
  });

  it("retries on TOO_MANY_REQUESTS and succeeds on 3rd attempt", async () => {
    let calls = 0;
    (StellarSdk.Server as jest.Mock).mockImplementationOnce(() => ({
      loadAccount: jest.fn().mockImplementation(() => {
        calls++;
        if (calls < 3) return Promise.reject(new Error("TOO_MANY_REQUESTS"));
        return Promise.resolve({ id: "GCOORDINATOR", sequence: "1" });
      }),
      submitTransaction: jest.fn().mockResolvedValue({ hash: "txhash-retry" } as never),
    }));

    const db = makeDb();
    const svc = new PaymentService(db);
    const kp = StellarSdk.Keypair.fromSecret("SABC");

    const balanceId = await svc.lock("t1", "n1", kp, "GAGENT", 1);
    expect(balanceId).toBe("balance-id-abc");
    expect(calls).toBe(3);
  }, 15_000);
});
