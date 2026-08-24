/**
 * Unit tests for ResearchAgent.
 *
 * The Venice client is injected as a mock so no real network calls are made.
 */
import { ResearchAgent, deriveConfidence } from "./research";
import { makeMockVeniceClient } from "../../test-utils";

// ── Helpers ───────────────────────────────────────────────────────────────────

const VALID_RESPONSE = JSON.stringify({
  summary: "Solar energy is growing rapidly in Southeast Asia.",
  keyFindings: ["Finding 1", "Finding 2"],
  sources: [
    { url: "https://example.com/1", title: "Source One" },
    { url: "https://example.com/2", title: "Source Two" },
    { url: "https://example.com/3", title: "Source Three" },
    { url: "https://example.com/4", title: "Source Four" },
  ],
  confidence: 0.9,
});

function makeAgent(completeResponse = VALID_RESPONSE) {
  const venice = makeMockVeniceClient(completeResponse);
  return { agent: new ResearchAgent({ veniceClient: venice }), venice };
}

// ─────────────────────────────────────────────────────────────────────────────
//  deriveConfidence helper
// ─────────────────────────────────────────────────────────────────────────────

describe("deriveConfidence", () => {
  it("returns 0.3 for 0 sources", () => {
    expect(deriveConfidence(0)).toBe(0.3);
  });

  it("returns 0.6 for 1 source", () => {
    expect(deriveConfidence(1)).toBe(0.6);
  });

  it("returns 0.6 for 3 sources", () => {
    expect(deriveConfidence(3)).toBe(0.6);
  });

  it("returns 0.9 for 4+ sources", () => {
    expect(deriveConfidence(4)).toBe(0.9);
    expect(deriveConfidence(100)).toBe(0.9);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
//  ResearchAgent.execute — happy path
// ─────────────────────────────────────────────────────────────────────────────

describe("ResearchAgent.execute — happy path", () => {
  it("returns a structured AgentResult on valid Venice response", async () => {
    const { agent } = makeAgent();
    const result = await agent.execute({
      taskId: "task_001",
      nodeId: "node_r1",
      prompt: "Solar energy in Southeast Asia",
    });

    expect(result).not.toHaveProperty("error");
    const r = result as any;
    expect(r.taskId).toBe("task_001");
    expect(r.nodeId).toBe("node_r1");
    expect(typeof r.summary).toBe("string");
    expect(Array.isArray(r.keyFindings)).toBe(true);
    expect(Array.isArray(r.sources)).toBe(true);
    expect(typeof r.confidence).toBe("number");
  });

  it("includes additional context in the prompt when provided", async () => {
    const venice = makeMockVeniceClient(VALID_RESPONSE);
    const agent = new ResearchAgent({ veniceClient: venice });

    await agent.execute({
      taskId: "task_001",
      nodeId: "node_r1",
      prompt: "Solar energy",
      context: "Focus on Southeast Asia",
    });

    const callArg = (venice.complete as jest.Mock).mock.calls[0][0] as string;
    expect(callArg).toContain("Focus on Southeast Asia");
  });

  it("strips markdown code fences from Venice response before parsing", async () => {
    const wrapped = "```json\n" + VALID_RESPONSE + "\n```";
    const { agent } = makeAgent(wrapped);

    const result = await agent.execute({
      taskId: "task_001",
      nodeId: "node_r1",
      prompt: "Solar energy",
    });

    expect(result).not.toHaveProperty("error");
  });

  it("derives confidence from source count, not Venice-supplied value", async () => {
    const { agent } = makeAgent();
    const result = await agent.execute({
      taskId: "task_001",
      nodeId: "node_r1",
      prompt: "Solar energy",
    }) as any;
    // 4 sources → deriveConfidence(4) = 0.9
    expect(result.confidence).toBe(0.9);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
//  ResearchAgent.execute — Venice unavailable
// ─────────────────────────────────────────────────────────────────────────────

describe("ResearchAgent.execute — Venice unavailable", () => {
  it("returns VENICE_UNAVAILABLE error when Venice throws on first call", async () => {
    const venice = makeMockVeniceClient("", { shouldFail: true });
    const agent = new ResearchAgent({ veniceClient: venice });

    const result = await agent.execute({
      taskId: "task_001",
      nodeId: "node_r1",
      prompt: "Solar energy",
    });

    expect(result).toEqual({ error: "VENICE_UNAVAILABLE" });
  });

  it("returns VENICE_UNAVAILABLE error when Venice throws on retry", async () => {
    const venice = makeMockVeniceClient("not valid json");
    // First call returns invalid JSON; second call (retry) also fails
    (venice.complete as jest.Mock)
      .mockResolvedValueOnce("not valid json")
      .mockRejectedValueOnce(new Error("connection reset"));

    const agent = new ResearchAgent({ veniceClient: venice });
    const result = await agent.execute({
      taskId: "task_001",
      nodeId: "node_r1",
      prompt: "Solar energy",
    });

    expect(result).toEqual({ error: "VENICE_UNAVAILABLE" });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
//  ResearchAgent.execute — malformed response
// ─────────────────────────────────────────────────────────────────────────────

describe("ResearchAgent.execute — malformed response", () => {
  it("returns VENICE_MALFORMED_RESPONSE when both attempts return invalid JSON", async () => {
    const venice = makeMockVeniceClient("not valid json at all");
    const agent = new ResearchAgent({ veniceClient: venice });

    const result = await agent.execute({
      taskId: "task_001",
      nodeId: "node_r1",
      prompt: "Solar energy",
    });

    expect(result).toEqual({ error: "VENICE_MALFORMED_RESPONSE" });
  });

  it("retries with JSON mode addendum on first parse failure", async () => {
    const venice = makeMockVeniceClient();
    (venice.complete as jest.Mock)
      .mockResolvedValueOnce("bad json")
      .mockResolvedValueOnce(VALID_RESPONSE);

    const agent = new ResearchAgent({ veniceClient: venice });
    const result = await agent.execute({
      taskId: "task_001",
      nodeId: "node_r1",
      prompt: "Solar energy",
    });

    expect(result).not.toHaveProperty("error");
    expect((venice.complete as jest.Mock)).toHaveBeenCalledTimes(2);
  });

  it("returns VENICE_MALFORMED_RESPONSE when schema validation fails on valid JSON", async () => {
    const invalidSchema = JSON.stringify({ summary: "ok" }); // missing required fields
    const venice = makeMockVeniceClient(invalidSchema);
    const agent = new ResearchAgent({ veniceClient: venice });

    const result = await agent.execute({
      taskId: "task_001",
      nodeId: "node_r1",
      prompt: "Solar energy",
    });

    expect(result).toEqual({ error: "VENICE_MALFORMED_RESPONSE" });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
//  ResearchAgent.register — network mock
// ─────────────────────────────────────────────────────────────────────────────

describe("ResearchAgent.register", () => {
  let fetchSpy: jest.SpyInstance;

  beforeEach(() => {
    fetchSpy = jest.spyOn(global, "fetch" as any);
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it("sends a POST to the registry endpoint", async () => {
    fetchSpy.mockResolvedValue({ ok: true } as Response);
    const agent = new ResearchAgent({ veniceClient: makeMockVeniceClient() });
    await agent.register();
    expect(fetchSpy).toHaveBeenCalledWith(
      expect.stringContaining("/api/agents/register"),
      expect.objectContaining({ method: "POST" })
    );
  });

  it("does not throw when registry is unreachable", async () => {
    fetchSpy.mockRejectedValue(new Error("ECONNREFUSED"));
    const agent = new ResearchAgent({ veniceClient: makeMockVeniceClient() });
    await expect(agent.register()).resolves.not.toThrow();
  });

  it("does not throw when registry returns non-2xx", async () => {
    fetchSpy.mockResolvedValue({ ok: false, status: 409 } as Response);
    const agent = new ResearchAgent({ veniceClient: makeMockVeniceClient() });
    await expect(agent.register()).resolves.not.toThrow();
  });
});
