/**
 * Per-key health for the Venice fallback chain (issue #741).
 *
 * The client walks `VENICE_API_KEY` plus `VENICE_FALLBACK_API_KEYS` in a fixed
 * order, which is the wrong order once a key has gone bad: a key that is
 * refusing requests with `429` is retried first on every call until the
 * breaker opens, so the healthy fallbacks are only reached after paying for a
 * guaranteed failure each time. When the quota window rolls over the primary
 * silently becomes usable again, so permanently promoting a fallback would
 * strand the (usually better) primary key.
 *
 * This store tracks each key's recent outcomes and answers one question for
 * the client: *in which order should the providers be tried on this call?*
 *
 * • A key inside its quota cooldown is pushed to the end of the order, so
 *   calls go straight to keys that can serve them.
 * • Recovery is automatic: the cooldown is a deadline, not a latch, and the
 *   first key to succeed after it expires is back in normal rotation.
 * • When every key is cooling down the order is still usable — sorted by
 *   earliest expiry — because a request we never send can never succeed, and
 *   sending it is also how a recovered key is discovered.
 * • Ranking among available keys is by rolling error rate, then mean latency,
 *   then configured order (so a freshly started process behaves exactly as
 *   before, and a flapping key cannot outrank a stable one).
 *
 * Keys are identified in every log line and snapshot by a truncated SHA-256
 * (`keyId`). The raw key is held only to be sent to Venice; it is never logged,
 * never returned from `snapshot()`, and never written to the metrics surface.
 */

import { createLogger, hashLogIdentifier } from '../../utils/logger.js';
import { getConfig } from '../../config/index.js';
import type { VeniceProviderConfig } from './types.js';

const log = createLogger({ module: 'VeniceKeyHealth' });

/** Why a provider attempt failed — decides whether the key needs a cooldown. */
export type VeniceKeyFailureKind = 'quota' | 'auth' | 'server' | 'transport';

/** Lifecycle of a single key from the rotation's point of view. */
export type VeniceKeyState = 'healthy' | 'degraded' | 'cooldown';

/** Redacted, serialisable view of one key. Safe for `/api/admin/status`. */
export interface VeniceKeyHealthSnapshot {
  /** Provider slot name, e.g. `primary` / `fallback-1`. */
  id: string;
  /** Truncated SHA-256 of the key — the key itself is never surfaced. */
  keyId: string;
  state: VeniceKeyState;
  /** Epoch ms until which the key is skipped, or null when not cooling down. */
  cooldownUntil: number | null;
  successes: number;
  failures: number;
  /** Quota rejections (`429`) observed since construction. */
  quotaEvents: number;
  /**
   * Failures / (successes + failures) over the rolling window of non-quota
   * failures (0 when empty). Quota rejections are excluded — they are the
   * cooldown's job, and counting them would keep a recovered key ranked last
   * forever.
   */
  errorRate: number;
  /** Exponentially-weighted mean request latency in ms, or null before the first call. */
  avgLatencyMs: number | null;
  lastSuccessAt: number | null;
  lastFailureAt: number | null;
}

/** Rolling outcome window used for the error rate. */
const ERROR_WINDOW = 20;

/** Smoothing factor for the latency estimate: higher reacts faster. */
const LATENCY_ALPHA = 0.3;

/** Error rate at or above which an available key is reported as degraded. */
const DEGRADED_ERROR_RATE = 0.3;

const DEFAULT_COOLDOWN_MS = 60_000;
const DEFAULT_MAX_COOLDOWN_MS = 900_000;

interface KeyEntry {
  name: string;
  apiKey: string;
  keyId: string;
  successes: number;
  failures: number;
  quotaEvents: number;
  /** Consecutive quota rejections; drives cooldown escalation. */
  consecutiveQuotaEvents: number;
  /** Most recent outcome, oldest first (true = success). */
  recent: boolean[];
  avgLatencyMs: number | null;
  cooldownUntil: number | null;
  lastSuccessAt: number | null;
  lastFailureAt: number | null;
}

/**
 * Stable, non-reversible key identity.
 *
 * SHA-256 truncated to 16 hex chars: short enough for a log field, and safe to
 * publish because it cannot be inverted to the key.
 */
export function veniceKeyId(apiKey: string): string {
  return hashLogIdentifier(apiKey);
}

function errorRateOf(entry: KeyEntry | undefined): number {
  if (!entry || entry.recent.length === 0) return 0;
  const failures = entry.recent.filter((ok) => !ok).length;
  return failures / entry.recent.length;
}

export interface VeniceKeyHealthStoreOptions {
  /** Injectable clock (epoch ms) — deterministic tests drive the cooldown with it. */
  nowFn?: () => number;
  /** Logger override; defaults to the module logger. */
  logger?: Pick<typeof log, 'info' | 'warn' | 'error'>;
  /** Base quota cooldown in ms. Default: `VENICE_KEY_COOLDOWN_MS` or 60_000. */
  cooldownMs?: number;
  /** Upper bound for the escalated cooldown. Default: `VENICE_KEY_COOLDOWN_MAX_MS` or 900_000. */
  maxCooldownMs?: number;
}

export class VeniceKeyHealthStore {
  private readonly entries = new Map<string, KeyEntry>();
  private readonly nowFn: () => number;
  private readonly logger: Pick<typeof log, 'info' | 'warn' | 'error'>;
  private readonly cooldownMs: number;
  private readonly maxCooldownMs: number;

  constructor(options: VeniceKeyHealthStoreOptions = {}) {
    this.nowFn = options.nowFn ?? ((): number => Date.now());
    this.logger = options.logger ?? log;
    this.cooldownMs = positiveInt(options.cooldownMs, DEFAULT_COOLDOWN_MS);
    this.maxCooldownMs = Math.max(
      positiveInt(options.maxCooldownMs, DEFAULT_MAX_COOLDOWN_MS),
      this.cooldownMs
    );
  }

  /** Track the given providers. Existing slots keep their counters; a rotated key resets its identity. */
  register(providers: VeniceProviderConfig[]): void {
    for (const provider of providers) {
      const name = provider.name ?? 'primary';
      const keyId = veniceKeyId(provider.apiKey);
      const existing = this.entries.get(name);
      if (existing) {
        if (existing.apiKey !== provider.apiKey) {
          // The key behind this slot changed: its old health says nothing
          // about the new credential, so the whole history resets.
          this.entries.set(name, {
            name,
            apiKey: provider.apiKey,
            keyId,
            successes: 0,
            failures: 0,
            quotaEvents: 0,
            consecutiveQuotaEvents: 0,
            recent: [],
            avgLatencyMs: null,
            cooldownUntil: null,
            lastSuccessAt: null,
            lastFailureAt: null,
          });
        }
        continue;
      }
      this.entries.set(name, {
        name,
        apiKey: provider.apiKey,
        keyId,
        successes: 0,
        failures: 0,
        quotaEvents: 0,
        consecutiveQuotaEvents: 0,
        recent: [],
        avgLatencyMs: null,
        cooldownUntil: null,
        lastSuccessAt: null,
        lastFailureAt: null,
      });
    }
  }

  /**
   * Order the providers for one call: healthiest available first.
   *
   * Keys inside a quota cooldown sort last, by earliest expiry, so the call
   * does not pay for a known failure — unless every key is cooling down, in
   * which case the same ordering is still returned rather than refusing to
   * try at all.
   */
  order(providers: VeniceProviderConfig[]): VeniceProviderConfig[] {
    if (providers.length <= 1) return [...providers];
    const now = this.nowFn();

    return providers
      .map((provider, index) => {
        const entry = this.entries.get(provider.name ?? 'primary');
        const cooling = entry?.cooldownUntil != null && entry.cooldownUntil > now;
        return { provider, index, entry, cooling };
      })
      .sort((a, b) => {
        if (a.cooling !== b.cooling) return a.cooling ? 1 : -1;
        if (a.cooling) return (a.entry?.cooldownUntil ?? 0) - (b.entry?.cooldownUntil ?? 0);
        const scoreA = scoreOf(a.entry);
        const scoreB = scoreOf(b.entry);
        if (scoreA !== scoreB) return scoreA - scoreB;
        return a.index - b.index;
      })
      .map((ranked) => ranked.provider);
  }

  /** Record a completed call against `name`. */
  recordSuccess(name: string, latencyMs?: number): void {
    const entry = this.entries.get(name);
    if (!entry) return;
    const now = this.nowFn();

    if (entry.cooldownUntil != null) {
      // A success is proof the key works again, whether the deadline had
      // lapsed or the key was forced into rotation because everything else
      // was cooling down too.
      entry.consecutiveQuotaEvents = 0;
      entry.cooldownUntil = null;
      this.logger.info(
        { provider: name, keyId: entry.keyId },
        'venice key recovered — back in rotation'
      );
    }

    entry.successes += 1;
    entry.lastSuccessAt = now;
    entry.recent.push(true);
    if (entry.recent.length > ERROR_WINDOW) entry.recent.shift();
    entry.avgLatencyMs = blendLatency(entry.avgLatencyMs, latencyMs);
  }

  /**
   * Record a failed call against `name`.
   *
   * Only `quota` (429) puts the key on cooldown: that is the one failure the
   * key itself will recover from on a timer, and the one we can predict will
   * fail every subsequent request until the window rolls over. Auth, server
   * and transport failures only feed the error rate — a 401 may be a bad
   * deployment-wide config, and 5xx is often the whole service, so cooling
   * those keys down would take down a chain that is already failing over.
   *
   * Quota failures deliberately stay out of the rolling error window: the
   * cooldown is their whole treatment. Counting them would leave the key with
   * a permanently worst-in-chain error rate after recovery, because a key
   * that always ranks last is never retried and can never dilute the window.
   */
  recordFailure(name: string, kind: VeniceKeyFailureKind, latencyMs?: number): void {
    const entry = this.entries.get(name);
    if (!entry) return;
    const now = this.nowFn();

    entry.failures += 1;
    entry.lastFailureAt = now;
    entry.avgLatencyMs = blendLatency(entry.avgLatencyMs, latencyMs);
    if (kind !== 'quota') {
      entry.recent.push(false);
      if (entry.recent.length > ERROR_WINDOW) entry.recent.shift();
      return;
    }

    entry.quotaEvents += 1;
    entry.consecutiveQuotaEvents += 1;
    const backoffMs = Math.min(
      this.cooldownMs * 2 ** (entry.consecutiveQuotaEvents - 1),
      this.maxCooldownMs
    );
    entry.cooldownUntil = now + backoffMs;
    this.logger.warn(
      {
        provider: name,
        keyId: entry.keyId,
        cooldownMs: backoffMs,
        cooldownUntil: entry.cooldownUntil,
        quotaEvents: entry.quotaEvents,
      },
      'venice key quota exhausted — rotating to the next key'
    );
  }

  /** Redacted health for every tracked key, in configured order. */
  snapshot(): VeniceKeyHealthSnapshot[] {
    const now = this.nowFn();
    return [...this.entries.values()].map((entry) => {
      const errorRate = errorRateOf(entry);
      const cooling = entry.cooldownUntil != null && entry.cooldownUntil > now;
      // Quota-only keys stay healthy on purpose: their treatment is the
      // cooldown, and a "degraded" label after recovery would misreport a key
      // that is ready to serve.
      const state: VeniceKeyState = cooling
        ? 'cooldown'
        : errorRate >= DEGRADED_ERROR_RATE
          ? 'degraded'
          : 'healthy';
      return {
        id: entry.name,
        keyId: entry.keyId,
        state,
        cooldownUntil: entry.cooldownUntil,
        successes: entry.successes,
        failures: entry.failures,
        quotaEvents: entry.quotaEvents,
        errorRate,
        avgLatencyMs: entry.avgLatencyMs,
        lastSuccessAt: entry.lastSuccessAt,
        lastFailureAt: entry.lastFailureAt,
      };
    });
  }

  /** Redacted identity of a tracked slot, for log lines. */
  keyIdFor(name: string): string | undefined {
    return this.entries.get(name)?.keyId;
  }
}

/**
 * Lower is healthier: the rolling error rate dominates, then latency, so a
 * key that is failing is never preferred for being merely fast.
 */
function scoreOf(entry: KeyEntry | undefined): number {
  if (!entry) return 0;
  return errorRateOf(entry) * 10_000 + (entry.avgLatencyMs ?? 0);
}

function blendLatency(previous: number | null, sample: number | undefined): number | null {
  if (sample === undefined || !Number.isFinite(sample)) return previous;
  if (previous === null) return Math.max(0, sample);
  return previous + LATENCY_ALPHA * (Math.max(0, sample) - previous);
}

function positiveInt(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value) || value < 1) return fallback;
  return Math.floor(value);
}

function resolveCooldownMs(): number | undefined {
  try {
    const config = getConfig() as Record<string, unknown>;
    const value = Number(config?.VENICE_KEY_COOLDOWN_MS);
    return Number.isFinite(value) && value > 0 ? value : undefined;
  } catch {
    return undefined;
  }
}

function resolveMaxCooldownMs(): number | undefined {
  try {
    const config = getConfig() as Record<string, unknown>;
    const value = Number(config?.VENICE_KEY_COOLDOWN_MAX_MS);
    return Number.isFinite(value) && value > 0 ? value : undefined;
  } catch {
    return undefined;
  }
}

let sharedStore: VeniceKeyHealthStore | null = null;

/**
 * Process-wide store shared by every `VeniceClient`.
 *
 * A node builds its provider chain from one set of env vars, so one store
 * keeps a single history per key however many clients are constructed, and
 * gives `/api/admin/status` and `/metrics` one place to read from.
 */
export function getVeniceKeyHealthStore(): VeniceKeyHealthStore {
  sharedStore ??= new VeniceKeyHealthStore({
    cooldownMs: resolveCooldownMs(),
    maxCooldownMs: resolveMaxCooldownMs(),
  });
  return sharedStore;
}

/** Drop the shared store — intended for tests only. */
export function resetVeniceKeyHealthStore(): void {
  sharedStore = null;
}
