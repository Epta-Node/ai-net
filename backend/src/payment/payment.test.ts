/**
 * Unit tests for createPaymentReleaseFn (backend/src/payment/index.ts).
 *
 * The Stellar SDK is mocked at the module level (see __mocks__/@stellar).
 * taskStore is mocked so tests don't need a real SQLite database.
 */
import { createPaymentReleaseFn } from "./index";

// ── Mock taskStore ────────────────────────────────────────────────────────────
const mockGetTask = jest.fn();
jest.mock("../coordinator/taskStore", () => ({
  getTask: (...args: unknown[]) => mockGetTask(...args),
}));

// ─────────────────────────────────────────────────────────────────────────────

const VALID_SECRET = "SCZANGBA5UOQVWDPI6QISXZAAFNKGJE4RFV7YMD6RVNOQKZSLK4P3SA";

beforeEach(() => {
  jest.clearAllMocks();
  delete process.env.STELLAR_COORDINATOR_SECRET;
});

describe("createPaymentReleaseFn — STELLAR_COORDINATOR_SECRET not set", () => {
  it("returns a no-op fn that resolves to 'noop'", async () => {
    const release = createPaymentReleaseFn();
    const result = await release("task_001", "node_r1");
    expect(result).toBe("noop");
  });

  it("no-op works even when stellarRelease is provided", async () => {
    const stellarRelease = jest.fn();
    const release = createPaymentReleaseFn(stellarRelease as any);
    await release("task_001", "node_r1");
    expect(stellarRelease).not.toHaveBeenCalled();
  });
});

describe("createPaymentReleaseFn — stellarRelease not provided", () => {
  it("returns a no-op fn when stellarRelease is undefined", async () => {
    process.env.STELLAR_COORDINATOR_SECRET = VALID_SECRET;
    const release = createPaymentReleaseFn(undefined);
    const result = await release("task_001", "node_r1");
    expect(result).toBe("noop");
  });
});

describe("createPaymentReleaseFn — fully configured", () => {
  it("calls stellarRelease with coordinator keypair and wallet public key", async () => {
    process.env.STELLAR_COORDINATOR_SECRET = VALID_SECRET;

    const walletPublicKey = "GWALLETTESTPAYMENTAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
    mockGetTask.mockReturnValue({
      id: "task_001",
      walletPublicKey,
      status: "running",
    });

    const stellarRelease = jest.fn().mockResolvedValue("tx-hash-abc");
    const release = createPaymentReleaseFn(stellarRelease as any);
    const txHash = await release("task_001", "node_r1");

    expect(txHash).toBe("tx-hash-abc");
    expect(stellarRelease).toHaveBeenCalledTimes(1);
    // First arg is a Keypair, second is wallet public key, third is taskId
    const [, calledWallet, calledTaskId] = stellarRelease.mock.calls[0];
    expect(calledWallet).toBe(walletPublicKey);
    expect(calledTaskId).toBe("task_001");
  });

  it("throws when the task is not found", async () => {
    process.env.STELLAR_COORDINATOR_SECRET = VALID_SECRET;
    mockGetTask.mockReturnValue(undefined);

    const stellarRelease = jest.fn().mockResolvedValue("tx-hash-xyz");
    const release = createPaymentReleaseFn(stellarRelease as any);

    await expect(release("task_missing", "node_r1")).rejects.toThrow(
      /task_missing/
    );
    expect(stellarRelease).not.toHaveBeenCalled();
  });

  it("propagates errors from stellarRelease", async () => {
    process.env.STELLAR_COORDINATOR_SECRET = VALID_SECRET;
    mockGetTask.mockReturnValue({
      id: "task_001",
      walletPublicKey: "GWALLETTESTPAYMENTAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      status: "running",
    });

    const stellarRelease = jest
      .fn()
      .mockRejectedValue(new Error("Stellar tx failed"));
    const release = createPaymentReleaseFn(stellarRelease as any);

    await expect(release("task_001", "node_r1")).rejects.toThrow(
      "Stellar tx failed"
    );
  });
});
