import {
  backoffCeilingMs,
  computeBackoffDelayMs,
  getQueueRetryMetrics,
  recordJobDeadLetter,
  recordJobRetry,
  recordRetryLag,
  resetQueueRetryMetrics,
} from "./backoff";

describe("full-jitter backoff (#752)", () => {
  const base = 1000;
  const cap = 30_000;

  it("grows the delay window exponentially up to the cap", () => {
    expect(backoffCeilingMs(1, base, cap)).toBe(1000);
    expect(backoffCeilingMs(2, base, cap)).toBe(2000);
    expect(backoffCeilingMs(3, base, cap)).toBe(4000);
    expect(backoffCeilingMs(10, base, cap)).toBe(cap);
  });

  it("never decreases the window as attempts increase", () => {
    let previous = 0;
    for (let attempt = 1; attempt <= 20; attempt++) {
      const ceiling = backoffCeilingMs(attempt, base, cap);
      expect(ceiling).toBeGreaterThanOrEqual(previous);
      previous = ceiling;
    }
  });

  it("draws the delay between 0 and the window for any random value", () => {
    for (let attempt = 1; attempt <= 8; attempt++) {
      const ceiling = backoffCeilingMs(attempt, base, cap);
      expect(computeBackoffDelayMs(attempt, base, cap, () => 0)).toBe(0);
      expect(computeBackoffDelayMs(attempt, base, cap, () => 0.999999)).toBeLessThan(ceiling);
      expect(computeBackoffDelayMs(attempt, base, cap, () => 0.5)).toBe(Math.floor(ceiling / 2));
    }
  });

  it("spreads retries across the window instead of retrying in lockstep", () => {
    const delays = new Set<number>();
    for (let i = 0; i < 200; i++) {
      delays.add(computeBackoffDelayMs(4, base, cap));
    }
    expect(delays.size).toBeGreaterThan(50);
    for (const delay of delays) {
      expect(delay).toBeGreaterThanOrEqual(0);
      expect(delay).toBeLessThan(8000);
    }
  });

  it("tracks retries, dead-letter moves and retry lag", () => {
    resetQueueRetryMetrics();
    recordJobRetry();
    recordJobRetry();
    recordJobDeadLetter();
    recordRetryLag(40);
    recordRetryLag(-5);
    expect(getQueueRetryMetrics()).toEqual({
      retriesTotal: 2,
      deadLetterTotal: 1,
      retryLagMsSum: 40,
      retryLagCount: 2,
    });
    resetQueueRetryMetrics();
  });
});
