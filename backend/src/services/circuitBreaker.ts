/**
 * Generic circuit breaker for external service calls.
 *
 * States:
 *   CLOSED    — normal operation, requests pass through.
 *   OPEN      — service is failing, requests are blocked immediately.
 *   HALF_OPEN — recovery probe: one request is allowed through to test
 *               whether the service has recovered.
 *
 * Transitions:
 *   CLOSED → OPEN      after `failureThreshold` consecutive failures.
 *   OPEN   → HALF_OPEN after `recoveryTimeoutMs` has elapsed.
 *   HALF_OPEN → CLOSED on the next successful call.
 *   HALF_OPEN → OPEN   on the next failed call (resets the timeout).
 */

export type CircuitState = 'CLOSED' | 'OPEN' | 'HALF_OPEN';

export interface CircuitBreakerOptions {
  /** Service name — used in event payloads and error messages. */
  name: string;
  /** Consecutive failures before the circuit opens (default: 3). */
  failureThreshold?: number;
  /** Milliseconds to wait before probing for recovery (default: 60 000). */
  recoveryTimeoutMs?: number;
  /** Injectable clock — useful for deterministic tests. */
  nowFn?: () => number;
  /** Optional event listener invoked on state transitions. */
  onStateChange?: (event: CircuitBreakerEvent) => void;
}

export interface CircuitBreakerEvent {
  name: string;
  from: CircuitState;
  to: CircuitState;
  timestamp: number;
}

export class CircuitOpenError extends Error {
  /**
   * Which shed state rejected the call. The Venice reservation path throws
   * `HALF_OPEN` when the probe budget is exhausted so callers can tell the
   * difference from a hard-open circuit.
   */
  readonly state: 'OPEN' | 'HALF_OPEN';
  constructor(
    message = 'Circuit breaker is OPEN',
    state: 'OPEN' | 'HALF_OPEN' = 'OPEN',
  ) {
    super(message);
    this.name = 'CircuitOpenError';
    this.state = state;
  }
}

export class CircuitBreaker {
  readonly name: string;
  private state: CircuitState = 'CLOSED';
  private failures = 0;
  private openedAt = 0;
  private lastSuccessAt: number | null = null;
  private lastFailureAt: number | null = null;
  private readonly failureThreshold: number;
  private readonly recoveryTimeoutMs: number;
  private readonly nowFn: () => number;
  private readonly onStateChange?: (event: CircuitBreakerEvent) => void;

  constructor(options: CircuitBreakerOptions) {
    this.name = options.name;
    this.failureThreshold = options.failureThreshold ?? 3;
    this.recoveryTimeoutMs = options.recoveryTimeoutMs ?? 60_000;
    this.nowFn = options.nowFn ?? (() => Date.now());
    this.onStateChange = options.onStateChange;
  }

  /** Current state, accounting for elapsed recovery timeout. */
  getState(): CircuitState {
    this.evaluateTimeout();
    return this.state;
  }

  getFailureCount(): number {
    return this.failures;
  }

  /**
   * Throws `CircuitOpenError` when the circuit is OPEN.
   * Call this before attempting a request.
   */
  assertClosed(): void {
    this.evaluateTimeout();
    if (this.state === 'OPEN') {
      throw new CircuitOpenError(`Circuit breaker OPEN for service: ${this.name}`);
    }
  }

  /**
   * Execute `fn` through the circuit breaker.
   * Automatically records success/failure and returns the result.
   */
  async execute<T>(fn: () => Promise<T>): Promise<T> {
    this.assertClosed();
    try {
      const result = await fn();
      this.recordSuccess();
      return result;
    } catch (err) {
      this.recordFailure();
      throw err;
    }
  }

  recordSuccess(): void {
    const prev = this.state;
    this.failures = 0;
    this.lastSuccessAt = this.nowFn();
    this.state = 'CLOSED';
    if (prev !== 'CLOSED') {
      this.emit(prev, 'CLOSED');
    }
  }

  recordFailure(): void {
    this.failures++;
    this.lastFailureAt = this.nowFn();
    if (this.failures >= this.failureThreshold) {
      const prev = this.state;
      this.state = 'OPEN';
      this.openedAt = this.nowFn();
      if (prev !== 'OPEN') {
        this.emit(prev, 'OPEN');
      }
    }
  }

  /** Serialisable status snapshot for health endpoints. */
  getStatus(): {
    name: string;
    state: CircuitState;
    failures: number;
    failureThreshold: number;
    recoveryTimeoutMs: number;
    openedAt: number | null;
    lastSuccessAt: number | null;
    lastFailureAt: number | null;
  } {
    this.evaluateTimeout();
    return {
      name: this.name,
      state: this.state,
      failures: this.failures,
      failureThreshold: this.failureThreshold,
      recoveryTimeoutMs: this.recoveryTimeoutMs,
      openedAt: this.state !== 'CLOSED' ? this.openedAt : null,
      lastSuccessAt: this.lastSuccessAt,
      lastFailureAt: this.lastFailureAt,
    };
  }

  // ── private ──────────────────────────────────────────────────────────────

  private evaluateTimeout(): void {
    if (this.state === 'OPEN') {
      const elapsed = this.nowFn() - this.openedAt;
      if (elapsed >= this.recoveryTimeoutMs) {
        this.transition('OPEN', 'HALF_OPEN');
      }
    }
  }

  private transition(from: CircuitState, to: CircuitState): void {
    this.state = to;
    this.emit(from, to);
  }

  private emit(from: CircuitState, to: CircuitState): void {
    this.onStateChange?.({ name: this.name, from, to, timestamp: this.nowFn() });
  }
}

// ── Registry — singleton map of named breakers ────────────────────────────────

const registry = new Map<string, CircuitBreaker>();

/**
 * Get or create a named circuit breaker.
 * Options are only applied on first creation; subsequent calls return the
 * cached instance.
 */
export function getCircuitBreaker(options: CircuitBreakerOptions): CircuitBreaker {
  const existing = registry.get(options.name);
  if (existing) return existing;
  const breaker = new CircuitBreaker(options);
  registry.set(options.name, breaker);
  return breaker;
}

/** Return status snapshots for all registered circuit breakers. */
export function getAllCircuitBreakerStatuses(): ReturnType<CircuitBreaker['getStatus']>[] {
  return Array.from(registry.values()).map((b) => b.getStatus());
}

// ── Tracked breakers — instances owned by their callers ──────────────────────

/**
 * Public surface a caller-owned breaker must expose to be aggregated by
 * health checks. Declared structurally (no private fields) so richer
 * implementations — such as the Venice reservation-model breaker, which keeps
 * probe slots and transition listeners — can be tracked alongside registry
 * instances without subclassing.
 */
export interface TrackableCircuitBreaker {
  readonly name: string;
  getState(): CircuitState;
  getStatus(): ReturnType<CircuitBreaker['getStatus']>;
}

/**
 * Breakers constructed directly (e.g. one per `VeniceClient`) rather than via
 * the named registry. Several instances may share a name, so health checks
 * aggregate them with {@link summarizeCircuitBreakers}.
 */
const tracked = new Set<TrackableCircuitBreaker>();

/**
 * Make a caller-owned breaker visible to health checks.
 * Returns an unsubscribe function; call it when the owner is disposed.
 */
export function trackCircuitBreaker(breaker: TrackableCircuitBreaker): () => void {
  tracked.add(breaker);
  return () => {
    tracked.delete(breaker);
  };
}

export type CircuitBreakerStatus = ReturnType<CircuitBreaker['getStatus']>;

export interface CircuitBreakerSummary {
  name: string;
  /** Worst state across instances: OPEN > HALF_OPEN > CLOSED. */
  state: CircuitState;
  /** Instances sharing this name (registered and tracked). */
  instances: number;
  /** Instances currently OPEN. */
  openInstances: number;
  /** Highest consecutive-failure count of any instance. */
  failures: number;
  /** Most recent success across instances (epoch ms), or null if none yet. */
  lastSuccessAt: number | null;
  /** Most recent failure across instances (epoch ms), or null if none yet. */
  lastFailureAt: number | null;
}

const STATE_SEVERITY: Record<CircuitState, number> = { CLOSED: 0, HALF_OPEN: 1, OPEN: 2 };

function maxNullable(a: number | null, b: number | null): number | null {
  if (a === null) return b;
  if (b === null) return a;
  return Math.max(a, b);
}

/**
 * Aggregate every registered or tracked breaker named `name` into a single
 * status. Returns null when no breaker with that name exists yet (e.g. the
 * owning client has not been constructed).
 */
export function summarizeCircuitBreakers(name: string): CircuitBreakerSummary | null {
  const instances = new Set<TrackableCircuitBreaker>();
  const registered = registry.get(name);
  if (registered) instances.add(registered);
  for (const breaker of tracked) {
    if (breaker.name === name) instances.add(breaker);
  }
  if (instances.size === 0) return null;

  const summary: CircuitBreakerSummary = {
    name,
    state: 'CLOSED',
    instances: instances.size,
    openInstances: 0,
    failures: 0,
    lastSuccessAt: null,
    lastFailureAt: null,
  };
  for (const breaker of instances) {
    const status = breaker.getStatus();
    if (STATE_SEVERITY[status.state] > STATE_SEVERITY[summary.state]) summary.state = status.state;
    if (status.state === 'OPEN') summary.openInstances++;
    summary.failures = Math.max(summary.failures, status.failures);
    summary.lastSuccessAt = maxNullable(summary.lastSuccessAt, status.lastSuccessAt);
    summary.lastFailureAt = maxNullable(summary.lastFailureAt, status.lastFailureAt);
  }
  return summary;
}

/** Remove all registered and tracked breakers — intended for tests only. */
export function _resetCircuitBreakerRegistry(): void {
  registry.clear();
  tracked.clear();
}
