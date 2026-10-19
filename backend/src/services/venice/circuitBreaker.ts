/**
 * Three-state circuit breaker for outbound Venice AI calls.
 *
 * State machine
 * ─────────────
 * ```
 *                 failureThreshold consecutive failures
 *   ┌────────┐  ───────────────────────────────────────▶  ┌──────┐
 *   │ CLOSED │                                           │ OPEN │
 *   └────────┘  ◀───────────────────────────────────────  └──────┘
 *        ▲          success in HALF_OPEN (or in CLOSED)          │
 *        │                                                      │ cooldownMs elapsed
 *        │           probe failed                                ▼
 *        └────────────────────────────────────────────────  ┌───────────┐
 *                          (re-open, restart cooldown)        │ HALF_OPEN │
 *                                                            └───────────┘
 *                                                            probeCount probes
 *                                                            admitted at a time
 * ```
 *
 * • `CLOSED`   — normal operation. Every call is admitted and a success resets
 *                the consecutive-failure counter to zero.
 * • `OPEN`     — every call is rejected immediately with {@link CircuitOpenError}
 *                so a struggling upstream is never hit with more traffic. A
 *                cooldown timer starts the moment the circuit opens.
 * • `HALF_OPEN`— reached lazily once `cooldownMs` has elapsed. A bounded number
 *                of concurrent *probes* (`probeCount`) is admitted; anything
 *                beyond that is rejected. A single successful probe closes the
 *                circuit, a single failed probe re-opens it and restarts the
 *                cooldown.
 *
 * Design notes
 * ────────────
 * • The `OPEN → HALF_OPEN` transition is **lazy**: it is evaluated on the next
 *   `getState()` / `acquire()` call rather than by a timer. That keeps the
 *   breaker free of dangling handles (nothing to `unref`, nothing to leak in
 *   tests) while still honouring the cooldown exactly.
 * • `HALF_OPEN` is a *reservation* model, not a flag: `acquire()` takes one of
 *   the `probeCount` slots and the caller must settle it with `recordSuccess()`,
 *   `recordFailure()` or `release()`. The counter is floored at zero, so an
 *   extra `release()` can never drive it negative.
 * • Every state change emits a typed transition event (`opened`, `closed`,
 *   `half_opened`) to listeners registered with {@link CircuitBreaker.on} and to
 *   the optional `onTransition` callback supplied in the options bag.
 */

import { createLogger } from '../../utils/logger.js';
import { CircuitOpenError } from './errors.js';

export { CircuitOpenError } from './errors.js';

const log = createLogger({ module: 'VeniceCircuitBreaker' });

/** The three states of the breaker. */
export type CircuitState = 'CLOSED' | 'OPEN' | 'HALF_OPEN';

/** Event names emitted on a state transition. */
export type CircuitEventName = 'opened' | 'closed' | 'half_opened';

/** Default number of consecutive failures before the circuit opens. */
export const DEFAULT_FAILURE_THRESHOLD = 3;

/** Default time the circuit stays `OPEN` before probing again. */
export const DEFAULT_COOLDOWN_MS = 60_000;

/** Default number of concurrent probes admitted while `HALF_OPEN`. */
export const DEFAULT_PROBE_COUNT = 1;

/** A single state transition, delivered to every registered listener. */
export interface CircuitTransition {
  /** Event name for this transition. */
  event: CircuitEventName;
  /** State the breaker left. */
  from: CircuitState;
  /** State the breaker entered. */
  to: CircuitState;
  /** Epoch milliseconds at which the transition happened. */
  at: number;
  /** Consecutive-failure counter at transition time. */
  failures: number;
  /** Total successes observed since construction. */
  successes: number;
  /** Human-readable cause, e.g. `failure_threshold_reached`. */
  reason: string;
}

/** Observability snapshot exposed by {@link CircuitBreaker.getMetrics}. */
export interface CircuitMetrics {
  state: CircuitState;
  /** Consecutive failures since the last success. */
  failures: number;
  /** Total successes since construction. */
  successes: number;
  /** Epoch ms of the most recent failure, or `null` when there has been none. */
  lastFailureAt: number | null;
  /** Epoch ms of the most recent success, or `null` when there has been none. */
  lastSuccessAt: number | null;
}

/** Why the breaker changed state. */
export type CircuitTransitionReason =
  | 'failure_threshold_reached'
  | 'failure_while_open'
  | 'probe_failed'
  | 'probe_succeeded'
  | 'cooldown_elapsed'
  | 'manual_reset';

export interface CircuitBreakerOptions {
  /**
   * Service name surfaced to the shared health-check registry. Default:
   * `venice`.
   */
  name?: string;
  /** Consecutive failures required to open the circuit. Default: 3. */
  failureThreshold?: number;
  /** How long the circuit stays `OPEN` before admitting probes. Default: 60_000. */
  cooldownMs?: number;
  /** Concurrent probes admitted while `HALF_OPEN`. Default: 1. */
  probeCount?: number;
  /** Injectable clock (epoch ms) — used by tests to drive the cooldown. */
  nowFn?: () => number;
  /** Single-shot transition hook, invoked in addition to {@link CircuitBreaker.on}. */
  onTransition?: (transition: CircuitTransition) => void;
  /** Logger override; defaults to the module logger. */
  logger?: Pick<typeof log, 'info' | 'warn' | 'error'>;
}

/** Maps a destination state onto the event name emitted when entering it. */
const EVENT_FOR_STATE: Record<CircuitState, CircuitEventName> = {
  CLOSED: 'closed',
  OPEN: 'opened',
  HALF_OPEN: 'half_opened',
};

function positiveInt(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value) || value < 1) return fallback;
  return Math.floor(value);
}

export class CircuitBreaker {
  /** Service name, shared with the health-check registry. */
  readonly name: string;
  private state: CircuitState = 'CLOSED';
  private failures = 0;
  private successes = 0;
  private lastFailureAt: number | null = null;
  private lastSuccessAt: number | null = null;
  private openedAt = 0;
  /** Reserved `HALF_OPEN` probe slots that have not been settled yet. */
  private probesInFlight = 0;

  private readonly failureThreshold: number;
  private readonly cooldownMs: number;
  private readonly probeCount: number;
  private readonly nowFn: () => number;
  private readonly logger: Pick<typeof log, 'info' | 'warn' | 'error'>;
  private readonly onTransition?: (transition: CircuitTransition) => void;
  private readonly listeners = new Map<
    CircuitEventName | '*',
    Set<(t: CircuitTransition) => void>
  >();

  constructor(options: CircuitBreakerOptions | (() => number) = {}) {
    // Backwards compatibility: `new CircuitBreaker(nowFn)` — the original
    // single-argument clock signature. Prefer the options bag.
    const opts: CircuitBreakerOptions =
      typeof options === 'function' ? { nowFn: options } : options;

    this.name = opts.name ?? 'venice';
    this.failureThreshold = positiveInt(opts.failureThreshold, DEFAULT_FAILURE_THRESHOLD);
    this.cooldownMs = positiveInt(opts.cooldownMs, DEFAULT_COOLDOWN_MS);
    this.probeCount = positiveInt(opts.probeCount, DEFAULT_PROBE_COUNT);
    this.nowFn = opts.nowFn ?? (() => Date.now());
    this.logger = opts.logger ?? log;
    if (opts.onTransition) this.onTransition = opts.onTransition;
  }

  // ── Introspection ─────────────────────────────────────────────────────────

  /** Current state, applying the lazy `OPEN → HALF_OPEN` cooldown first. */
  getState(): CircuitState {
    this.evaluateCooldown();
    return this.state;
  }

  /** Consecutive failures since the last success. */
  getFailureCount(): number {
    return this.failures;
  }

  /** Effective configuration — useful for dashboards and assertions. */
  getConfig(): { failureThreshold: number; cooldownMs: number; probeCount: number } {
    return {
      failureThreshold: this.failureThreshold,
      cooldownMs: this.cooldownMs,
      probeCount: this.probeCount,
    };
  }

  /**
   * Observability snapshot (issue #495): state, consecutive failures, total
   * successes and the timestamps of the last failure / success.
   */
  getMetrics(): CircuitMetrics {
    return {
      state: this.getState(),
      failures: this.failures,
      successes: this.successes,
      lastFailureAt: this.lastFailureAt,
      lastSuccessAt: this.lastSuccessAt,
    };
  }

  /** Probe slots currently reserved by admitted `HALF_OPEN` calls. */
  getProbesInFlight(): number {
    return this.probesInFlight;
  }

  /**
   * Serialisable status snapshot in the shared registry's shape, so
   * `/health/deep` can aggregate this breaker alongside registry instances.
   */
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
    this.evaluateCooldown();
    return {
      name: this.name,
      state: this.state,
      failures: this.failures,
      failureThreshold: this.failureThreshold,
      recoveryTimeoutMs: this.cooldownMs,
      openedAt: this.state !== 'CLOSED' ? this.openedAt : null,
      lastSuccessAt: this.lastSuccessAt,
      lastFailureAt: this.lastFailureAt,
    };
  }

  // ── Call path ─────────────────────────────────────────────────────────────

  /**
   * Admit a call, or throw {@link CircuitOpenError}.
   *
   * * `CLOSED`    → admitted, no probe slot is taken.
   * * `HALF_OPEN` → one of the `probeCount` slots is reserved; the caller **must**
   *   settle it with {@link recordSuccess}, {@link recordFailure} or
   *   {@link release}.
   * * `OPEN`      → rejected without touching the network.
   */
  acquire(): void {
    this.evaluateCooldown();
    if (this.state === 'OPEN') {
      throw new CircuitOpenError();
    }
    if (this.state === 'HALF_OPEN') {
      if (this.probesInFlight >= this.probeCount) {
        throw new CircuitOpenError(
          'Circuit breaker is HALF_OPEN — probe budget exhausted, Venice requests are blocked',
          'HALF_OPEN',
        );
      }
      this.probesInFlight += 1;
    }
  }

  /**
   * Alias of {@link acquire}, kept for backwards compatibility with the original
   * single-argument API. Prefer {@link acquire} — it is the same check, named for
   * what it does (reserve a probe slot, or reject).
   */
  assertClosed(): void {
    this.acquire();
  }

  /**
   * Record a successful call.
   *
   * Resets the consecutive-failure counter. When the call was a `HALF_OPEN`
   * probe, the circuit closes.
   */
  recordSuccess(): void {
    const now = this.nowFn();
    this.lastSuccessAt = now;
    this.successes += 1;
    this.probesInFlight = Math.max(0, this.probesInFlight - 1);
    if (this.state !== 'CLOSED') {
      this.transition('CLOSED', 'probe_succeeded');
    }
    this.failures = 0;
  }

  /**
   * Record a failed call.
   *
   * A failure in `HALF_OPEN` re-opens the circuit and restarts the cooldown. In
   * `CLOSED` the consecutive counter grows and the circuit opens once it
   * reaches `failureThreshold`.
   */
  recordFailure(): void {
    const now = this.nowFn();
    this.lastFailureAt = now;
    this.failures += 1;
    this.probesInFlight = Math.max(0, this.probesInFlight - 1);

    if (this.state === 'HALF_OPEN') {
      this.transition('OPEN', 'probe_failed');
      return;
    }
    if (this.failures >= this.failureThreshold) {
      this.transition(
        'OPEN',
        this.state === 'OPEN' ? 'failure_while_open' : 'failure_threshold_reached',
      );
    }
  }

  /**
   * Release a reserved `HALF_OPEN` probe slot without recording an outcome.
   *
   * Used when an admitted call never reached the network (e.g. it was served
   * from the response cache) so the probe budget is not leaked. The counter is
   * floored at zero, so a redundant release is harmless.
   */
  release(): void {
    this.probesInFlight = Math.max(0, this.probesInFlight - 1);
  }

  /** Return the breaker to a pristine `CLOSED` state (test/ops helper). */
  reset(): void {
    this.failures = 0;
    this.successes = 0;
    this.probesInFlight = 0;
    this.openedAt = 0;
    this.lastFailureAt = null;
    this.lastSuccessAt = null;
    this.transition('CLOSED', 'manual_reset');
  }

  // ── Events ────────────────────────────────────────────────────────────────

  /**
   * Subscribe to a state transition. Pass `'*'` to receive every transition.
   *
   * @returns an unsubscribe function.
   */
  on(event: CircuitEventName | '*', handler: (transition: CircuitTransition) => void): () => void {
    let handlers = this.listeners.get(event);
    if (!handlers) {
      handlers = new Set();
      this.listeners.set(event, handlers);
    }
    handlers.add(handler);
    return () => handlers.delete(handler);
  }

  // ── Internals ─────────────────────────────────────────────────────────────

  /** Lazily promote `OPEN → HALF_OPEN` once the cooldown has elapsed. */
  private evaluateCooldown(): void {
    if (this.state !== 'OPEN') return;
    if (this.nowFn() - this.openedAt >= this.cooldownMs) {
      this.transition('HALF_OPEN', 'cooldown_elapsed');
    }
  }

  private transition(to: CircuitState, reason: CircuitTransitionReason): void {
    const from = this.state;
    if (from === to) return;

    this.state = to;
    if (to === 'OPEN') {
      // Stamp the cooldown start. Re-opening from HALF_OPEN therefore restarts
      // the timer; a failure while already OPEN keeps the original timestamp so
      // a stuck upstream cannot hold the circuit open indefinitely.
      this.openedAt = this.nowFn();
      this.probesInFlight = 0;
    } else {
      // Entering HALF_OPEN clears the reservations, and entering CLOSED
      // clears the failure counter.
      this.probesInFlight = 0;
      if (to === 'CLOSED') this.failures = 0;
    }

    const transition: CircuitTransition = {
      event: EVENT_FOR_STATE[to],
      from,
      to,
      at: this.nowFn(),
      failures: this.failures,
      successes: this.successes,
      reason,
    };

    if (to === 'OPEN') {
      this.logger.warn({ ...transition, cooldownMs: this.cooldownMs }, 'venice circuit opened');
    } else {
      this.logger.info(transition, `venice circuit ${transition.event}`);
    }

    try {
      this.onTransition?.(transition);
    } catch (err) {
      this.logger.error({ err }, 'venice circuit onTransition listener threw');
    }

    for (const handler of this.listeners.get(transition.event) ?? []) {
      try {
        handler(transition);
      } catch (err) {
        this.logger.error({ err }, 'venice circuit listener threw');
      }
    }
    for (const handler of this.listeners.get('*') ?? []) {
      try {
        handler(transition);
      } catch (err) {
        this.logger.error({ err }, 'venice circuit listener threw');
      }
    }
  }
}
