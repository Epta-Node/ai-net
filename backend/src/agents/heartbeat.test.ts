/**
 * Unit tests for HeartbeatClient (src/agents/heartbeat.ts).
 *
 * Uses jest fake timers + global.fetch spy to avoid real network calls.
 */
import { HeartbeatClient } from "./heartbeat";

beforeEach(() => {
  jest.useFakeTimers();
});

afterEach(() => {
  jest.useRealTimers();
  jest.restoreAllMocks();
});

// ─────────────────────────────────────────────────────────────────────────────

describe("HeartbeatClient — start / stop", () => {
  it("sends an immediate heartbeat on start()", async () => {
    const fetchSpy = jest
      .spyOn(global, "fetch" as any)
      .mockResolvedValue({ ok: true } as Response);

    const client = new HeartbeatClient({
      apiBaseUrl: "http://localhost:3001",
      agentId: "test-agent",
      intervalMs: 1_000,
    });

    client.start();
    // Flush the async send()
    await Promise.resolve();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(fetchSpy).toHaveBeenCalledWith(
      "http://localhost:3001/api/agents/test-agent/heartbeat",
      { method: "POST" }
    );
    client.stop();
  });

  it("sends heartbeats on each interval tick", async () => {
    const fetchSpy = jest
      .spyOn(global, "fetch" as any)
      .mockResolvedValue({ ok: true } as Response);

    const client = new HeartbeatClient({
      apiBaseUrl: "http://localhost:3001",
      agentId: "test-agent",
      intervalMs: 1_000,
    });

    client.start();
    await Promise.resolve();
    // 1 immediate + 2 interval sends
    jest.advanceTimersByTime(2_000);
    await Promise.resolve();
    expect(fetchSpy.mock.calls.length).toBeGreaterThanOrEqual(2);
    client.stop();
  });

  it("calling start() twice does not create duplicate intervals", async () => {
    const fetchSpy = jest
      .spyOn(global, "fetch" as any)
      .mockResolvedValue({ ok: true } as Response);

    const client = new HeartbeatClient({
      apiBaseUrl: "http://localhost:3001",
      agentId: "test-agent",
      intervalMs: 1_000,
    });

    client.start();
    client.start(); // second call should be no-op
    await Promise.resolve();
    jest.advanceTimersByTime(1_000);
    await Promise.resolve();
    // Should NOT have doubled up: expect 2, not 4
    expect(fetchSpy.mock.calls.length).toBeLessThanOrEqual(3);
    client.stop();
  });

  it("stops sending after stop()", async () => {
    const fetchSpy = jest
      .spyOn(global, "fetch" as any)
      .mockResolvedValue({ ok: true } as Response);

    const client = new HeartbeatClient({
      apiBaseUrl: "http://localhost:3001",
      agentId: "test-agent",
      intervalMs: 1_000,
    });

    client.start();
    await Promise.resolve();
    client.stop();
    const countAfterStop = fetchSpy.mock.calls.length;

    jest.advanceTimersByTime(5_000);
    await Promise.resolve();
    // No more calls after stop
    expect(fetchSpy.mock.calls.length).toBe(countAfterStop);
  });

  it("calling stop() without start() does not throw", () => {
    const client = new HeartbeatClient({
      apiBaseUrl: "http://localhost:3001",
      agentId: "test-agent",
      intervalMs: 1_000,
    });
    expect(() => client.stop()).not.toThrow();
  });
});

describe("HeartbeatClient — send error handling", () => {
  it("does not throw when fetch rejects", async () => {
    jest.spyOn(global, "fetch" as any).mockRejectedValue(new Error("ECONNREFUSED"));

    const client = new HeartbeatClient({
      apiBaseUrl: "http://localhost:3001",
      agentId: "test-agent",
      intervalMs: 1_000,
    });

    client.start();
    await Promise.resolve();
    // Should not throw
    client.stop();
  });

  it("warns when server responds with non-ok status", async () => {
    jest
      .spyOn(global, "fetch" as any)
      .mockResolvedValue({ ok: false, status: 500 } as Response);
    const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});

    const client = new HeartbeatClient({
      apiBaseUrl: "http://localhost:3001",
      agentId: "test-agent",
      intervalMs: 1_000,
    });

    client.start();
    await Promise.resolve();
    expect(warnSpy).toHaveBeenCalled();
    client.stop();
    warnSpy.mockRestore();
  });

  it("URL-encodes agentId in the heartbeat endpoint", async () => {
    const fetchSpy = jest
      .spyOn(global, "fetch" as any)
      .mockResolvedValue({ ok: true } as Response);

    const client = new HeartbeatClient({
      apiBaseUrl: "http://localhost:3001",
      agentId: "agent/with/slashes",
      intervalMs: 1_000,
    });

    client.start();
    await Promise.resolve();
    expect(fetchSpy).toHaveBeenCalledWith(
      expect.stringContaining("agent%2Fwith%2Fslashes"),
      expect.any(Object)
    );
    client.stop();
  });

  it("strips trailing slash from apiBaseUrl", async () => {
    const fetchSpy = jest
      .spyOn(global, "fetch" as any)
      .mockResolvedValue({ ok: true } as Response);

    const client = new HeartbeatClient({
      apiBaseUrl: "http://localhost:3001/",
      agentId: "test-agent",
      intervalMs: 1_000,
    });

    client.start();
    await Promise.resolve();
    expect(fetchSpy).toHaveBeenCalledWith(
      "http://localhost:3001/api/agents/test-agent/heartbeat",
      expect.any(Object)
    );
    client.stop();
  });

  it("tracks consecutive failures and calls onFailureThresholdReached callback when threshold reached", async () => {
    jest
      .spyOn(global, "fetch" as any)
      .mockResolvedValue({ ok: false, status: 503 } as Response);

    const onThreshold = jest.fn();
    const client = new HeartbeatClient({
      apiBaseUrl: "http://localhost:3001",
      agentId: "failing-agent",
      intervalMs: 1_000,
      failureThreshold: 3,
      onFailureThresholdReached: onThreshold,
    });

    client.start();
    await Promise.resolve(); // 1st failure
    expect(client.getConsecutiveFailures()).toBe(1);
    expect(onThreshold).not.toHaveBeenCalled();

    jest.advanceTimersByTime(1_000);
    await Promise.resolve(); // 2nd failure
    expect(client.getConsecutiveFailures()).toBe(2);
    expect(onThreshold).not.toHaveBeenCalled();

    jest.advanceTimersByTime(1_000);
    await Promise.resolve(); // 3rd failure
    expect(client.getConsecutiveFailures()).toBe(3);
    expect(onThreshold).toHaveBeenCalledWith(3);

    client.stop();
  });
});

