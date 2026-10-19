import { makeAgentDb } from "../test-utils";
import type { AgentRecord } from "../db/agents";
import { AGENT_EVICTED_EVENT, type AgentEvictedEvent } from "../events/eventTypes";
import { createAgentWatchdog, getAgentWatchdogEvictionsTotal } from "./agentWatchdog";

const SILENT_LOGGER = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
const INTERVAL_MS = 30_000;
const GRACE_MINUTES = 1;
const START_MS = Date.parse("2026-10-19T12:00:00.000Z");

function agentSeenAt(id: string, lastSeenMs: number): AgentRecord {
  return {
    id,
    capabilities: ["research"],
    pricingXLM: 1,
    endpoint: `https://${id}.example.test`,
    stellarPublicKey: `G${id.toUpperCase()}`,
    reputationScore: 2.5,
    lastSeenAt: new Date(lastSeenMs).toISOString(),
    status: "online",
  };
}

describe("agent watchdog eviction (#804)", () => {
  let clock: number;
  let db: ReturnType<typeof makeAgentDb>;
  let published: AgentEvictedEvent[];
  let invalidateCache: jest.Mock;

  function buildWatchdog(publishEvent?: (event: AgentEvictedEvent) => void) {
    return createAgentWatchdog({
      db,
      logger: SILENT_LOGGER,
      intervalMs: INTERVAL_MS,
      gracePeriodMinutes: GRACE_MINUTES,
      now: () => clock,
      publishEvent: publishEvent ?? ((event) => published.push(event)),
      invalidateCache,
    });
  }

  beforeEach(() => {
    clock = START_MS;
    db = makeAgentDb();
    published = [];
    invalidateCache = jest.fn(async () => undefined);
  });

  it("evicts an agent silent past the grace period and publishes agent.evicted", async () => {
    db.upsert(agentSeenAt("stale-1", START_MS - 10 * 60_000));
    const watchdog = buildWatchdog();
    const evictionsBefore = getAgentWatchdogEvictionsTotal();

    // First pass quarantines the agent and starts its grace clock.
    await watchdog.tick();
    expect(db.findById("stale-1")).toBeDefined();

    // Once the grace period has elapsed, the next pass evicts it.
    clock += GRACE_MINUTES * 60_000 + 1_000;
    const stats = await watchdog.tick();

    expect(stats.evicted).toBe(1);
    expect(db.findById("stale-1")).toBeUndefined();
    expect(getAgentWatchdogEvictionsTotal()).toBe(evictionsBefore + 1);

    expect(published).toHaveLength(1);
    expect(published[0]).toMatchObject({
      type: AGENT_EVICTED_EVENT,
      taskId: "agent:stale-1",
      payload: {
        agentId: "stale-1",
        reason: "heartbeat_timeout",
        lastSeenAt: new Date(START_MS - 10 * 60_000).toISOString(),
      },
    });
    expect(invalidateCache).toHaveBeenCalledTimes(1);
  });

  it("does not evict an agent that keeps heartbeating", async () => {
    db.upsert(agentSeenAt("healthy-1", clock));
    const watchdog = buildWatchdog();

    for (let step = 0; step < 3; step += 1) {
      clock += INTERVAL_MS / 2;
      db.upsert(agentSeenAt("healthy-1", clock));
      await watchdog.tick();
    }

    expect(db.findById("healthy-1")).toBeDefined();
    expect(published).toHaveLength(0);
    expect(invalidateCache).not.toHaveBeenCalled();
  });

  it("still evicts when publishing the event fails", async () => {
    db.upsert(agentSeenAt("stale-2", START_MS - 10 * 60_000));
    const watchdog = buildWatchdog(() => {
      throw new Error("event store unavailable");
    });

    await watchdog.tick();
    clock += GRACE_MINUTES * 60_000 + 1_000;
    const stats = await watchdog.tick();

    expect(stats.evicted).toBe(1);
    expect(db.findById("stale-2")).toBeUndefined();
  });

  it("reports status with the quarantine count and recent evictions", async () => {
    db.upsert(agentSeenAt("stale-3", START_MS - 10 * 60_000));
    const watchdog = buildWatchdog();

    expect(watchdog.getStatus()).toMatchObject({
      running: false,
      lastRunAt: null,
      nextRunAt: null,
      stalledCount: 0,
      evictedLast24h: 0,
      recentEvictions: [],
    });

    await watchdog.tick();
    expect(watchdog.getStatus()).toMatchObject({
      lastRunAt: new Date(START_MS).toISOString(),
      stalledCount: 1,
    });

    clock += GRACE_MINUTES * 60_000 + 1_000;
    await watchdog.tick();
    const status = watchdog.getStatus();

    expect(status.stalledCount).toBe(0);
    expect(status.evictedLast24h).toBe(1);
    expect(status.recentEvictions).toHaveLength(1);
    expect(status.recentEvictions[0]).toMatchObject({ agentId: "stale-3" });
    expect(status.intervalMs).toBe(INTERVAL_MS);
    expect(status.gracePeriodMinutes).toBe(GRACE_MINUTES);
  });
});
