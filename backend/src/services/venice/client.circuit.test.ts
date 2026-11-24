/**
 * VeniceClient ⇄ CircuitBreaker integration tests (issue #495).
 *
 * These exercise the client-side contract that the breaker enforces:
 * calls are shed before any HTTP request is made, the metrics snapshot is
 * observable, the `HALF_OPEN` probe budget is never leaked by cache hits, and
 * the state transitions are surfaced to callers.
 */

import { VeniceClient } from "./client";
import { CircuitBreaker, type CircuitTransition } from "./circuitBreaker";
import { CircuitOpenError } from "./errors";
import { VeniceResponseCache } from "./cache";

const mockFetch = jest.fn();
(global as any).fetch = mockFetch;

function okResponse(content: string) {
  return {
    ok: true,
    status: 200,
    json: () => Promise.resolve({ choices: [{ message: { content } }] }),
  };
}

function errorResponse(status: number) {
  return { ok: false, status, json: () => Promise.resolve({ error: "fail" }) };
}

/** Drive the client until it has accumulated `count` consecutive failures. */
async function failCompletions(
  client: VeniceClient,
  count: number,
): Promise<void> {
  for (let i = 0; i < count; i++) {
    mockFetch.mockResolvedValueOnce(errorResponse(500));
    await expect(
      client.complete(`unique-prompt-${Math.random()}`, "research"),
    ).rejects.toThrow();
  }
}

describe("VeniceClient circuit breaker (issue #495)", () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  it("builds a breaker from the injected config when none is provided", () => {
    const client = new VeniceClient({
      apiKey: "k",
      failureThreshold: 5,
      cooldownMs: 1_000,
      probeCount: 2,
    });

    expect(client.getCircuitBreaker().getConfig()).toEqual({
      failureThreshold: 5,
      cooldownMs: 1_000,
      probeCount: 2,
    });
  });

  it("exposes the full metrics snapshot through getCircuitMetrics()", () => {
    const client = new VeniceClient({ apiKey: "k" });

    expect(client.getCircuitMetrics()).toEqual({
      state: "CLOSED",
      failures: 0,
      successes: 0,
      lastFailureAt: null,
      lastSuccessAt: null,
    });
  });

  it("opens after the configured number of consecutive failures and sheds the next call", async () => {
    const client = new VeniceClient({
      apiKey: "k",
      failureThreshold: 2,
      maxRetries: 0,
    });

    await failCompletions(client, 2);
    expect(client.getCircuitState()).toBe("OPEN");
    expect(client.getCircuitMetrics().failures).toBe(2);

    const callsBefore = mockFetch.mock.calls.length;
    await expect(client.complete("shed-me", "research")).rejects.toThrow(
      CircuitOpenError,
    );
    expect(mockFetch.mock.calls.length).toBe(callsBefore);
  });

  it("rejects with CircuitOpenError rather than surfacing the upstream 5xx", async () => {
    const client = new VeniceClient({
      apiKey: "k",
      failureThreshold: 1,
      maxRetries: 0,
    });

    await failCompletions(client, 1);

    try {
      await client.complete("shed-me", "research");
      throw new Error("expected the call to be shed");
    } catch (err) {
      expect(err).toBeInstanceOf(CircuitOpenError);
      expect((err as Error).message).not.toContain("500");
    }
  });

  it("recovers automatically: half-open probe succeeds and the circuit closes", async () => {
    let now = 0;
    const breaker = new CircuitBreaker({
      failureThreshold: 1,
      cooldownMs: 1_000,
      nowFn: () => now,
    });
    const client = new VeniceClient({
      apiKey: "k",
      circuitBreaker: breaker,
      maxRetries: 0,
    });

    await failCompletions(client, 1);
    expect(client.getCircuitState()).toBe("OPEN");

    now += 1_000;
    expect(client.getCircuitState()).toBe("HALF_OPEN");

    mockFetch.mockResolvedValueOnce(okResponse("recovered"));
    await expect(client.complete("probe", "research")).resolves.toBe(
      "recovered",
    );

    expect(client.getCircuitState()).toBe("CLOSED");
    expect(client.getCircuitMetrics().successes).toBe(1);
  });

  it("reopens when the half-open probe fails", async () => {
    let now = 0;
    const breaker = new CircuitBreaker({
      failureThreshold: 1,
      cooldownMs: 1_000,
      nowFn: () => now,
    });
    const client = new VeniceClient({
      apiKey: "k",
      circuitBreaker: breaker,
      maxRetries: 0,
    });

    await failCompletions(client, 1);
    now += 1_000;
    expect(client.getCircuitState()).toBe("HALF_OPEN");

    mockFetch.mockResolvedValueOnce(errorResponse(503));
    await expect(client.complete("probe-fail", "research")).rejects.toThrow();

    expect(client.getCircuitState()).toBe("OPEN");
  });

  it("does not leak a half-open probe slot when the call is served from cache", async () => {
    let now = 0;
    const breaker = new CircuitBreaker({
      failureThreshold: 1,
      cooldownMs: 1_000,
      nowFn: () => now,
    });
    // Pre-seed the cache with a fresh entry for the probe prompt.
    const cache = new VeniceResponseCache({ defaultTtlMs: 60_000 });
    cache.set("cached-probe", "research", "v1", "from-cache");
    const client = new VeniceClient({
      apiKey: "k",
      circuitBreaker: breaker,
      cache,
      modelVersion: "v1",
      maxRetries: 0,
    });

    await failCompletions(client, 1);
    now += 1_000;
    expect(client.getCircuitState()).toBe("HALF_OPEN");

    const callsBefore = mockFetch.mock.calls.length;
    await expect(client.complete("cached-probe", "research")).resolves.toBe(
      "from-cache",
    );
    expect(mockFetch.mock.calls.length).toBe(callsBefore);

    // The slot was released, so the next probe is still admitted.
    expect(breaker.getProbesInFlight()).toBe(0);
    expect(breaker.getState()).toBe("HALF_OPEN");

    mockFetch.mockResolvedValueOnce(okResponse("probe-through"));
    await expect(client.complete("another-probe", "research")).resolves.toBe(
      "probe-through",
    );
    expect(client.getCircuitState()).toBe("CLOSED");
  });

  it("notifies onCircuitStateChange for every transition", async () => {
    const transitions: CircuitTransition[] = [];
    let now = 0;
    const client = new VeniceClient({
      apiKey: "k",
      maxRetries: 0,
      onCircuitStateChange: (t) => transitions.push(t),
      circuitBreaker: new CircuitBreaker({
        failureThreshold: 1,
        cooldownMs: 1_000,
        nowFn: () => now,
      }),
    });

    mockFetch.mockResolvedValueOnce(errorResponse(500));
    await expect(client.complete("boom", "research")).rejects.toThrow();
    now += 1_000;
    client.getCircuitBreaker().acquire();
    client.getCircuitBreaker().recordSuccess();

    expect(transitions.map((t) => t.event)).toEqual([
      "opened",
      "half_opened",
      "closed",
    ]);
  });

  it("dispose() detaches the client-level transition listener", () => {
    const transitions: string[] = [];
    const client = new VeniceClient({
      apiKey: "k",
      onCircuitStateChange: (t) => transitions.push(t.event),
    });
    const breaker = client.getCircuitBreaker();
    client.dispose();

    // The caller's own subscription still works…
    const onAll = jest.fn();
    breaker.on("*", onAll);
    for (let i = 0; i < 3; i++) breaker.recordFailure();
    expect(breaker.getState()).toBe("OPEN");
    expect(onAll).toHaveBeenCalledTimes(1);
    // …but the client no longer mirrors the transition to its callback.
    expect(transitions).toEqual([]);
  });

  it("serves a stale cache response when the circuit is open instead of failing", async () => {
    const breaker = new CircuitBreaker({
      failureThreshold: 1,
      cooldownMs: 60_000,
    });
    const cache = new VeniceResponseCache({ defaultTtlMs: 1 });
    const client = new VeniceClient({
      apiKey: "k",
      circuitBreaker: breaker,
      cache,
      maxRetries: 0,
    });

    mockFetch.mockResolvedValueOnce(okResponse("fresh-then-stale"));
    await client.complete("degrade-me", "research");

    // Expire the entry, then trip the circuit.
    await new Promise((r) => setTimeout(r, 5));
    mockFetch.mockResolvedValueOnce(errorResponse(500));
    await expect(
      client.complete(`fail-${Math.random()}`, "research"),
    ).rejects.toThrow();
    expect(client.getCircuitState()).toBe("OPEN");

    await expect(client.complete("degrade-me", "research")).resolves.toBe(
      "fresh-then-stale",
    );
  });

  it("applies the breaker to streaming calls", async () => {
    const client = new VeniceClient({
      apiKey: "k",
      failureThreshold: 1,
      maxRetries: 0,
    });

    await failCompletions(client, 1);
    const callsBefore = mockFetch.mock.calls.length;

    await expect(
      client.stream("stream-me", "research", () => {}),
    ).rejects.toThrow(CircuitOpenError);
    expect(mockFetch.mock.calls.length).toBe(callsBefore);
  });

  it("lets a half-open stream probe close the circuit", async () => {
    let now = 0;
    const breaker = new CircuitBreaker({
      failureThreshold: 1,
      cooldownMs: 1_000,
      nowFn: () => now,
    });
    const client = new VeniceClient({
      apiKey: "k",
      circuitBreaker: breaker,
      maxRetries: 0,
    });

    await failCompletions(client, 1);
    now += 1_000;
    expect(client.getCircuitState()).toBe("HALF_OPEN");

    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      body: {
        getReader: () => ({
          read: () => Promise.resolve({ done: true, value: undefined }),
        }),
      },
    });

    await client.stream("stream-probe", "research", () => {});

    expect(client.getCircuitState()).toBe("CLOSED");
  });
});
