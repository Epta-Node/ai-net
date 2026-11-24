jest.mock("./pricing.js", () => ({
  computeCostUsd: jest.fn((_model: string, prompt: number, completion: number) =>
    (prompt + completion) / 1000
  ),
}));
jest.mock("./tokens.js", () => ({
  estimateTokens: jest.fn((text: string) => Math.ceil(text.length / 4)),
  trimToTokenBudget: jest.fn((text: string, maxTokens: number) => text.slice(0, maxTokens * 4)),
}));

import {
  BudgetExhaustedError,
  DEFAULT_BUDGET_LIMITS,
  TaskBudgetLedger,
  activeSnapshots,
  dropLedger,
  getLedger,
  peekLedger,
  resetLedgers,
  takeLedgerSnapshot,
} from "./ledger.js";
import { computeCostUsd } from "./pricing.js";
import { estimateTokens, trimToTokenBudget } from "./tokens.js";

const limits = {
  maxTokensPerTask: 100,
  maxTokensPerCall: 40,
  maxPromptTokens: 80,
};

beforeEach(() => {
  resetLedgers();
  jest.clearAllMocks();
});

describe("TaskBudgetLedger — balance and limits", () => {
  it("starts with DEFAULT_BUDGET_LIMITS and an untouched balance", () => {
    const ledger = new TaskBudgetLedger("task-1", { walletPublicKey: "GWALLET" });

    expect(ledger.taskId).toBe("task-1");
    expect(ledger.limits).toEqual(DEFAULT_BUDGET_LIMITS);
    expect(ledger.usedTokens).toBe(0);
    expect(ledger.remainingTokens).toBe(DEFAULT_BUDGET_LIMITS.maxTokensPerTask);
    expect(ledger.availableTokens).toBe(DEFAULT_BUDGET_LIMITS.maxTokensPerTask);
    expect(ledger.costUsd).toBe(0);
    expect(ledger.exhausted).toBe(false);
    expect(ledger.allowanceFor()).toBe(DEFAULT_BUDGET_LIMITS.maxTokensPerCall);
  });

  it("merges partial custom limits", () => {
    const ledger = new TaskBudgetLedger("task-1", { limits: { maxTokensPerCall: 12 } });

    expect(ledger.limits).toEqual({ ...DEFAULT_BUDGET_LIMITS, maxTokensPerCall: 12 });
  });

  it("reserves against the remaining balance and releases it", () => {
    const ledger = new TaskBudgetLedger("task-1", { limits });

    expect(ledger.reserve("n1", 150)).toBe(40);
    expect(ledger.availableTokens).toBe(60);
    expect(ledger.reserve("n2", 100)).toBe(40);
    expect(ledger.availableTokens).toBe(20);
    expect(ledger.reserve("n3", 100)).toBe(20);
    expect(ledger.availableTokens).toBe(0);
    expect(ledger.exhausted).toBe(true);
    expect(ledger.reserve("n4", 10)).toBe(0);

    ledger.release("unknown");
    expect(ledger.availableTokens).toBe(0);
    ledger.release("n1");
    expect(ledger.availableTokens).toBe(40);
    expect(ledger.exhausted).toBe(false);
  });

  it("floors and clamps requested amounts", () => {
    const ledger = new TaskBudgetLedger("task-1", { limits });
    expect(ledger.reserve("n1", -5)).toBe(0);
    expect(ledger.reserve("n1", 3.9)).toBe(3);
    expect(ledger.availableTokens).toBe(97);
  });

  it("throws BudgetExhaustedError only when no tokens are available", () => {
    const ledger = new TaskBudgetLedger("task-1", {
      limits: { ...limits, maxTokensPerCall: 100 },
      walletPublicKey: "GWALLET",
    });

    expect(() => ledger.assertCanSpend()).not.toThrow();
    ledger.reserve("n1", 100);

    expect(() => ledger.assertCanSpend()).toThrow(BudgetExhaustedError);
    expect(() => ledger.assertCanSpend()).toThrow(
      "Token budget exhausted for task task-1: 0/100 tokens used"
    );
  });
});

describe("TaskBudgetLedger — usage accounting", () => {
  it("settles a reservation and records provider usage", () => {
    const ledger = new TaskBudgetLedger("task-1", { limits });
    ledger.reserve("n1", 50);

    const record = ledger.record("n1", {
      agentId: "a1",
      agentType: "research",
      model: "test-model",
      usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
    });

    expect(record).toMatchObject({
      promptTokens: 10,
      completionTokens: 5,
      totalTokens: 15,
      model: "test-model",
      costUsd: 0.015,
      trimmed: false,
      tokensSaved: 0,
    });
    expect(computeCostUsd).toHaveBeenCalledWith("test-model", 10, 5);
    expect(ledger.usedTokens).toBe(15);
    expect(ledger.availableTokens).toBe(85);
    expect(ledger.costUsd).toBe(0.015);
    expect(ledger.usageCallsFor("n1")).toBe(1);
  });

  it("estimates tokens when the provider reports no usage", () => {
    const ledger = new TaskBudgetLedger("task-1", { limits });

    const record = ledger.record("n2", {
      agentId: "a2",
      agentType: "coding",
      model: "test-model",
      prompt: "abcd",
      completion: "abcdefgh",
    });

    expect(estimateTokens).toHaveBeenCalledWith("abcd");
    expect(estimateTokens).toHaveBeenCalledWith("abcdefgh");
    expect(record.totalTokens).toBe(3);
    expect(ledger.usedTokens).toBe(3);
  });

  it("trims oversized prompts and carries the flag into the rollup", () => {
    const ledger = new TaskBudgetLedger("task-1", { limits });
    const prompt = "x".repeat(200);

    const prepared = ledger.preparePrompt("n1", "a1", "research", prompt);
    expect(trimToTokenBudget).toHaveBeenCalledWith(prompt, 30);
    expect(prepared.trimmed).toBe(true);
    expect(prepared.tokensSaved).toBeGreaterThan(0);

    ledger.record("n1", {
      agentId: "a1",
      agentType: "research",
      model: "test-model",
      usage: { promptTokens: 20, completionTokens: 10, totalTokens: 30 },
    });

    expect(ledger.snapshot().agents[0]).toMatchObject({
      nodeId: "n1",
      trimmed: true,
      calls: 1,
      totalTokens: 30,
    });
  });

  it("leaves prompts that already fit unchanged", () => {
    const ledger = new TaskBudgetLedger("task-1", { limits });

    expect(ledger.preparePrompt("n1", "a1", "research", "abcd")).toEqual({
      prompt: "abcd",
      trimmed: false,
      tokensSaved: 0,
    });
    expect(trimToTokenBudget).not.toHaveBeenCalled();
  });

  it("orders per-agent rollups by cost and marks the exhausting node", () => {
    const ledger = new TaskBudgetLedger("task-1", { limits });
    ledger.record("n1", {
      agentId: "a1",
      agentType: "research",
      model: "test-model",
      usage: { promptTokens: 100, completionTokens: 0, totalTokens: 100 },
    });
    ledger.record("n2", {
      agentId: "a2",
      agentType: "coding",
      model: "test-model",
      usage: { promptTokens: 10, completionTokens: 0, totalTokens: 10 },
    });
    ledger.markExhausted("n2", "a2", "coding");

    const agents = ledger.agents();
    expect(agents.map((entry) => entry.nodeId)).toEqual(["n1", "n2"]);
    expect(agents[1].budgetExhausted).toBe(true);
    expect(agents[0].budgetExhausted).toBe(false);
  });

  it("reports an exceeded snapshot when actual usage passes the cap", () => {
    const ledger = new TaskBudgetLedger("task-1", {
      walletPublicKey: "GWALLET",
      limits: { maxTokensPerTask: 10 },
    });
    ledger.record("n1", {
      agentId: "a1",
      agentType: "research",
      model: "test-model",
      usage: { promptTokens: 15, completionTokens: 0, totalTokens: 15 },
    });

    expect(ledger.snapshot()).toMatchObject({
      taskId: "task-1",
      walletPublicKey: "GWALLET",
      budgetTokens: 10,
      usedTokens: 15,
      remainingTokens: 0,
      costUsd: 0.015,
      currency: "USD",
      exceeded: true,
      calls: 1,
    });
  });
});

describe("ledger registry", () => {
  it("reuses an existing ledger and ignores options on later lookups", () => {
    const first = getLedger("task-1", { walletPublicKey: "GWALLET" });
    const second = getLedger("task-1", { walletPublicKey: "OTHER" });

    expect(second).toBe(first);
    expect(second.snapshot().walletPublicKey).toBe("GWALLET");
    expect(peekLedger("task-1")).toBe(first);
    expect(peekLedger("missing")).toBeUndefined();
  });

  it("snapshots and forgets a ledger", () => {
    const ledger = getLedger("task-1");
    ledger.record("n1", {
      agentId: "a1",
      agentType: "research",
      model: "test-model",
      usage: { promptTokens: 4, completionTokens: 0, totalTokens: 4 },
    });

    expect(takeLedgerSnapshot("task-1")?.usedTokens).toBe(4);
    expect(peekLedger("task-1")).toBeUndefined();
    expect(takeLedgerSnapshot("task-1")).toBeUndefined();
  });

  it("drops a ledger without snapshotting", () => {
    getLedger("task-1");
    dropLedger("task-1");
    expect(peekLedger("task-1")).toBeUndefined();
  });

  it("exposes active snapshots", () => {
    getLedger("task-1");
    getLedger("task-2");
    expect(activeSnapshots().map((snapshot) => snapshot.taskId).sort()).toEqual([
      "task-1",
      "task-2",
    ]);
  });

  it("evicts the oldest ledger at the 1000-task cap", () => {
    for (let i = 0; i < 1000; i += 1) getLedger(`task-${i}`);
    getLedger("task-1000");

    expect(peekLedger("task-0")).toBeUndefined();
    expect(peekLedger("task-1000")).toBeDefined();
  });
});
