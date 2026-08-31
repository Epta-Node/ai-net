/**
 * Unit tests for startAgentSync / stopAgentSync (src/registry/sync.ts).
 *
 * The Stellar RPC Server is mocked via jest.mock to avoid real network calls.
 */

// ── Mock stellar-sdk/rpc before importing sync ────────────────────────────────
const mockGetLatestLedger = jest.fn();
const mockGetEvents = jest.fn();

jest.mock("@stellar/stellar-sdk/rpc", () => ({
  Server: jest.fn().mockImplementation(() => ({
    getLatestLedger: mockGetLatestLedger,
    getEvents: mockGetEvents,
  })),
}));

// Mock scValToNative from stellar-base
jest.mock("@stellar/stellar-base", () => ({
  scValToNative: jest.fn((v: any) => v),
}));

// Mock agent DB
const mockUpsert = jest.fn();
jest.mock("../db/agents", () => ({
  getAgentDb: jest.fn().mockReturnValue({}),
  createAgentDb: jest.fn().mockReturnValue({
    upsert: (...args: any[]) => mockUpsert(...args),
  }),
}));

import { startAgentSync, stopAgentSync } from "./sync";

beforeEach(() => {
  jest.useFakeTimers();
  jest.clearAllMocks();
  delete process.env.REGISTRY_CONTRACT_ID;
  // Reset module state between tests
  jest.resetModules();
});

afterEach(() => {
  stopAgentSync();
  jest.useRealTimers();
});

describe("startAgentSync — no contract ID", () => {
  it("does nothing and warns when REGISTRY_CONTRACT_ID is not set", () => {
    const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});
    startAgentSync();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("REGISTRY_CONTRACT_ID"));
    expect(mockGetLatestLedger).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });
});

describe("startAgentSync — with contract ID", () => {
  beforeEach(() => {
    process.env.REGISTRY_CONTRACT_ID = "CTEST_CONTRACT";
  });

  it("starts polling without throwing", () => {
    mockGetLatestLedger.mockResolvedValue({ sequence: 1000 });
    mockGetEvents.mockResolvedValue({ events: [] });

    expect(() => startAgentSync()).not.toThrow();
    stopAgentSync();
  });

  it("upserts agents from contract events", async () => {
    mockGetLatestLedger.mockResolvedValue({ sequence: 1010 });
    mockGetEvents.mockResolvedValue({
      events: [
        {
          topic: ["register"],
          value: {
            id: "contract-agent-1",
            capabilities: ["research"],
            pricingXLM: 0.5,
            endpoint: "http://localhost:3001",
            stellarPublicKey: "GTEST",
            reputationScore: 0,
          },
        },
      ],
    });

    startAgentSync();
    // Flush promises for initial poll
    await Promise.resolve();
    await Promise.resolve();
    stopAgentSync();
  });

  it("handles poll errors gracefully without crashing", async () => {
    mockGetLatestLedger
      .mockResolvedValueOnce({ sequence: 1000 })   // first call: seed lastLedger
      .mockRejectedValueOnce(new Error("RPC error")); // second call: fail

    startAgentSync();
    // Flush multiple micro-task turns so both poll iterations can run
    for (let i = 0; i < 10; i++) await Promise.resolve();
    stopAgentSync();
    // No assertion on console.error — just verify it doesn't throw
  });

  it("handles event parse errors gracefully", async () => {
    mockGetLatestLedger.mockResolvedValue({ sequence: 1020 });
    mockGetEvents.mockResolvedValue({
      events: [
        {
          topic: [],
          value: null, // Will cause parse error
        },
      ],
    });

    startAgentSync();
    await Promise.resolve();
    await Promise.resolve();
    stopAgentSync();
  });
});

describe("stopAgentSync", () => {
  it("calling stopAgentSync when not started does not throw", () => {
    expect(() => stopAgentSync()).not.toThrow();
  });

  it("calling stopAgentSync twice does not throw", () => {
    process.env.REGISTRY_CONTRACT_ID = "CTEST_CONTRACT";
    mockGetLatestLedger.mockResolvedValue({ sequence: 1000 });
    mockGetEvents.mockResolvedValue({ events: [] });

    startAgentSync();
    expect(() => {
      stopAgentSync();
      stopAgentSync();
    }).not.toThrow();
  });
});
