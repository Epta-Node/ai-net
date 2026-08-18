import { CircuitBreaker } from '../../src/venice/circuitBreaker';
import { CircuitOpenError } from '../../src/venice/errors';

describe('CircuitBreaker', () => {
  let now: number;
  let breaker: CircuitBreaker;

  beforeEach(() => {
    now = 1000000;
    breaker = new CircuitBreaker(() => now);
  });

  it('starts in CLOSED state', () => {
    expect(breaker.getState()).toBe('CLOSED');
    expect(breaker.getFailureCount()).toBe(0);
  });

  it('stays CLOSED after fewer than 3 failures', () => {
    breaker.recordFailure();
    breaker.recordFailure();
    expect(breaker.getState()).toBe('CLOSED');
    expect(breaker.getFailureCount()).toBe(2);
  });

  it('opens after exactly 3 consecutive failures', () => {
    breaker.recordFailure();
    breaker.recordFailure();
    breaker.recordFailure();
    expect(breaker.getState()).toBe('OPEN');
    expect(breaker.getFailureCount()).toBe(3);
  });

  it('rejects immediately with CircuitOpenError when OPEN', () => {
    breaker.recordFailure();
    breaker.recordFailure();
    breaker.recordFailure();

    expect(() => breaker.assertClosed()).toThrow(CircuitOpenError);
  });

  it('transitions to HALF_OPEN after 60 seconds', () => {
    breaker.recordFailure();
    breaker.recordFailure();
    breaker.recordFailure();
    expect(breaker.getState()).toBe('OPEN');

    now += 60_000;
    expect(breaker.getState()).toBe('HALF_OPEN');
  });

  it('stays OPEN before 60 seconds', () => {
    breaker.recordFailure();
    breaker.recordFailure();
    breaker.recordFailure();

    now += 59_999;
    expect(breaker.getState()).toBe('OPEN');
  });

  it('re-closes on successful probe in HALF_OPEN', () => {
    breaker.recordFailure();
    breaker.recordFailure();
    breaker.recordFailure();

    now += 60_000;
    expect(breaker.getState()).toBe('HALF_OPEN');

    breaker.recordSuccess();
    expect(breaker.getState()).toBe('CLOSED');
    expect(breaker.getFailureCount()).toBe(0);
  });

  it('returns to OPEN on failed probe in HALF_OPEN', () => {
    breaker.recordFailure();
    breaker.recordFailure();
    breaker.recordFailure();

    now += 60_000;
    expect(breaker.getState()).toBe('HALF_OPEN');

    breaker.recordFailure();
    expect(breaker.getState()).toBe('OPEN');
  });

  it('resets failure count on success', () => {
    breaker.recordFailure();
    breaker.recordFailure();
    breaker.recordSuccess();
    expect(breaker.getFailureCount()).toBe(0);
    expect(breaker.getState()).toBe('CLOSED');

    breaker.recordFailure();
    breaker.recordFailure();
    expect(breaker.getState()).toBe('CLOSED');
  });

  it('allows requests through in HALF_OPEN (assertClosed does not throw)', () => {
    breaker.recordFailure();
    breaker.recordFailure();
    breaker.recordFailure();

    now += 60_000;
    expect(() => breaker.assertClosed()).not.toThrow();
  });
});
