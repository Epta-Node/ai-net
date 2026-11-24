/**
 * Circuit breaker unit tests (issue #495).
 *
 * Covers the complete `CLOSED → OPEN → HALF_OPEN → CLOSED` state machine, the
 * configurable thresholds, the metrics snapshot, the transition events, and the
 * automatic recovery path — all driven through a controllable clock so no test
 * has to wait in real time.
 */

import {
  CircuitBreaker,
  DEFAULT_COOLDOWN_MS,
  DEFAULT_FAILURE_THRESHOLD,
  DEFAULT_PROBE_COUNT,
  type CircuitTransition,
} from "./circuitBreaker";
import { CircuitOpenError } from "./errors";

const silentLogger = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };

/** A breaker wired to a manually advanced clock and a silenced logger. */
function makeBreaker(
  options: Partial<ConstructorParameters<typeof CircuitBreaker>[0]> = {},
): {
  breaker: CircuitBreaker;
  advance: (ms: number) => void;
  now: () => number;
} {
  let current = 1_000_000;
  const breaker = new CircuitBreaker({
    nowFn: () => current,
    logger: silentLogger,
    ...(options as object),
  });
  return {
    breaker,
    advance: (ms: number) => {
      current += ms;
    },
    now: () => current,
  };
}

function openCircuit(
  breaker: CircuitBreaker,
  times = DEFAULT_FAILURE_THRESHOLD,
): void {
  for (let i = 0; i < times; i++) breaker.recordFailure();
}

describe("CircuitBreaker — configuration", () => {
  it("uses the documented defaults", () => {
    const { breaker } = makeBreaker();

    expect(DEFAULT_FAILURE_THRESHOLD).toBe(3);
    expect(DEFAULT_COOLDOWN_MS).toBe(60_000);
    expect(DEFAULT_PROBE_COUNT).toBe(1);
    expect(breaker.getConfig()).toEqual({
      failureThreshold: 3,
      cooldownMs: 60_000,
      probeCount: 1,
    });
  });

  it("honours a custom failureThreshold", () => {
    const { breaker } = makeBreaker({ failureThreshold: 1 });

    breaker.recordFailure();

    expect(breaker.getState()).toBe("OPEN");
  });

  it("honours a custom cooldownMs", () => {
    const { breaker, advance } = makeBreaker({ cooldownMs: 5_000 });
    openCircuit(breaker);
    expect(breaker.getState()).toBe("OPEN");

    advance(5_000);

    expect(breaker.getState()).toBe("HALF_OPEN");
  });

  it("honours a custom probeCount", () => {
    const { breaker, advance } = makeBreaker({ probeCount: 3 });
    openCircuit(breaker);
    advance(DEFAULT_COOLDOWN_MS);

    expect(breaker.getState()).toBe("HALF_OPEN");
    expect(() => breaker.acquire()).not.toThrow();
    expect(() => breaker.acquire()).not.toThrow();
    expect(() => breaker.acquire()).not.toThrow();
    expect(() => breaker.acquire()).toThrow(CircuitOpenError);
  });

  it("falls back to defaults for nonsensical values", () => {
    const { breaker } = makeBreaker({
      failureThreshold: 0,
      cooldownMs: -1,
      probeCount: Number.NaN,
    });

    expect(breaker.getConfig()).toEqual({
      failureThreshold: 3,
      cooldownMs: 60_000,
      probeCount: 1,
    });
  });

  it("still accepts the legacy single-clock constructor argument", () => {
    let current = 42;
    const breaker = new CircuitBreaker(() => current);

    openCircuit(breaker);
    expect(breaker.getState()).toBe("OPEN");

    current += DEFAULT_COOLDOWN_MS;
    expect(breaker.getState()).toBe("HALF_OPEN");
  });
});

describe("CircuitBreaker — CLOSED state", () => {
  it("starts closed with no failures recorded", () => {
    const { breaker } = makeBreaker();

    expect(breaker.getState()).toBe("CLOSED");
    expect(breaker.getFailureCount()).toBe(0);
  });

  it("stays closed below the failure threshold", () => {
    const { breaker } = makeBreaker();

    breaker.recordFailure();
    breaker.recordFailure();

    expect(breaker.getState()).toBe("CLOSED");
    expect(breaker.getFailureCount()).toBe(2);
  });

  it("admits every call while closed", () => {
    const { breaker } = makeBreaker();

    for (let i = 0; i < 25; i++) {
      expect(() => breaker.acquire()).not.toThrow();
    }
    // A closed circuit does not consume probe budget.
    expect(breaker.getProbesInFlight()).toBe(0);
  });

  it("resets the failure count on success", () => {
    const { breaker } = makeBreaker();

    breaker.recordFailure();
    breaker.recordFailure();
    breaker.recordSuccess();
    expect(breaker.getFailureCount()).toBe(0);

    breaker.recordFailure();
    breaker.recordFailure();

    expect(breaker.getState()).toBe("CLOSED");
    expect(breaker.getFailureCount()).toBe(2);
  });
});

describe("CircuitBreaker — OPEN state", () => {
  it("opens after exactly failureThreshold consecutive failures", () => {
    const { breaker } = makeBreaker();

    openCircuit(breaker, 2);
    expect(breaker.getState()).toBe("CLOSED");

    breaker.recordFailure();

    expect(breaker.getState()).toBe("OPEN");
    expect(breaker.getFailureCount()).toBe(3);
  });

  it("rejects calls immediately with CircuitOpenError (no upstream contact)", () => {
    const { breaker } = makeBreaker();
    openCircuit(breaker);

    expect(() => breaker.acquire()).toThrow(CircuitOpenError);
    expect(() => breaker.assertClosed()).toThrow(CircuitOpenError);
  });

  it("reports the OPEN state on the thrown error", () => {
    const { breaker } = makeBreaker();
    openCircuit(breaker);

    try {
      breaker.acquire();
      throw new Error("expected CircuitOpenError");
    } catch (err) {
      expect(err).toBeInstanceOf(CircuitOpenError);
      expect((err as CircuitOpenError).state).toBe("OPEN");
    }
  });

  it("does not extend the cooldown when further failures arrive while open", () => {
    const { breaker, advance } = makeBreaker();
    openCircuit(breaker);

    advance(30_000);
    breaker.recordFailure(); // in-flight call lands after the circuit opened
    advance(30_000);

    expect(breaker.getState()).toBe("HALF_OPEN");
  });
});

describe("CircuitBreaker — HALF_OPEN state and automatic recovery", () => {
  it("stays OPEN until the cooldown elapses", () => {
    const { breaker, advance } = makeBreaker();
    openCircuit(breaker);

    advance(DEFAULT_COOLDOWN_MS - 1);

    expect(breaker.getState()).toBe("OPEN");
    expect(() => breaker.acquire()).toThrow(CircuitOpenError);
  });

  it("enters HALF_OPEN after cooldownMs", () => {
    const { breaker, advance } = makeBreaker();
    openCircuit(breaker);

    advance(DEFAULT_COOLDOWN_MS);

    expect(breaker.getState()).toBe("HALF_OPEN");
  });

  it("admits exactly probeCount concurrent probes in HALF_OPEN", () => {
    const { breaker, advance } = makeBreaker();
    openCircuit(breaker);
    advance(DEFAULT_COOLDOWN_MS);

    expect(breaker.getProbesInFlight()).toBe(0);
    expect(() => breaker.acquire()).not.toThrow();
    expect(breaker.getProbesInFlight()).toBe(1);
    expect(() => breaker.acquire()).toThrow(CircuitOpenError);

    // Settling the probe frees the slot for the next one.
    breaker.recordSuccess();
    expect(breaker.getState()).toBe("CLOSED");
  });

  it("sheds excess probes in HALF_OPEN with a HALF_OPEN-flavoured error", () => {
    const { breaker, advance } = makeBreaker();
    openCircuit(breaker);
    advance(DEFAULT_COOLDOWN_MS);
    breaker.acquire();

    try {
      breaker.acquire();
      throw new Error("expected CircuitOpenError");
    } catch (err) {
      expect(err).toBeInstanceOf(CircuitOpenError);
      expect((err as CircuitOpenError).state).toBe("HALF_OPEN");
    }
  });

  it("closes the circuit after a single successful probe", () => {
    const { breaker, advance } = makeBreaker();
    openCircuit(breaker);
    advance(DEFAULT_COOLDOWN_MS);
    expect(breaker.getState()).toBe("HALF_OPEN");

    breaker.acquire();
    breaker.recordSuccess();

    expect(breaker.getState()).toBe("CLOSED");
    expect(breaker.getFailureCount()).toBe(0);
  });

  it("reopens the circuit after a single failed probe", () => {
    const { breaker, advance } = makeBreaker();
    openCircuit(breaker);
    advance(DEFAULT_COOLDOWN_MS);
    expect(breaker.getState()).toBe("HALF_OPEN");

    breaker.acquire();
    breaker.recordFailure();

    expect(breaker.getState()).toBe("OPEN");
  });

  it("restarts the cooldown when a probe reopens the circuit", () => {
    const { breaker, advance } = makeBreaker();
    openCircuit(breaker);
    advance(DEFAULT_COOLDOWN_MS);
    breaker.acquire();
    breaker.recordFailure();

    advance(DEFAULT_COOLDOWN_MS - 1);
    expect(breaker.getState()).toBe("OPEN");

    advance(1);
    expect(breaker.getState()).toBe("HALF_OPEN");
  });

  it("recovers automatically over repeated outage/recovery cycles", () => {
    const { breaker, advance } = makeBreaker();

    for (let cycle = 0; cycle < 3; cycle++) {
      openCircuit(breaker);
      expect(breaker.getState()).toBe("OPEN");
      expect(() => breaker.acquire()).toThrow(CircuitOpenError);

      advance(DEFAULT_COOLDOWN_MS);
      expect(breaker.getState()).toBe("HALF_OPEN");

      breaker.acquire();
      breaker.recordSuccess();
      expect(breaker.getState()).toBe("CLOSED");
    }
  });
});

describe("CircuitBreaker — release()", () => {
  it("returns a probe slot without recording an outcome", () => {
    const { breaker, advance } = makeBreaker();
    openCircuit(breaker);
    advance(DEFAULT_COOLDOWN_MS);

    breaker.acquire();
    expect(breaker.getProbesInFlight()).toBe(1);

    breaker.release();

    expect(breaker.getProbesInFlight()).toBe(0);
    expect(breaker.getState()).toBe("HALF_OPEN");
    expect(() => breaker.acquire()).not.toThrow();
  });

  it("never drives the probe counter negative", () => {
    const { breaker } = makeBreaker();

    breaker.release();
    breaker.release();
    breaker.recordSuccess();

    expect(breaker.getProbesInFlight()).toBe(0);
  });
});

describe("CircuitBreaker — metrics", () => {
  it("exposes state, failures, successes and last-success/failure timestamps", () => {
    const { breaker, advance, now } = makeBreaker();

    advance(1_000);
    breaker.recordFailure();
    const failureAt = now();

    advance(2_000);
    breaker.recordSuccess();
    const successAt = now();

    expect(breaker.getMetrics()).toEqual({
      state: "CLOSED",
      failures: 0,
      successes: 1,
      lastFailureAt: failureAt,
      lastSuccessAt: successAt,
    });
  });

  it("reports null timestamps before the first call of each kind", () => {
    const { breaker } = makeBreaker();

    expect(breaker.getMetrics()).toEqual({
      state: "CLOSED",
      failures: 0,
      successes: 0,
      lastFailureAt: null,
      lastSuccessAt: null,
    });
  });

  it("accumulates the success counter across the whole lifetime", () => {
    const { breaker, advance } = makeBreaker();

    breaker.recordSuccess();
    openCircuit(breaker);
    advance(DEFAULT_COOLDOWN_MS);
    breaker.recordSuccess();

    expect(breaker.getMetrics().successes).toBe(2);
  });

  it("reflects the cooldown transition in the reported state", () => {
    const { breaker, advance } = makeBreaker();
    openCircuit(breaker);

    expect(breaker.getMetrics().state).toBe("OPEN");
    advance(DEFAULT_COOLDOWN_MS);
    expect(breaker.getMetrics().state).toBe("HALF_OPEN");
  });
});

describe("CircuitBreaker — transition events", () => {
  it("emits opened / half_opened / closed in order", () => {
    const { breaker, advance } = makeBreaker();
    const events: CircuitTransition[] = [];
    breaker.on("*", (t) => events.push(t));

    openCircuit(breaker);
    advance(DEFAULT_COOLDOWN_MS);
    breaker.getState();
    breaker.acquire();
    breaker.recordSuccess();

    expect(events.map((e) => e.event)).toEqual([
      "opened",
      "half_opened",
      "closed",
    ]);
    expect(events.map((e) => `${e.from}->${e.to}`)).toEqual([
      "CLOSED->OPEN",
      "OPEN->HALF_OPEN",
      "HALF_OPEN->CLOSED",
    ]);
  });

  it("labels the transition reason", () => {
    const { breaker, advance } = makeBreaker();
    const events: CircuitTransition[] = [];
    breaker.on("*", (t) => events.push(t));

    openCircuit(breaker);
    advance(DEFAULT_COOLDOWN_MS);
    breaker.acquire();
    breaker.recordFailure();

    expect(events.map((e) => e.reason)).toEqual([
      "failure_threshold_reached",
      "cooldown_elapsed",
      "probe_failed",
    ]);
  });

  it("delivers events to a single named listener", () => {
    const { breaker } = makeBreaker();
    const opened = jest.fn();
    const closed = jest.fn();
    breaker.on("opened", opened);
    breaker.on("closed", closed);

    openCircuit(breaker);
    expect(opened).toHaveBeenCalledTimes(1);
    expect(closed).not.toHaveBeenCalled();
  });

  it("stops delivering after unsubscribe", () => {
    const { breaker } = makeBreaker();
    const opened = jest.fn();
    const off = breaker.on("opened", opened);

    openCircuit(breaker);
    expect(opened).toHaveBeenCalledTimes(1);

    off();
    breaker.reset();
    openCircuit(breaker);

    expect(opened).toHaveBeenCalledTimes(1);
  });

  it("invokes the onTransition option hook", () => {
    const onTransition = jest.fn();
    let current = 0;
    const breaker = new CircuitBreaker({
      failureThreshold: 1,
      onTransition,
      nowFn: () => current,
      logger: silentLogger,
    });

    breaker.recordFailure();
    current += DEFAULT_COOLDOWN_MS;
    breaker.acquire();
    breaker.recordSuccess();

    expect(onTransition).toHaveBeenCalledTimes(3);
    expect(onTransition.mock.calls[0]?.[0]).toMatchObject({
      event: "opened",
      reason: "failure_threshold_reached",
    });
  });

  it("isolates a throwing listener from the state machine", () => {
    const { breaker } = makeBreaker();
    const after = jest.fn();
    breaker.on("opened", () => {
      throw new Error("listener boom");
    });
    breaker.on("*", after);

    openCircuit(breaker);

    expect(after).toHaveBeenCalledTimes(1);
    expect(breaker.getState()).toBe("OPEN");
  });

  it("does not emit a transition when the state does not change", () => {
    const { breaker } = makeBreaker();
    const onAll = jest.fn();
    breaker.on("*", onAll);

    breaker.recordSuccess();
    breaker.recordSuccess();

    expect(onAll).not.toHaveBeenCalled();
  });
});

describe("CircuitBreaker — reset()", () => {
  it("returns the breaker to a pristine closed state", () => {
    const { breaker } = makeBreaker();
    openCircuit(breaker);
    expect(breaker.getState()).toBe("OPEN");

    breaker.reset();

    expect(breaker.getMetrics()).toEqual({
      state: "CLOSED",
      failures: 0,
      successes: 0,
      lastFailureAt: null,
      lastSuccessAt: null,
    });
  });
});
