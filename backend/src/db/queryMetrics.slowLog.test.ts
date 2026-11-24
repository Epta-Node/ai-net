import { queryHashOf, recordDbQuery } from "./queryMetrics";

// Force the defaults (100 ms slow threshold) and capture what the logger receives (#923).
const mockWarn = jest.fn();

jest.mock("../config", () => ({
  getConfig: () => {
    throw new Error("config unavailable in this test");
  },
}));

jest.mock("../utils/logger", () => ({
  createLogger: () => ({
    warn: (...args: unknown[]) => mockWarn(...args),
    info: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  }),
}));

describe("slow query log (#923)", () => {
  beforeEach(() => {
    mockWarn.mockClear();
  });

  it("treats a 150 ms statement as slow under the 100 ms default", () => {
    recordDbQuery("tasks", "SELECT * FROM tasks WHERE id = ?", 150);
    expect(mockWarn).toHaveBeenCalledTimes(1);
  });

  it("does not log a statement under the threshold", () => {
    recordDbQuery("tasks", "SELECT * FROM tasks WHERE id = ?", 99);
    expect(mockWarn).not.toHaveBeenCalled();
  });

  it("logs the full SQL text with its placeholders and a grouping hash", () => {
    const sql = "SELECT id, status FROM tasks WHERE agent_id = ? AND status = ?";
    recordDbQuery("tasks", sql, 250);

    expect(mockWarn).toHaveBeenCalledTimes(1);
    const [fields, message] = mockWarn.mock.calls[0] as [Record<string, unknown>, string];
    expect(message).toBe("slow query");
    expect(fields).toMatchObject({
      event: "slow_query",
      db: "tasks",
      operation: "select",
      sql,
      queryHash: queryHashOf(sql),
    });
  });
});
