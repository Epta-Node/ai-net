/**
 * Unit tests for AgentStartupRegistry.
 *
 * Mocks agent instances to avoid network calls and VENICE_API_KEY requirements.
 */

// ── Mock agent classes before importing registry ──────────────────────────────

const mockRegister = jest.fn().mockResolvedValue(undefined);
const mockStartHeartbeat = jest.fn();
const mockStopHeartbeat = jest.fn();
const mockHealthCheck = jest.fn().mockResolvedValue(true);

// All concrete agent classes are replaced with a lightweight mock
jest.mock("./research/research", () => ({
  ResearchAgent: jest.fn().mockImplementation(() => ({
    agentId: "research-agent-1",
    register: mockRegister,
    startHeartbeat: mockStartHeartbeat,
    stopHeartbeat: mockStopHeartbeat,
    healthCheck: mockHealthCheck,
  })),
}));

jest.mock("./risk", () => ({
  RiskAgent: jest.fn().mockImplementation(() => ({
    agentId: "risk-agent-1",
    register: mockRegister,
    startHeartbeat: mockStartHeartbeat,
    stopHeartbeat: mockStopHeartbeat,
    healthCheck: mockHealthCheck,
  })),
}));

jest.mock("./coding", () => ({
  CodingAgent: jest.fn().mockImplementation(() => ({
    agentId: "coding-agent-1",
    register: mockRegister,
    startHeartbeat: mockStartHeartbeat,
    stopHeartbeat: mockStopHeartbeat,
    healthCheck: mockHealthCheck,
  })),
}));

jest.mock("./design", () => ({
  DesignAgent: jest.fn().mockImplementation(() => ({
    agentId: "design-agent-1",
    register: mockRegister,
    startHeartbeat: mockStartHeartbeat,
    stopHeartbeat: mockStopHeartbeat,
    healthCheck: mockHealthCheck,
  })),
}));

jest.mock("./report", () => ({
  ReportAgent: jest.fn().mockImplementation(() => ({
    agentId: "report-agent-1",
    register: mockRegister,
    startHeartbeat: mockStartHeartbeat,
    stopHeartbeat: mockStopHeartbeat,
    healthCheck: mockHealthCheck,
  })),
}));

import { AgentStartupRegistry } from "./registry";

// ─────────────────────────────────────────────────────────────────────────────

beforeEach(() => {
  jest.clearAllMocks();
});

describe("AgentStartupRegistry — initialize", () => {
  it("registers all 5 agents when autoRegister=true", async () => {
    const registry = new AgentStartupRegistry({ autoRegister: true });
    await registry.initialize();
    // register() should have been called 5 times (once per agent)
    expect(mockRegister).toHaveBeenCalledTimes(5);
    expect(mockStartHeartbeat).toHaveBeenCalledTimes(5);
  });

  it("does not call register when autoRegister=false", async () => {
    const registry = new AgentStartupRegistry({ autoRegister: false });
    await registry.initialize();
    expect(mockRegister).not.toHaveBeenCalled();
    expect(mockStartHeartbeat).not.toHaveBeenCalled();
  });

  it("initialises 5 agents", async () => {
    const registry = new AgentStartupRegistry({ autoRegister: false });
    await registry.initialize();
    expect(registry.getAgents()).toHaveLength(5);
  });

  it("continues even if a single agent registration throws", async () => {
    mockRegister.mockRejectedValueOnce(new Error("registration failed"));
    const registry = new AgentStartupRegistry({ autoRegister: true });
    await expect(registry.initialize()).resolves.not.toThrow();
    // Other agents still registered
    expect(mockRegister).toHaveBeenCalledTimes(5);
  });
});

describe("AgentStartupRegistry — getAgents / getAgentByCapability", () => {
  it("getAgents returns one entry per agent with capability and agentId", async () => {
    const registry = new AgentStartupRegistry({ autoRegister: false });
    await registry.initialize();
    const agents = registry.getAgents();
    expect(agents.map(a => a.capability).sort()).toEqual(
      ["coding", "design", "report", "research", "risk"].sort()
    );
    agents.forEach(a => {
      expect(a.agentId).toBeTruthy();
      expect(a.instance).toBeDefined();
    });
  });

  it("getAgentByCapability returns the matching agent instance", async () => {
    const registry = new AgentStartupRegistry({ autoRegister: false });
    await registry.initialize();
    const agent = registry.getAgentByCapability("research");
    expect(agent).toBeDefined();
  });

  it("getAgentByCapability returns undefined for unknown capability", async () => {
    const registry = new AgentStartupRegistry({ autoRegister: false });
    await registry.initialize();
    expect(registry.getAgentByCapability("nonexistent")).toBeUndefined();
  });
});

describe("AgentStartupRegistry — healthCheck", () => {
  it("returns ok=true for all healthy agents", async () => {
    const registry = new AgentStartupRegistry({ autoRegister: false });
    await registry.initialize();
    const results = await registry.healthCheck();
    expect(Object.values(results).every(v => v === true)).toBe(true);
    expect(Object.keys(results)).toHaveLength(5);
  });

  it("returns false for an agent whose healthCheck throws", async () => {
    mockHealthCheck.mockRejectedValueOnce(new Error("unhealthy"));
    const registry = new AgentStartupRegistry({ autoRegister: false });
    await registry.initialize();
    const results = await registry.healthCheck();
    // At least one agent was false
    expect(Object.values(results)).toContain(false);
  });
});

describe("AgentStartupRegistry — shutdown", () => {
  it("calls stopHeartbeat on all agents", async () => {
    const registry = new AgentStartupRegistry({ autoRegister: false });
    await registry.initialize();
    await registry.shutdown();
    expect(mockStopHeartbeat).toHaveBeenCalledTimes(5);
  });

  it("does not throw even if stopHeartbeat throws", async () => {
    mockStopHeartbeat.mockImplementationOnce(() => {
      throw new Error("stop error");
    });
    const registry = new AgentStartupRegistry({ autoRegister: false });
    await registry.initialize();
    await expect(registry.shutdown()).resolves.not.toThrow();
  });
});
