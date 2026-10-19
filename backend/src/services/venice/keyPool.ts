/**
 * Health-tracked pool of Venice API keys (issue #806).
 *
 * One exhausted or revoked key used to take every agent task down with it. The
 * pool keeps a sliding window of recent outcomes per key. A key whose error
 * rate over that window crosses the threshold is put into cooldown and skipped
 * until the cooldown expires, so traffic moves to the healthy keys. The window
 * is cleared on cooldown, so a key that recovers starts again from a clean
 * record.
 *
 * Keys are identified internally by value but only ever exposed as a four
 * character suffix, so status output and logs cannot leak a credential.
 */

import { VeniceUnavailableError } from './errors.js';

/** Outcomes kept per key. */
export const KEY_POOL_WINDOW_SIZE = 100;
/**
 * Outcomes required before a key's error rate can trigger cooldown. Without a
 * floor, the first failure on a fresh key would read as a 100% error rate.
 */
export const KEY_POOL_MIN_SAMPLES = 10;
/** Most `VENICE_API_KEY_<n>` variables read from the environment. */
export const MAX_NUMBERED_VENICE_KEYS = 10;

export interface VeniceKeyPoolOptions {
  /** How long a key stays out of rotation once tripped. */
  cooldownMs: number;
  /** Error rate (0..1) over the window that trips a cooldown. */
  errorRateThreshold: number;
  /** Clock override for tests. */
  now?: () => number;
}

/** Operator-safe view of one key. The full value is never included. */
export interface KeyPoolStatus {
  keyFragment: string;
  healthy: boolean;
  errorRate: number;
  requestCount: number;
  coolingDownUntil: string | null;
}

interface KeyState {
  key: string;
  /** Most recent outcomes, `true` for success. Oldest first. */
  window: boolean[];
  requestCount: number;
  /** Epoch ms until which the key is skipped. 0 when healthy. */
  cooldownUntil: number;
}

/** Last four characters only, so a status line identifies a key without exposing it. */
export function keyFragmentOf(key: string): string {
  return `...${key.slice(-4)}`;
}

/**
 * Read `VENICE_API_KEY_1` .. `VENICE_API_KEY_10` from the environment, in order,
 * skipping unset or blank entries.
 */
export function loadNumberedVeniceKeys(env: NodeJS.ProcessEnv = process.env): string[] {
  const keys: string[] = [];
  for (let index = 1; index <= MAX_NUMBERED_VENICE_KEYS; index += 1) {
    const value = env[`VENICE_API_KEY_${index}`]?.trim();
    if (value) keys.push(value);
  }
  return keys;
}

export class VeniceKeyPool {
  private readonly states = new Map<string, KeyState>();
  private readonly cooldownMs: number;
  private readonly errorRateThreshold: number;
  private readonly now: () => number;

  constructor(keys: string[], options: VeniceKeyPoolOptions) {
    this.cooldownMs = options.cooldownMs;
    this.errorRateThreshold = options.errorRateThreshold;
    this.now = options.now ?? (() => Date.now());
    for (const key of keys) {
      if (!key || this.states.has(key)) continue;
      this.states.set(key, { key, window: [], requestCount: 0, cooldownUntil: 0 });
    }
  }

  /**
   * The healthiest key that is not cooling down: lowest error rate first, then
   * the least-used key. Throws {@link VeniceUnavailableError} when every key is
   * in cooldown, so the caller fails fast and the circuit breaker can open.
   */
  acquire(): string {
    let best: KeyState | undefined;
    for (const state of this.states.values()) {
      if (!this.isAvailableState(state)) continue;
      if (!best) {
        best = state;
        continue;
      }
      const rateDelta = this.errorRate(state) - this.errorRate(best);
      if (rateDelta < 0 || (rateDelta === 0 && state.requestCount < best.requestCount)) {
        best = state;
      }
    }
    if (!best) {
      throw new VeniceUnavailableError(this.states.size);
    }
    return best.key;
  }

  /** Whether a key may be used right now. Unknown keys are treated as available. */
  isAvailable(key: string): boolean {
    const state = this.states.get(key);
    return state === undefined || this.isAvailableState(state);
  }

  /**
   * Record one attempt's outcome. A key that crosses the error-rate threshold
   * over a full enough window enters cooldown.
   */
  recordResult(key: string, success: boolean): void {
    const state = this.states.get(key);
    if (!state) return;

    state.requestCount += 1;
    state.window.push(success);
    if (state.window.length > KEY_POOL_WINDOW_SIZE) state.window.shift();

    if (
      !success &&
      state.window.length >= KEY_POOL_MIN_SAMPLES &&
      this.errorRate(state) > this.errorRateThreshold
    ) {
      this.markCoolingDown(key);
      // Start fresh once the cooldown ends, so a recovered key is not re-tripped
      // by the failures that put it there.
      state.window = [];
    }
  }

  /** Take a key out of rotation for `durationMs` (default: the configured cooldown). */
  markCoolingDown(key: string, durationMs: number = this.cooldownMs): void {
    const state = this.states.get(key);
    if (!state) return;
    state.cooldownUntil = this.now() + durationMs;
  }

  /** Number of keys that are currently available. */
  healthyCount(): number {
    let count = 0;
    for (const state of this.states.values()) {
      if (this.isAvailableState(state)) count += 1;
    }
    return count;
  }

  /** Per-key status with values masked. */
  getStatus(): KeyPoolStatus[] {
    return [...this.states.values()].map((state) => ({
      keyFragment: keyFragmentOf(state.key),
      healthy: this.isAvailableState(state),
      errorRate: Math.round(this.errorRate(state) * 10_000) / 10_000,
      requestCount: state.requestCount,
      coolingDownUntil: state.cooldownUntil > this.now() ? new Date(state.cooldownUntil).toISOString() : null,
    }));
  }

  /** Number of distinct keys in the pool. */
  size(): number {
    return this.states.size;
  }

  private isAvailableState(state: KeyState): boolean {
    return state.cooldownUntil <= this.now();
  }

  private errorRate(state: KeyState): number {
    if (state.window.length === 0) return 0;
    const failures = state.window.filter((ok) => !ok).length;
    return failures / state.window.length;
  }
}

/**
 * The pool used by the most recently constructed Venice client. Read by the
 * admin status endpoint and the Prometheus collector.
 */
let activePool: VeniceKeyPool | null = null;

export function setActiveVeniceKeyPool(pool: VeniceKeyPool | null): void {
  activePool = pool;
}

export function getActiveVeniceKeyPool(): VeniceKeyPool | null {
  return activePool;
}
