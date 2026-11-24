/**
 * Unit coverage for the never-throwing `capabilities` decoder (issue #645).
 *
 * Ordering caveat: the shared `tests/jestSetup.ts` imports `src/db/agents`, which
 * imports `src/utils/safeJson`, so the *real* `./logger` is already in the module
 * registry before this file is evaluated. A plain top-level import of `safeJson`
 * would therefore bind the real pino logger and `jest.mock` below would be too
 * late. `jest.resetModules()` + a dynamic `import()` inside `beforeAll` re-loads
 * `safeJson` against the mock, keeping pino out of the unit suite.
 */
jest.mock("./logger.js", () => ({
  __esModule: true,
  default: {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  },
}));

type SafeJsonModule = typeof import("./safeJson.js");
type LoggerModule = { default: { warn: jest.Mock } };

let safeJsonArray!: SafeJsonModule["safeJsonArray"];
let warn!: jest.Mock;

beforeAll(async () => {
  jest.resetModules();
  const safeJson = await import("./safeJson.js");
  const loggerModule = (await import("./logger.js")) as unknown as LoggerModule;
  safeJsonArray = safeJson.safeJsonArray;
  warn = loggerModule.default.warn;
});

/**
 * Issue #645 — a corrupted `capabilities` column must never escape a persisted
 * reader as a throw.
 */
describe("safeJsonArray", () => {
  beforeEach(() => {
    warn.mockClear();
  });

  it("returns the decoded array for a healthy column", () => {
    expect(safeJsonArray('["research","coding"]', "agents.list")).toEqual([
      "research",
      "coding",
    ]);
    expect(warn).not.toHaveBeenCalled();
  });

  it("returns an empty array for a malformed JSON document", () => {
    expect(safeJsonArray("{oops", "agents.list")).toEqual([]);
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ context: "agents.list", reason: "invalid-json", value: "{oops" }),
      expect.any(String),
    );
  });

  it("returns an empty array when the document is valid JSON but not an array", () => {
    expect(safeJsonArray('{"research":true}', "agents.findById")).toEqual([]);
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ context: "agents.findById", reason: "not-an-array" }),
      expect.any(String),
    );
  });

  it("drops entries that are not strings", () => {
    expect(safeJsonArray('["research",42,null,{"a":1}]', "agents.list")).toEqual(["research"]);
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ reason: "non-string-entry" }),
      expect.any(String),
    );
  });

  it("treats missing values as no capabilities without warning", () => {
    expect(safeJsonArray(null, "agents.list")).toEqual([]);
    expect(safeJsonArray(undefined, "agents.list")).toEqual([]);
    expect(safeJsonArray("", "agents.list")).toEqual([]);
    expect(warn).not.toHaveBeenCalled();
  });

  it("handles a non-string, non-null value", () => {
    expect(safeJsonArray(42, "agents.list")).toEqual([]);
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ reason: "not-a-string", value: "42" }),
      expect.any(String),
    );
  });

  it("truncates long values in the warning preview", () => {
    safeJsonArray(`["${"x".repeat(200)}`, "agents.list");
    const [fields] = warn.mock.calls[0] as [{ value: string }, string];
    expect(fields.value).toHaveLength(123);
    expect(fields.value.endsWith("...")).toBe(true);
  });

  it("names the offending agent id when the reader supplies one", () => {
    expect(safeJsonArray("{oops", "agents.list", "agent-7")).toEqual([]);
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({
        context: "agents.list",
        agentId: "agent-7",
        reason: "invalid-json",
      }),
      expect.any(String),
    );
  });

  it("omits the agent id when the reader does not supply one", () => {
    safeJsonArray("{oops", "agents.list");
    const [fields] = warn.mock.calls[0] as [{ agentId?: string }, string];
    expect(fields.agentId).toBeUndefined();
  });

  it("accepts an already-decoded array", () => {
    expect(safeJsonArray(["research", 7] as unknown as string[], "agents.list")).toEqual([
      "research",
    ]);
  });
});
