import {
  CircuitBreaker,
  CircuitOpenError,
  CircuitBreakerEvent,
  getCircuitBreaker,
  getAllCircuitBreakerStatuses,
  trackCircuitBreaker,
  summarizeCircuitBreakers,
  _resetCircuitBreakerRegistry,
} from './circuitBreaker';

// ── helpers ───────────────────────────────────────────────────────────────────

function makeBreaker(opts: {
  failureThreshold?: number;
  recoveryTimeoutMs?: number;
  now?: number;
  onStateChange?: (e: CircuitBreakerEvent) => void;
}) {
  let now = opts.now ?? 0;
  return {
    breaker: new CircuitBreaker({
      name: 'test',
      failureThreshold: opts.failureThreshold ?? 3,
      recoveryTimeoutMs: opts.recoveryTimeoutMs ?? 60_000,
      nowFn: () => now,
      onStateChange: opts.onStateChange,
    }),
    advanceTime: (ms: number) => { now += ms; },
  };
}

// ── State: CLOSED ─────────────────────────────────────────────────────────────

describe('CircuitBreaker — CLOSED state', () => {
  it('starts CLOSED', () => {
    const { breaker } = makeBreaker({});
    expect(breaker.getState()).toBe('CLOSED');
  });

  it('assertClosed does not throw when CLOSED', () => {
    const { breaker } = makeBreaker({});
    expect(() => breaker.assertClosed()).not.toThrow();
  });

  it('records failures without opening below threshold', () => {
    const { breaker } = makeBreaker({ failureThreshold: 3 });
    breaker.recordFailure();
    breaker.recordFailure();
    expect(breaker.getState()).toBe('CLOSED');
    expect(breaker.getFailureCount()).toBe(2);
  });

  it('opens after reaching failure threshold', () => {
    const { breaker } = makeBreaker({ failureThreshold: 3 });
    breaker.recordFailure();
    breaker.recordFailure();
    breaker.recordFailure();
    expect(breaker.getState()).toBe('OPEN');
  });

  it('resets failure count on success', () => {
    const { breaker } = makeBreaker({});
    breaker.recordFailure();
    breaker.recordFailure();
    breaker.recordSuccess();
    expect(breaker.getState()).toBe('CLOSED');
    expect(breaker.getFailureCount()).toBe(0);
  });
});

// ── State: OPEN ───────────────────────────────────────────────────────────────

describe('CircuitBreaker — OPEN state', () => {
  it('assertClosed throws CircuitOpenError when OPEN', () => {
    const { breaker } = makeBreaker({ failureThreshold: 1 });
    breaker.recordFailure();
    expect(() => breaker.assertClosed()).toThrow(CircuitOpenError);
  });

  it('execute rejects immediately when OPEN', async () => {
    const { breaker } = makeBreaker({ failureThreshold: 1 });
    breaker.recordFailure();
    await expect(breaker.execute(() => Promise.resolve('ok'))).rejects.toBeInstanceOf(CircuitOpenError);
  });

  it('stays OPEN before recovery timeout elapses', () => {
    const { breaker, advanceTime } = makeBreaker({ failureThreshold: 1, recoveryTimeoutMs: 60_000 });
    breaker.recordFailure();
    advanceTime(59_999);
    expect(breaker.getState()).toBe('OPEN');
  });
});

// ── State: HALF_OPEN ──────────────────────────────────────────────────────────

describe('CircuitBreaker — HALF_OPEN state', () => {
  it('transitions OPEN → HALF_OPEN after recovery timeout', () => {
    const { breaker, advanceTime } = makeBreaker({ failureThreshold: 1, recoveryTimeoutMs: 60_000 });
    breaker.recordFailure();
    advanceTime(60_000);
    expect(breaker.getState()).toBe('HALF_OPEN');
  });

  it('transitions HALF_OPEN → CLOSED on success', () => {
    const { breaker, advanceTime } = makeBreaker({ failureThreshold: 1, recoveryTimeoutMs: 60_000 });
    breaker.recordFailure();
    advanceTime(60_000);
    expect(breaker.getState()).toBe('HALF_OPEN');
    breaker.recordSuccess();
    expect(breaker.getState()).toBe('CLOSED');
  });

  it('transitions HALF_OPEN → OPEN on failure', () => {
    const { breaker, advanceTime } = makeBreaker({ failureThreshold: 1, recoveryTimeoutMs: 60_000 });
    breaker.recordFailure();
    advanceTime(60_000);
    expect(breaker.getState()).toBe('HALF_OPEN');
    breaker.recordFailure();
    expect(breaker.getState()).toBe('OPEN');
  });

  it('allows execute through in HALF_OPEN and closes on success', async () => {
    const { breaker, advanceTime } = makeBreaker({ failureThreshold: 1, recoveryTimeoutMs: 60_000 });
    breaker.recordFailure();
    advanceTime(60_000);
    const result = await breaker.execute(() => Promise.resolve('recovered'));
    expect(result).toBe('recovered');
    expect(breaker.getState()).toBe('CLOSED');
  });
});

// ── execute helper ────────────────────────────────────────────────────────────

describe('CircuitBreaker — execute', () => {
  it('returns result of successful fn', async () => {
    const { breaker } = makeBreaker({});
    const result = await breaker.execute(() => Promise.resolve(42));
    expect(result).toBe(42);
  });

  it('rethrows error and records failure', async () => {
    const { breaker } = makeBreaker({ failureThreshold: 3 });
    const err = new Error('upstream down');
    await expect(breaker.execute(() => Promise.reject(err))).rejects.toThrow('upstream down');
    expect(breaker.getFailureCount()).toBe(1);
  });

  it('opens circuit after threshold failures via execute', async () => {
    const { breaker } = makeBreaker({ failureThreshold: 2 });
    const fail = () => Promise.reject(new Error('fail'));
    await expect(breaker.execute(fail)).rejects.toThrow();
    await expect(breaker.execute(fail)).rejects.toThrow();
    expect(breaker.getState()).toBe('OPEN');
  });
});

// ── Events ────────────────────────────────────────────────────────────────────

describe('CircuitBreaker — state change events', () => {
  it('emits CircuitOpened event when transitioning CLOSED → OPEN', () => {
    const events: CircuitBreakerEvent[] = [];
    const { breaker } = makeBreaker({ failureThreshold: 1, onStateChange: (e) => events.push(e) });
    breaker.recordFailure();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ from: 'CLOSED', to: 'OPEN' });
  });

  it('emits CircuitHalfOpened event when transitioning OPEN → HALF_OPEN', () => {
    const events: CircuitBreakerEvent[] = [];
    const { breaker, advanceTime } = makeBreaker({
      failureThreshold: 1,
      recoveryTimeoutMs: 1_000,
      onStateChange: (e) => events.push(e),
    });
    breaker.recordFailure();
    advanceTime(1_000);
    breaker.getState(); // trigger timeout evaluation
    expect(events.some((e) => e.from === 'OPEN' && e.to === 'HALF_OPEN')).toBe(true);
  });

  it('emits CircuitClosed event when transitioning HALF_OPEN → CLOSED', () => {
    const events: CircuitBreakerEvent[] = [];
    const { breaker, advanceTime } = makeBreaker({
      failureThreshold: 1,
      recoveryTimeoutMs: 1_000,
      onStateChange: (e) => events.push(e),
    });
    breaker.recordFailure();
    advanceTime(1_000);
    breaker.getState();
    breaker.recordSuccess();
    expect(events.some((e) => e.from === 'HALF_OPEN' && e.to === 'CLOSED')).toBe(true);
  });
});

// ── getStatus ─────────────────────────────────────────────────────────────────

describe('CircuitBreaker — getStatus', () => {
  it('returns correct status snapshot when CLOSED', () => {
    const { breaker } = makeBreaker({ failureThreshold: 3, recoveryTimeoutMs: 60_000 });
    const status = breaker.getStatus();
    expect(status.state).toBe('CLOSED');
    expect(status.failures).toBe(0);
    expect(status.openedAt).toBeNull();
    expect(status.failureThreshold).toBe(3);
    expect(status.recoveryTimeoutMs).toBe(60_000);
  });

  it('returns openedAt timestamp when OPEN', () => {
    const { breaker } = makeBreaker({ failureThreshold: 1, now: 1000 });
    breaker.recordFailure();
    const status = breaker.getStatus();
    expect(status.state).toBe('OPEN');
    expect(status.openedAt).toBe(1000);
  });
});

// ── Registry ──────────────────────────────────────────────────────────────────

describe('Circuit breaker registry', () => {
  beforeEach(() => _resetCircuitBreakerRegistry());

  it('getCircuitBreaker returns same instance for same name', () => {
    const a = getCircuitBreaker({ name: 'svc-a' });
    const b = getCircuitBreaker({ name: 'svc-a' });
    expect(a).toBe(b);
  });

  it('getCircuitBreaker returns different instances for different names', () => {
    const a = getCircuitBreaker({ name: 'svc-a' });
    const b = getCircuitBreaker({ name: 'svc-b' });
    expect(a).not.toBe(b);
  });

  it('getAllCircuitBreakerStatuses returns statuses for all registered breakers', () => {
    getCircuitBreaker({ name: 'venice' });
    getCircuitBreaker({ name: 'horizon' });
    const statuses = getAllCircuitBreakerStatuses();
    expect(statuses.map((s: { name: string }) => s.name)).toEqual(expect.arrayContaining(['venice', 'horizon']));
  });
});

// ── Success/failure timestamps ────────────────────────────────────────────────

describe('CircuitBreaker — last success/failure timestamps', () => {
  it('starts with no recorded success or failure', () => {
    const { breaker } = makeBreaker({});
    expect(breaker.getStatus().lastSuccessAt).toBeNull();
    expect(breaker.getStatus().lastFailureAt).toBeNull();
  });

  it('records the time of the latest success and failure', () => {
    const { breaker, advanceTime } = makeBreaker({ now: 1_000 });
    breaker.recordSuccess();
    advanceTime(500);
    breaker.recordFailure();
    const status = breaker.getStatus();
    expect(status.lastSuccessAt).toBe(1_000);
    expect(status.lastFailureAt).toBe(1_500);
  });
});

// ── Tracked breakers / summaries ──────────────────────────────────────────────

describe('summarizeCircuitBreakers', () => {
  beforeEach(() => _resetCircuitBreakerRegistry());

  it('returns null when no breaker has that name', () => {
    expect(summarizeCircuitBreakers('venice')).toBeNull();
  });

  it('aggregates tracked instances: worst state, max failures, latest timestamps', () => {
    let now = 1_000;
    const nowFn = () => now;
    const healthy = new CircuitBreaker({ name: 'venice', failureThreshold: 1, nowFn });
    const broken = new CircuitBreaker({ name: 'venice', failureThreshold: 1, nowFn });
    trackCircuitBreaker(healthy);
    trackCircuitBreaker(broken);

    broken.recordFailure();
    now = 2_000;
    healthy.recordSuccess();

    const summary = summarizeCircuitBreakers('venice');
    expect(summary).toMatchObject({
      name: 'venice',
      state: 'OPEN',
      instances: 2,
      openInstances: 1,
      failures: 1,
      lastSuccessAt: 2_000,
      lastFailureAt: 1_000,
    });
  });

  it('includes the registry breaker of the same name', () => {
    const registered = getCircuitBreaker({ name: 'stellar-horizon', failureThreshold: 1 });
    registered.recordFailure();
    expect(summarizeCircuitBreakers('stellar-horizon')?.state).toBe('OPEN');
  });

  it('stops reporting a breaker once untracked', () => {
    const breaker = new CircuitBreaker({ name: 'venice' });
    const untrack = trackCircuitBreaker(breaker);
    expect(summarizeCircuitBreakers('venice')?.instances).toBe(1);
    untrack();
    expect(summarizeCircuitBreakers('venice')).toBeNull();
  });
});

// ── Configurable thresholds ───────────────────────────────────────────────────

describe('CircuitBreaker — configurable thresholds', () => {
  it('respects custom failureThreshold of 5', () => {
    const { breaker } = makeBreaker({ failureThreshold: 5 });
    for (let i = 0; i < 4; i++) breaker.recordFailure();
    expect(breaker.getState()).toBe('CLOSED');
    breaker.recordFailure();
    expect(breaker.getState()).toBe('OPEN');
  });

  it('respects custom recoveryTimeoutMs of 10s', () => {
    const { breaker, advanceTime } = makeBreaker({ failureThreshold: 1, recoveryTimeoutMs: 10_000 });
    breaker.recordFailure();
    advanceTime(9_999);
    expect(breaker.getState()).toBe('OPEN');
    advanceTime(1);
    expect(breaker.getState()).toBe('HALF_OPEN');
  });
});
