/**
 * Unit tests for BaseAgent — covers register, startHeartbeat, stopHeartbeat,
 * healthCheck, parseJsonResponse, validateOutput, and callVeniceWithRetry.
 *
 * Uses a concrete TestAgent subclass since BaseAgent is abstract.
 */
import { z } from "zod";
import { BaseAgent, type AgentTask } from "./BaseAgent";
import { makeMockVeniceClient } from "../../test-utils";

// ── Concrete test subclass ────────────────────────────────────────────────────

const OutputSchema = z.object({ answer: z.string() });

class TestAgent extends BaseAgent {
  getCapability(): string {
    return "test";
  }

  getOutputSchema(): z.ZodSchema {
    return OutputSchema;
  }

  async execute(_task: AgentTask): Promise<unknown> {
    return this.callVeniceWithRetry(
      "You are a test agent.",
      _task.prompt,
      "\n\nPlease respond with valid JSON."
    );
  }

  // Expose protected helpers for testing
  exposeParseJson(raw: string): unknown | null {
    return this.parseJsonResponse(raw);
  }

  exposeValidateOutput(raw: unknown): unknown | null {
    return this.validateOutput(raw);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
//  parseJsonResponse
// ─────────────────────────────────────────────────────────────────────────────

describe("BaseAgent.parseJsonResponse", () => {
  it("parses valid JSON object", () => {
    const agent = new TestAgent({ veniceClient: makeMockVeniceClient() });
    expect(agent.exposeParseJson('{"answer":"hello"}')).toEqual({ answer: "hello" });
  });

  it("strips leading/trailing code fences before parsing", () => {
    const agent = new TestAgent({ veniceClient: makeMockVeniceClient() });
    expect(agent.exposeParseJson('```json\n{"answer":"hello"}\n```')).toEqual({ answer: "hello" });
  });

  it("returns null for invalid JSON", () => {
    const agent = new TestAgent({ veniceClient: makeMockVeniceClient() });
    expect(agent.exposeParseJson("not valid json")).toBeNull();
  });

  it("returns null for non-string input", () => {
    const agent = new TestAgent({ veniceClient: makeMockVeniceClient() });
    expect(agent.exposeParseJson(42 as any)).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
//  validateOutput
// ─────────────────────────────────────────────────────────────────────────────

describe("BaseAgent.validateOutput", () => {
  it("returns data on valid output", () => {
    const agent = new TestAgent({ veniceClient: makeMockVeniceClient() });
    expect(agent.exposeValidateOutput({ answer: "hi" })).toEqual({ answer: "hi" });
  });

  it("returns null when schema validation fails", () => {
    const agent = new TestAgent({ veniceClient: makeMockVeniceClient() });
    expect(agent.exposeValidateOutput({ wrong: "field" })).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
//  callVeniceWithRetry
// ─────────────────────────────────────────────────────────────────────────────

describe("BaseAgent.callVeniceWithRetry", () => {
  it("returns result on valid first-attempt response", async () => {
    const venice = makeMockVeniceClient('{"answer":"solar"}');
    const agent = new TestAgent({ veniceClient: venice });

    const result = await agent.execute({ taskId: "t1", nodeId: "n1", prompt: "Test" });
    expect(result).toEqual({ answer: "solar" });
  });

  it("retries with JSON mode addendum on first parse failure", async () => {
    const venice = makeMockVeniceClient();
    (venice.complete as jest.Mock)
      .mockResolvedValueOnce("not json")
      .mockResolvedValueOnce('{"answer":"retry"}');

    const agent = new TestAgent({ veniceClient: venice });
    const result = await agent.execute({ taskId: "t1", nodeId: "n1", prompt: "Test" });
    expect(result).toEqual({ answer: "retry" });
    expect(venice.complete).toHaveBeenCalledTimes(2);
  });

  it("returns VENICE_UNAVAILABLE when first call throws", async () => {
    const venice = makeMockVeniceClient("", { shouldFail: true });
    const agent = new TestAgent({ veniceClient: venice });

    const result = await agent.execute({ taskId: "t1", nodeId: "n1", prompt: "Test" });
    expect(result).toEqual({ error: "VENICE_UNAVAILABLE" });
  });

  it("returns VENICE_UNAVAILABLE when retry throws", async () => {
    const venice = makeMockVeniceClient();
    (venice.complete as jest.Mock)
      .mockResolvedValueOnce("not json")
      .mockRejectedValueOnce(new Error("connection reset"));

    const agent = new TestAgent({ veniceClient: venice });
    const result = await agent.execute({ taskId: "t1", nodeId: "n1", prompt: "Test" });
    expect(result).toEqual({ error: "VENICE_UNAVAILABLE" });
  });

  it("returns VENICE_MALFORMED_RESPONSE when both attempts return invalid schema", async () => {
    const venice = makeMockVeniceClient('{"wrong":"field"}');
    const agent = new TestAgent({ veniceClient: venice });

    const result = await agent.execute({ taskId: "t1", nodeId: "n1", prompt: "Test" });
    expect(result).toEqual({ error: "VENICE_MALFORMED_RESPONSE" });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
//  healthCheck
// ─────────────────────────────────────────────────────────────────────────────

describe("BaseAgent.healthCheck", () => {
  it("returns true when Venice responds", async () => {
    const venice = makeMockVeniceClient("ok");
    const agent = new TestAgent({ veniceClient: venice });
    expect(await agent.healthCheck()).toBe(true);
  });

  it("returns false when Venice throws", async () => {
    const venice = makeMockVeniceClient("", { shouldFail: true });
    const agent = new TestAgent({ veniceClient: venice });
    expect(await agent.healthCheck()).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
//  register
// ─────────────────────────────────────────────────────────────────────────────

describe("BaseAgent.register", () => {
  let fetchSpy: jest.SpyInstance;

  beforeEach(() => {
    fetchSpy = jest.spyOn(global, "fetch" as any);
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it("sends POST to /api/agents/register", async () => {
    fetchSpy.mockResolvedValue({ ok: true } as Response);
    const agent = new TestAgent({
      veniceClient: makeMockVeniceClient(),
      apiBaseUrl: "http://localhost:3001",
    });
    await agent.register();
    expect(fetchSpy).toHaveBeenCalledWith(
      "http://localhost:3001/api/agents/register",
      expect.objectContaining({ method: "POST" })
    );
  });

  it("does not throw on fetch error", async () => {
    fetchSpy.mockRejectedValue(new Error("ECONNREFUSED"));
    const agent = new TestAgent({ veniceClient: makeMockVeniceClient() });
    await expect(agent.register()).resolves.not.toThrow();
  });

  it("does not throw on non-ok response", async () => {
    fetchSpy.mockResolvedValue({ ok: false, status: 409 } as Response);
    const agent = new TestAgent({ veniceClient: makeMockVeniceClient() });
    await expect(agent.register()).resolves.not.toThrow();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
//  startHeartbeat / stopHeartbeat
// ─────────────────────────────────────────────────────────────────────────────

describe("BaseAgent.startHeartbeat / stopHeartbeat", () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it("calling startHeartbeat / stopHeartbeat without apiBaseUrl set is safe (no-op)", () => {
    // No apiBaseUrl → heartbeatClient is null → startHeartbeat is a no-op
    const agent = new TestAgent({ veniceClient: makeMockVeniceClient() });
    expect(() => {
      agent.startHeartbeat();
      agent.stopHeartbeat();
    }).not.toThrow();
  });

  it("starts and stops the heartbeat client when apiBaseUrl is provided", async () => {
    const fetchSpy = jest
      .spyOn(global, "fetch" as any)
      .mockResolvedValue({ ok: true } as Response);

    const agent = new TestAgent({
      veniceClient: makeMockVeniceClient(),
      apiBaseUrl: "http://localhost:3001",
    });

    agent.startHeartbeat();
    await Promise.resolve();
    expect(fetchSpy.mock.calls.length).toBeGreaterThanOrEqual(1);

    agent.stopHeartbeat();
    const callsAfterStop = fetchSpy.mock.calls.length;
    jest.advanceTimersByTime(5_000);
    await Promise.resolve();
    expect(fetchSpy.mock.calls.length).toBe(callsAfterStop);
  });
});
