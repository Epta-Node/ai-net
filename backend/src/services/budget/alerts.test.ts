import path from "path";
import Database from "better-sqlite3";
import { createTaskDb, type TaskDb } from "../../db/tasks";
import { migrateToLatest } from "../../db/migrator";
import {
  COST_BUDGET_HARD_STOP_RATIO,
  COST_BUDGET_WARN_RATIO,
  DailyCostBudgetExceededError,
  assertDailyCostBudgetAvailable,
  evaluateCostBudget,
  getCostBudgetStatus,
  resetCostBudgetAlerts,
} from "./alerts";
import { BudgetExhaustedError } from "./ledger";

const DAY = "2025-03-10";
const NOW = new Date(`${DAY}T12:00:00.000Z`);

function fakeDb(spentUsd: number) {
  return { getDailySpendUsd: jest.fn((_day: string) => spentUsd) };
}

describe("cost budget thresholds (#750)", () => {
  beforeEach(() => resetCostBudgetAlerts());

  it("warns at 75% and hard-stops at 100%", () => {
    expect(COST_BUDGET_WARN_RATIO).toBe(0.75);
    expect(COST_BUDGET_HARD_STOP_RATIO).toBe(1);
    expect(evaluateCostBudget(DAY, 0, 100).level).toBe("ok");
    expect(evaluateCostBudget(DAY, 74.99, 100).level).toBe("ok");
    expect(evaluateCostBudget(DAY, 75, 100).level).toBe("warn");
    expect(evaluateCostBudget(DAY, 99.99, 100).level).toBe("warn");
    expect(evaluateCostBudget(DAY, 100, 100).level).toBe("exceeded");
    expect(evaluateCostBudget(DAY, 250, 100).level).toBe("exceeded");
  });

  it("is disabled when no budget is configured", () => {
    const status = evaluateCostBudget(DAY, 500, 0);
    expect(status).toMatchObject({ enabled: false, level: "disabled", ratio: 0 });
  });

  it("reads fake spend for the current UTC day and reports the level", () => {
    const db = fakeDb(80);
    const status = getCostBudgetStatus({ db, budgetUsd: 100, now: NOW });
    expect(db.getDailySpendUsd).toHaveBeenCalledWith(DAY);
    expect(status).toMatchObject({
      day: DAY,
      spentUsd: 80,
      budgetUsd: 100,
      level: "warn",
      warnAtUsd: 75,
      hardStopAtUsd: 100,
    });
  });

  it("does not touch the database while the budget is disabled", () => {
    const db = fakeDb(999);
    expect(getCostBudgetStatus({ db, budgetUsd: 0, now: NOW }).level).toBe("disabled");
    expect(db.getDailySpendUsd).not.toHaveBeenCalled();
  });

  it("lets work through below the hard stop", () => {
    expect(() =>
      assertDailyCostBudgetAvailable("task_1", { db: fakeDb(90), budgetUsd: 100, now: NOW }),
    ).not.toThrow();
  });

  it("refuses new work once the budget is spent", () => {
    const attempt = () =>
      assertDailyCostBudgetAvailable("task_1", { db: fakeDb(100), budgetUsd: 100, now: NOW });
    expect(attempt).toThrow(DailyCostBudgetExceededError);
    expect(attempt).toThrow(BudgetExhaustedError);
    expect(attempt).toThrow(/Daily cost budget exhausted for 2025-03-10/);
  });

  it("never blocks work on a database failure", () => {
    const db = {
      getDailySpendUsd: () => {
        throw new Error("db down");
      },
    };
    expect(() =>
      assertDailyCostBudgetAvailable("task_1", { db, budgetUsd: 100, now: NOW }),
    ).not.toThrow();
  });
});

describe("TaskDb cost attribution (#750)", () => {
  let db: TaskDb;

  function usage(
    taskId: string,
    nodeId: string,
    agentId: string,
    agentType: string,
    model: string,
    costUsd: number,
    updatedAt: string,
  ) {
    db.setNodeUsage({
      taskId,
      nodeId,
      agentId,
      agentType,
      model,
      calls: 1,
      promptTokens: 100,
      completionTokens: 50,
      totalTokens: 150,
      costUsd,
      trimmed: false,
      budgetExhausted: false,
      updatedAt,
    });
  }

  beforeEach(() => {
    const raw = new Database(":memory:");
    migrateToLatest(raw, path.join(__dirname, "../../db/migrations/tasks"));
    db = createTaskDb(raw);
    usage("t1", "n1", "agent-a", "research", "model-x", 1.5, "2025-03-10T09:00:00.000Z");
    usage("t1", "n2", "agent-b", "coding", "model-y", 2.0, "2025-03-10T10:00:00.000Z");
    usage("t2", "n1", "agent-a", "research", "model-x", 0.5, "2025-03-11T08:00:00.000Z");
  });

  it("aggregates by agent, model and day", () => {
    const rows = db.listCostBreakdown();
    expect(rows).toHaveLength(3);
    expect(rows[0]).toMatchObject({ day: "2025-03-11", agentId: "agent-a", costUsd: 0.5 });
  });

  it("filters by agent", () => {
    const rows = db.listCostBreakdown({ agentId: "agent-a" });
    expect(rows.map((r) => r.day).sort()).toEqual(["2025-03-10", "2025-03-11"]);
    expect(rows.every((r) => r.agentId === "agent-a")).toBe(true);
  });

  it("filters by model and agent type", () => {
    expect(db.listCostBreakdown({ model: "model-y" })).toMatchObject([
      { agentId: "agent-b", model: "model-y", costUsd: 2 },
    ]);
    expect(db.listCostBreakdown({ agentType: "research" })).toHaveLength(2);
  });

  it("filters by day and combines filters", () => {
    expect(db.listCostBreakdown({ day: "2025-03-10" })).toHaveLength(2);
    expect(db.listCostBreakdown({ day: "2025-03-10", agentId: "agent-a" })).toMatchObject([
      { day: "2025-03-10", costUsd: 1.5 },
    ]);
    expect(db.listCostBreakdown({ day: "2025-01-01" })).toEqual([]);
  });

  it("sums a day's spend for the budget check", () => {
    expect(db.getDailySpendUsd("2025-03-10")).toBe(3.5);
    expect(db.getDailySpendUsd("2025-03-11")).toBe(0.5);
    expect(db.getDailySpendUsd("2025-03-12")).toBe(0);
  });
});
