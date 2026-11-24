import {
  clearAgentLookupCache,
  getAgentLookupCacheMetrics,
  getCachedAgentById,
  invalidateCachedAgentById,
  resetAgentLookupCacheMetrics,
  setCachedAgentById,
} from "./index";

describe("agent-by-id lookup cache (Issue #906)", () => {
  beforeEach(() => {
    clearAgentLookupCache();
    resetAgentLookupCacheMetrics();
    jest.useFakeTimers();
    jest.setSystemTime(new Date("2026-11-24T00:00:00.000Z"));
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it("tracks misses then hits for agent-by-id lookups", () => {
    const agent = { id: "agent-1", capabilities: ["research"] };

    expect(getCachedAgentById("agent-1")).toBeUndefined();
    setCachedAgentById("agent-1", agent);
    expect(getCachedAgentById("agent-1")).toEqual(agent);
    expect(getCachedAgentById("agent-1")).toEqual(agent);

    expect(getAgentLookupCacheMetrics()).toEqual({
      hits: 2,
      misses: 1,
      size: 1,
      hitRate: 2 / 3,
    });
  });

  it("expires entries after 30 seconds TTL", () => {
    setCachedAgentById("agent-ttl", { id: "agent-ttl" });

    expect(getCachedAgentById("agent-ttl")).toEqual({ id: "agent-ttl" });
    jest.advanceTimersByTime(30_001);

    expect(getCachedAgentById("agent-ttl")).toBeUndefined();
    const metrics = getAgentLookupCacheMetrics();
    expect(metrics.hits).toBe(1);
    expect(metrics.misses).toBe(1);
    expect(metrics.size).toBe(0);
  });

  it("invalidates cached agent on update/delete", () => {
    setCachedAgentById("agent-2", { id: "agent-2", status: "online" });
    expect(getCachedAgentById("agent-2")).toEqual({ id: "agent-2", status: "online" });

    invalidateCachedAgentById("agent-2");

    expect(getCachedAgentById("agent-2")).toBeUndefined();
    const metrics = getAgentLookupCacheMetrics();
    expect(metrics.hits).toBe(1);
    expect(metrics.misses).toBe(1);
  });
});
