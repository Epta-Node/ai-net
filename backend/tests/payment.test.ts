
import { xlmToStroops, stroopsToXlm, PaymentAlreadyReleasedError, HorizonUnavailableError } from "../src/payment/utils";
import {
  PaymentService,
  isTransientStellarError,
  retryDelayMs,
} from "../src/payment/payment";
import type { PaymentDb, PaymentRecord, PaymentStatus } from "../src/db/index";
import { getConfig } from "../src/config";
import { createLogger } from "../src/utils/logger";

jest.mock("@stellar/stellar-sdk");
jest.mock("../src/utils/logger", () => ({
  createLogger: jest.fn((bindings?: { component?: string }) => ({
    warn: jest.fn(),
    info: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
    trace: jest.fn(),
    bindings,
  })),
}));

const paymentLogger = (createLogger as jest.Mock).mock.results
  .map((result) => result.value as { bindings?: { component?: string }; warn: jest.Mock })
  .find((value) => value?.bindings?.component === "payment") ?? { warn: jest.fn() };

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
    listAll(): PaymentRecord[] {
      return [...store.values()].map((r) => ({ ...r }));
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

const RETRY_ENV_KEYS = [
  "STELLAR_PAYMENT_MAX_RETRIES",
  "STELLAR_PAYMENT_RETRY_BASE_MS",
  "STELLAR_PAYMENT_RETRY_MAX_MS",
];
const originalRetryEnv = Object.fromEntries(RETRY_ENV_KEYS.map((key) => [key, process.env[key]]));

function setRetryEnv(maxRetries: string, baseMs: string, maxMs: string): void {
  process.env.STELLAR_PAYMENT_MAX_RETRIES = maxRetries;
  process.env.STELLAR_PAYMENT_RETRY_BASE_MS = baseMs;
  process.env.STELLAR_PAYMENT_RETRY_MAX_MS = maxMs;
}

describe("Stellar payment retry policy (#898)", () => {
  beforeEach(() => { jest.clearAllMocks(); });

  afterEach(() => {
    for (const key of RETRY_ENV_KEYS) {
      const value = originalRetryEnv[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it("defaults to three retries", () => {
    expect(getConfig().STELLAR_PAYMENT_MAX_RETRIES).toBe(3);
  });

  it("honours the configured retry count and logs every retry", async () => {
    setRetryEnv("1", "1", "2");
    const server = {
      loadAccount: jest.fn().mockRejectedValue({ name: "NetworkError", code: "ECONNRESET" }),
      submitTransaction: jest.fn(),
    };
    (StellarSdk.Server as jest.Mock).mockImplementationOnce(() => server);

    const svc = new PaymentService(makeDb());
    const kp = StellarSdk.Keypair.fromSecret("SABC");

    await expect(svc.lock("t1", "n1", kp, "GAGENT", 1)).rejects.toThrow(
      HorizonUnavailableError
    );
    expect(server.loadAccount).toHaveBeenCalledTimes(2);
    expect(paymentLogger.warn).toHaveBeenCalledTimes(1);
    expect(paymentLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        operation: "loadAccount",
        attempt: 1,
        maxRetries: 1,
        delayMs: 1,
      }),
      "transient Stellar Horizon failure; retrying"
    );
  });

  it("does not retry validation failures", async () => {
    setRetryEnv("3", "1", "2");
    const failure = { name: "BadRequestError", message: "timeout" };
    const server = {
      loadAccount: jest.fn().mockRejectedValue(failure),
      submitTransaction: jest.fn(),
    };
    (StellarSdk.Server as jest.Mock).mockImplementationOnce(() => server);

    const svc = new PaymentService(makeDb());
    const kp = StellarSdk.Keypair.fromSecret("SABC");

    await expect(svc.lock("t1", "n1", kp, "GAGENT", 1)).rejects.toBe(failure);
    expect(server.loadAccount).toHaveBeenCalledTimes(1);
    expect(paymentLogger.warn).not.toHaveBeenCalled();
  });

  it.each([
    [{ code: "ECONNRESET" }, true],
    [{ response: { status: 429 } }, true],
    [{ response: { data: { status: 503 } } }, true],
    [{ message: "Network Error" }, true],
    [{ message: "TOO_MANY_REQUESTS" }, true],
    [{ response: { data: { extras: { result_codes: { transaction: "tx_too_late" } } } } }, true],
    [{ name: "BadRequestError", message: "timeout" }, false],
    [{ name: "NotFoundError", response: { status: 404 } }, false],
    [{ response: { status: 400 } }, false],
    [{ response: { data: { extras: { result_codes: { transaction: "tx_failed" } } } } }, false],
    [{ message: "invalid amount" }, false],
  ])("classifies %j as transient=%s", (error, expected) => {
    expect(isTransientStellarError(error)).toBe(expected);
  });

  it("uses capped exponential backoff", () => {
    expect(retryDelayMs(1, 100, 1000)).toBe(100);
    expect(retryDelayMs(2, 100, 1000)).toBe(200);
    expect(retryDelayMs(3, 100, 1000)).toBe(400);
    expect(retryDelayMs(10, 100, 1000)).toBe(1000);
  });
});
