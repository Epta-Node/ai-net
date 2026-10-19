import { randomUUID } from 'node:crypto';
import { createLogger } from '../../utils/logger.js';
import { CircuitBreaker, type CircuitMetrics, type CircuitState, type CircuitTransition } from './circuitBreaker.js';
import { trackCircuitBreaker } from '../circuitBreaker.js';
import { CircuitOpenError, TokenBudgetExceededError, VeniceStatusError, VeniceUnavailableError } from './errors.js';
import {
  VeniceKeyPool,
  loadNumberedVeniceKeys,
  setActiveVeniceKeyPool,
  type VeniceKeyPoolOptions,
} from './keyPool.js';
import { VeniceResponseCache, buildCacheKey } from './cache.js';
import { RequestDeduplicator } from './dedup.js';
import {
  getVeniceKeyHealthStore,
  type VeniceKeyFailureKind,
  type VeniceKeyHealthSnapshot,
  type VeniceKeyHealthStore,
} from './keyHealth.js';
import { getConfig } from '../../config/index.js';
import { currentTraceContext, toW3cTraceparent } from '../traceContext.js';
import type {
  AgentType,
  CompleteOptions,
  VeniceChatOptions,
  VeniceClientConfig,
  VeniceClientLike,
  VeniceMessage,
  VeniceProviderConfig,
  VeniceUsage,
} from './types.js';

interface CacheEnvConfig {
  VENICE_MODEL_VERSION: string;
  VENICE_CACHE_TTL_MS: number;
  VENICE_CACHE_CODING_TTL_MS: number;
  VENICE_CACHE_SIMILARITY_THRESHOLD: number;
  VENICE_REQUEST_TIMEOUT_MS: number;
  VENICE_PROVIDER_MAX_RETRIES: number;
}

/** Key-pool tuning resolved from the environment (issue #806). */
interface KeyPoolEnvConfig {
  VENICE_KEY_COOLDOWN_MS: number;
  VENICE_KEY_ERROR_RATE_THRESHOLD: number;
}

const KEY_POOL_CONFIG_FALLBACK: KeyPoolEnvConfig = {
  VENICE_KEY_COOLDOWN_MS: 60_000,
  VENICE_KEY_ERROR_RATE_THRESHOLD: 0.2,
};

/** Circuit-breaker tuning resolved from the environment (issue #495). */
interface CircuitEnvConfig {
  VENICE_CIRCUIT_FAILURE_THRESHOLD: number;
  VENICE_CIRCUIT_COOLDOWN_MS: number;
  VENICE_CIRCUIT_PROBE_COUNT: number;
}

const CONFIG_FALLBACK: CacheEnvConfig = {
  VENICE_MODEL_VERSION: 'v1',
  VENICE_CACHE_TTL_MS: 24 * 60 * 60 * 1000,
  VENICE_CACHE_CODING_TTL_MS: 60 * 60 * 1000,
  VENICE_CACHE_SIMILARITY_THRESHOLD: 0.8,
  VENICE_REQUEST_TIMEOUT_MS: 10_000,
  VENICE_PROVIDER_MAX_RETRIES: 3,
};

const CIRCUIT_CONFIG_FALLBACK: CircuitEnvConfig = {
  VENICE_CIRCUIT_FAILURE_THRESHOLD: 3,
  VENICE_CIRCUIT_COOLDOWN_MS: 60_000,
  VENICE_CIRCUIT_PROBE_COUNT: 1,
};

/**
 * Mirror the breaker's state onto the Prometheus gauge.
 *
 * Loaded lazily so the Venice module keeps no import-time dependency on the
 * metrics service (and therefore on its config/DB wiring); metrics are
 * best-effort telemetry and must never break a Venice call.
 */
function setVeniceCircuitBreakerState(code: number): void {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires, @typescript-eslint/no-require-imports
    const { metricsService } = require('../../services/metrics') as typeof import('../../services/metrics');
    metricsService.setVeniceCircuitBreakerState(code);
  } catch {
    // Metrics subsystem unavailable (e.g. a stripped test harness) — ignore.
  }
}

const log = createLogger({ module: 'VeniceClient' });

const MODEL_MAP: Record<AgentType, string> = {
  research: 'venice-xl',
  risk: 'venice-xl',
  coding: 'venice-code',
  design: 'venice-xl',
  report: 'venice-xl',
};

const DEFAULT_MAX_TOKENS = 2048;
const HARD_TOKEN_CAP = 8192;
const RETRY_DELAYS_MS = [200, 400, 800, 1600];
const RETRYABLE_STATUS_CODES = new Set([429, 503, 500, 502, 504]);
const NON_RETRYABLE_STATUS_CODES = new Set([400, 401, 422]);
const DEFAULT_CHAT_MODEL = 'llama-3.3-70b';

/**
 * Whether a failure is worth retrying against a *different* provider.
 *
 * A 401 may succeed on a fallback provider that holds a different key, so it
 * fails over. Any other 4xx means the provider rejected the request itself — a
 * malformed body or an unprocessable prompt — and every other provider will
 * reject it identically, so trying again only amplifies load during exactly the
 * conditions where we are already being refused. 429 and 5xx, transport errors
 * and timeouts stay failover-worthy because they are per-provider conditions.
 */
function shouldFailoverToNextProvider(err: Error): boolean {
  if (!(err instanceof VeniceStatusError)) return true;
  if (err.status === 401) return true;
  if (err.status === 429) return true;
  return err.status >= 500;
}

/**
 * Bucket a provider failure for the key-health store (issue #741).
 *
 * The status code is what matters: a 429 is a property of the key's quota
 * window rather than of the service, so it is the only kind that earns the
 * key a cooldown. A 401 may be a misconfigured deployment-wide secret, and a
 * 5xx is usually the service itself — cooling those keys down would drop a
 * chain that is already failing over for a reason that has nothing to do with
 * which key was used.
 */
function classifyVeniceFailure(err: Error): VeniceKeyFailureKind {
  if (err instanceof VeniceStatusError) {
    if (err.status === 429) return 'quota';
    if (err.status === 401) return 'auth';
    return 'server';
  }
  return 'transport';
}

/** A completed upstream call: the text plus what it cost in tokens. */
interface FetchOutcome {
  content: string;
  usage: VeniceUsage;
}

/**
 * Estimate usage when the provider gives us none.
 *
 * Uses the same chars/4 approximation as `logRequest`, so the number is
 * comparable with the rest of the observability surface even though it is an
 * approximation. Deliberately re-derived here rather than imported from the
 * budget service: the Venice client must not depend on the ledger, or every
 * cache read would start allocating ledger state.
 */
function estimateUsage(prompt: string, completion: string): VeniceUsage {
  const promptTokens = Math.ceil(prompt.length / 4);
  const completionTokens = Math.ceil(completion.length / 4);
  return {
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    total_tokens: promptTokens + completionTokens,
  };
}

/**
 * Normalize whatever the provider reported into a {@link VeniceUsage}.
 *
 * Returns null when the payload has no usable `usage` object, which is the
 * signal that we should fall back to estimating rather than reporting zeroes
 * — reporting 0 tokens would silently under-count the burn.
 */
function parseUsage(data: unknown): VeniceUsage | null {
  const usage = (data as any)?.usage;
  if (!usage || typeof usage !== 'object') return null;
  const prompt = Number(usage.prompt_tokens);
  const completion = Number(usage.completion_tokens);
  if (!Number.isFinite(prompt) || !Number.isFinite(completion)) return null;
  const total = Number.isFinite(Number(usage.total_tokens))
    ? Number(usage.total_tokens)
    : prompt + completion;
  return { prompt_tokens: prompt, completion_tokens: completion, total_tokens: total };
}

export class VeniceClient implements VeniceClientLike {
  private readonly providers: VeniceProviderConfig[];
  private readonly breaker: CircuitBreaker;
  private readonly cache: VeniceResponseCache;
  private readonly deduplicator: RequestDeduplicator;
  /** Health of each provider key; keys in cooldown are skipped (#806). */
  private readonly keyPool: VeniceKeyPool;
  private readonly modelVersion: string;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly enableCacheFallback: boolean;
  /** Unsubscribe handles for the breaker's transition listener. */
  private readonly circuitUnsubscribers: Array<() => void> = [];

  // Backward compat: expose primary for existing callers
  private get apiKey(): string {
    return this.providers[0]?.apiKey ?? '';
  }
  private get baseUrl(): string {
    return this.providers[0]?.baseUrl ?? 'https://api.venice.ai/api/v1';
  }

  constructor(config: VeniceClientConfig) {
    this.breaker = config.circuitBreaker ?? this.createBreaker(config);
    // Expose this breaker to `/health/deep`; untracked again in dispose().
    this.circuitUnsubscribers.push(trackCircuitBreaker(this.breaker));

    const env = this.resolveConfig() as any;
    this.modelVersion = config.modelVersion ?? env.VENICE_MODEL_VERSION ?? CONFIG_FALLBACK.VENICE_MODEL_VERSION;
    this.timeoutMs = config.timeoutMs ?? env.VENICE_REQUEST_TIMEOUT_MS ?? CONFIG_FALLBACK.VENICE_REQUEST_TIMEOUT_MS;
    this.maxRetries = config.maxRetries ?? env.VENICE_PROVIDER_MAX_RETRIES ?? CONFIG_FALLBACK.VENICE_PROVIDER_MAX_RETRIES;
    this.enableCacheFallback = config.enableCacheFallback ?? true;

    // Surface every state transition (`opened` / `closed` / `half_opened`) both
    // to the caller's listener and to the process-wide metrics gauge.
    this.circuitUnsubscribers.push(
      this.breaker.on('*', (transition) => this.onCircuitTransition(transition)),
    );
    if (config.onCircuitStateChange) {
      this.circuitUnsubscribers.push(
        this.breaker.on('*', (transition) => config.onCircuitStateChange?.(transition)),
      );
    }

    // Build ordered provider chain: explicit providers wins, otherwise build from config + env fallbacks
    if (config.providers && config.providers.length > 0) {
      this.providers = config.providers.map((p) => ({
        apiKey: p.apiKey,
        baseUrl: p.baseUrl ?? this.resolveBaseUrl(),
        name: p.name,
      }));
    } else {
      this.providers = this.buildProvidersFromEnv(config);
    }

    this.keyPool = new VeniceKeyPool(
      this.providers.map((provider) => provider.apiKey),
      this.resolveKeyPoolConfig(),
    );
    setActiveVeniceKeyPool(this.keyPool);

    const cacheConfig = config.cacheConfig ?? {};
    this.cache =
      config.cache ??
      new VeniceResponseCache({
        defaultTtlMs: cacheConfig.defaultTtlMs ?? env.VENICE_CACHE_TTL_MS ?? CONFIG_FALLBACK.VENICE_CACHE_TTL_MS,
        codingTtlMs: cacheConfig.codingTtlMs ?? env.VENICE_CACHE_CODING_TTL_MS ?? CONFIG_FALLBACK.VENICE_CACHE_CODING_TTL_MS,
        similarityThreshold:
          cacheConfig.similarityThreshold ?? env.VENICE_CACHE_SIMILARITY_THRESHOLD ?? CONFIG_FALLBACK.VENICE_CACHE_SIMILARITY_THRESHOLD,
      });
    this.deduplicator = config.deduplicator ?? new RequestDeduplicator();
  }

  /**
   * Build a breaker with the same three-state semantics as the injected one,
   * tunable through `VENICE_CIRCUIT_*` env vars (issue #495).
   */
  private createBreaker(config: VeniceClientConfig): CircuitBreaker {
    const env = this.resolveCircuitConfig();
    return new CircuitBreaker({
      failureThreshold:
        config.failureThreshold ??
        env.VENICE_CIRCUIT_FAILURE_THRESHOLD ??
        CIRCUIT_CONFIG_FALLBACK.VENICE_CIRCUIT_FAILURE_THRESHOLD,
      cooldownMs:
        config.cooldownMs ??
        env.VENICE_CIRCUIT_COOLDOWN_MS ??
        CIRCUIT_CONFIG_FALLBACK.VENICE_CIRCUIT_COOLDOWN_MS,
      probeCount:
        config.probeCount ??
        env.VENICE_CIRCUIT_PROBE_COUNT ??
        CIRCUIT_CONFIG_FALLBACK.VENICE_CIRCUIT_PROBE_COUNT,
    });
  }

  /** Fan a breaker transition out to the metrics gauge and the structured log. */
  private onCircuitTransition(transition: CircuitTransition): void {
    // 0 = closed, 1 = open, 2 = half-open (see MetricsService).
    const code = transition.to === 'CLOSED' ? 0 : transition.to === 'OPEN' ? 1 : 2;
    setVeniceCircuitBreakerState(code);
    log.info(
      {
        event: transition.event,
        from: transition.from,
        to: transition.to,
        reason: transition.reason,
        failures: transition.failures,
      },
      'venice circuit transition',
    );
  }


  /** Detach the breaker's transition listeners. */
  dispose(): void {
    for (const unsubscribe of this.circuitUnsubscribers) {
      unsubscribe();
    }
    this.circuitUnsubscribers.length = 0;
  }

  private buildProvidersFromEnv(config: VeniceClientConfig): VeniceProviderConfig[] {
    const primary: VeniceProviderConfig = {
      apiKey: config.apiKey,
      baseUrl: config.baseUrl ?? this.resolveBaseUrl(),
      name: 'primary',
    };
    const providers: VeniceProviderConfig[] = [primary];

    // Numbered keys (#806) join the chain after the primary and any explicit fallbacks.
    for (const [index, key] of loadNumberedVeniceKeys().entries()) {
      if (providers.some((provider) => provider.apiKey === key)) continue;
      providers.push({ apiKey: key, baseUrl: primary.baseUrl, name: `key-${index + 1}` });
    }

    // Try to read fallback env vars via getConfig (if available)
    try {
      const cfg: any = getConfig();
      const fallbackKeys: string = cfg.VENICE_FALLBACK_API_KEYS ?? '';
      const fallbackUrls: string = cfg.VENICE_FALLBACK_BASE_URLS ?? '';
      if (fallbackKeys) {
        const keys = fallbackKeys
          .split(',')
          .map((k: string) => k.trim())
          .filter(Boolean);
        const urls = fallbackUrls
          ? fallbackUrls.split(',').map((u: string) => u.trim()).filter(Boolean)
          : [];
        keys.forEach((key: string, idx: number) => {
          providers.push({
            apiKey: key,
            baseUrl: urls[idx] ?? urls[0] ?? primary.baseUrl ?? 'https://api.venice.ai/api/v1',
            name: `fallback-${idx + 1}`,
          });
        });
      }
    } catch {
      // No config available (e.g. in tests) — just use primary
    }

    return providers;
  }

  private resolveConfig(): CacheEnvConfig {
    try {
      const config = getConfig() as any;
      return {
        VENICE_MODEL_VERSION: config?.VENICE_MODEL_VERSION ?? CONFIG_FALLBACK.VENICE_MODEL_VERSION,
        VENICE_CACHE_TTL_MS: config?.VENICE_CACHE_TTL_MS ?? CONFIG_FALLBACK.VENICE_CACHE_TTL_MS,
        VENICE_CACHE_CODING_TTL_MS: config?.VENICE_CACHE_CODING_TTL_MS ?? CONFIG_FALLBACK.VENICE_CACHE_CODING_TTL_MS,
        VENICE_CACHE_SIMILARITY_THRESHOLD: config?.VENICE_CACHE_SIMILARITY_THRESHOLD ?? CONFIG_FALLBACK.VENICE_CACHE_SIMILARITY_THRESHOLD,
        VENICE_REQUEST_TIMEOUT_MS: config?.VENICE_REQUEST_TIMEOUT_MS ?? CONFIG_FALLBACK.VENICE_REQUEST_TIMEOUT_MS,
        VENICE_PROVIDER_MAX_RETRIES: config?.VENICE_PROVIDER_MAX_RETRIES ?? CONFIG_FALLBACK.VENICE_PROVIDER_MAX_RETRIES,
      };
    } catch {
      return CONFIG_FALLBACK;
    }
  }

  private resolveKeyPoolConfig(): VeniceKeyPoolOptions {
    try {
      const config = getConfig() as any;
      return {
        cooldownMs: config?.VENICE_KEY_COOLDOWN_MS ?? KEY_POOL_CONFIG_FALLBACK.VENICE_KEY_COOLDOWN_MS,
        errorRateThreshold:
          config?.VENICE_KEY_ERROR_RATE_THRESHOLD ?? KEY_POOL_CONFIG_FALLBACK.VENICE_KEY_ERROR_RATE_THRESHOLD,
      };
    } catch {
      return {
        cooldownMs: KEY_POOL_CONFIG_FALLBACK.VENICE_KEY_COOLDOWN_MS,
        errorRateThreshold: KEY_POOL_CONFIG_FALLBACK.VENICE_KEY_ERROR_RATE_THRESHOLD,
      };
    }
  }

  /** Key health snapshot for the admin status endpoint. Values are masked. */
  getKeyPoolStatus(): ReturnType<VeniceKeyPool['getStatus']> {
    return this.keyPool.getStatus();
  }

  private resolveCircuitConfig(): CircuitEnvConfig {
    try {
      const config = getConfig() as any;
      return {
        VENICE_CIRCUIT_FAILURE_THRESHOLD:
          config?.VENICE_CIRCUIT_FAILURE_THRESHOLD ??
          CIRCUIT_CONFIG_FALLBACK.VENICE_CIRCUIT_FAILURE_THRESHOLD,
        VENICE_CIRCUIT_COOLDOWN_MS:
          config?.VENICE_CIRCUIT_COOLDOWN_MS ??
          CIRCUIT_CONFIG_FALLBACK.VENICE_CIRCUIT_COOLDOWN_MS,
        VENICE_CIRCUIT_PROBE_COUNT:
          config?.VENICE_CIRCUIT_PROBE_COUNT ??
          CIRCUIT_CONFIG_FALLBACK.VENICE_CIRCUIT_PROBE_COUNT,
      };
    } catch {
      return CIRCUIT_CONFIG_FALLBACK;
    }
  }

  private resolveBaseUrl(): string {
    try {
      return getConfig().VENICE_BASE_URL;
    } catch {
      return 'https://api.venice.ai/api/v1';
    }
  }

  getModelFor(agentType: AgentType): string {
    return MODEL_MAP[agentType];
  }

  /** Current breaker state: `CLOSED` | `OPEN` | `HALF_OPEN`. */
  getCircuitState(): CircuitState {
    return this.breaker.getState();
  }

  getFailureCount(): number {
    return this.breaker.getFailureCount();
  }

  /**
   * Full breaker observability (issue #495):
   * `{ state, failures, successes, lastFailureAt, lastSuccessAt }`.
   */
  getCircuitMetrics(): CircuitMetrics {
    return this.breaker.getMetrics();
  }

  /** The breaker itself, for callers that need {@link CircuitBreaker.on}. */
  getCircuitBreaker(): CircuitBreaker {
    return this.breaker;
  }

  /** Expose provider chain for observability / tests. */
  getProviders(): VeniceProviderConfig[] {
    return [...this.providers];
  }

  /**
   * Redacted per-key health for the fallback chain (issue #741): cooldowns,
   * error rates and latency, identified by `keyId` — never by the key itself.
   */
  getKeyHealth(): VeniceKeyHealthSnapshot[] {
    return this.keyHealth.snapshot();
  }

  /** Current cache hit rate (0..1) for monitoring. */
  getCacheHitRate(): number {
    return this.cache.getHitRate();
  }

  /** Clear the entire response cache. */
  invalidateCache(): void {
    this.cache.invalidateAll();
  }

  /** Drop cache entries created under a specific model version. */
  invalidateModelVersion(modelVersion: string): void {
    this.cache.invalidateModelVersion(modelVersion);
  }

  async complete(
    prompt: string,
    agentType: AgentType,
    options?: CompleteOptions
  ): Promise<string> {
    const model = this.getModelFor(agentType);
    return this.createCompletion({
      messages: [{ role: 'user', content: prompt }],
      model,
      options,
      promptForLogging: prompt,
      agentType,
    });
  }

  async chat(messages: VeniceMessage[], options: VeniceChatOptions = {}): Promise<string> {
    const promptForLogging = messages.map(message => message.content).join('\n\n');
    return this.createCompletion({
      messages,
      model: options.model ?? DEFAULT_CHAT_MODEL,
      options,
      promptForLogging,
      agentType: 'chat',
    });
  }

  private async createCompletion({
    messages,
    model,
    options,
    promptForLogging,
    agentType,
  }: {
    messages: VeniceMessage[];
    model: string;
    options?: CompleteOptions;
    promptForLogging: string;
    agentType: string;
  }): Promise<string> {
    // The budget ceiling is a cap, never a floor: an explicit per-call
    // maxTokens still wins when it is the more restrictive of the two.
    const requested = options?.maxTokens ?? DEFAULT_MAX_TOKENS;
    const maxTokens = options?.budget?.maxTokens
      ? Math.min(requested, options.budget.maxTokens)
      : requested;
    if (maxTokens > HARD_TOKEN_CAP) {
      throw new TokenBudgetExceededError(maxTokens, HARD_TOKEN_CAP);
    }
    if (maxTokens <= 0) {
      throw new TokenBudgetExceededError(requested, 0);
    }

    // Circuit breaker admission. In HALF_OPEN this reserves one of the probe
    // slots, so every exit path below must settle it exactly once — either
    // recordSuccess/recordFailure (from the fetch) or release() (when the call
    // never reached the network, e.g. a cache hit).
    let probeHeld = false;
    let settled = false;
    const settleSuccess = (): void => {
      if (settled) return;
      settled = true;
      this.breaker.recordSuccess();
    };
    const settleFailure = (): void => {
      if (settled) return;
      settled = true;
      this.breaker.recordFailure();
    };

    try {
      try {
        this.breaker.assertClosed();
        probeHeld = true;
      } catch (e) {
        if (this.enableCacheFallback && !options?.force) {
          const stale = this.cache.getStale(promptForLogging, agentType, this.modelVersion);
          if (stale !== null) {
            log.warn({ agentType, model, circuitState: this.breaker.getState() }, 'venice circuit open — serving stale cache');
            // A cache read costs no upstream tokens; report zero so the ledger
            // does not charge the task for a lookup.
            this.reportUsage(options, { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 });
            return stale;
          }
        }
        // No stale entry to fall back on: the open circuit must still shed
        // the call rather than let it through.
        throw e;
      }
      throw e;
    }

    try {
      const force = options?.force === true;
      const cacheKey = buildCacheKey(promptForLogging, agentType, this.modelVersion);

      if (!force) {
        const cached = this.cache.get(promptForLogging, agentType, this.modelVersion);
        if (cached !== null) {
          log.info(
            { agentType, model, modelVersion: this.modelVersion, hitRate: this.cache.getHitRate() },
            'venice cache hit',
          );
          this.reportUsage(options, { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 });
          return cached;
        }
      }

      const runFetch = (): Promise<FetchOutcome> =>
        this.runVeniceFetch({ messages, model, options, maxTokens, promptForLogging, agentType, settleSuccess, settleFailure });

      let outcome: FetchOutcome;
      try {
        outcome = force ? await runFetch() : await this.deduplicator.dedup(cacheKey, runFetch);
      } catch (err) {
        // Graceful degradation: if all providers failed and we have stale cache, return it
        if (this.enableCacheFallback && !force) {
          const stale = this.cache.getStale(promptForLogging, agentType, this.modelVersion);
          if (stale !== null) {
            log.warn(
              { agentType, model, error: err instanceof Error ? err.message : String(err) },
              'venice all providers failed — serving stale cache (graceful degradation)',
            );
            // We *tried* to spend here, so estimate rather than reporting zero:
            // the failed attempt did consume provider compute.
            this.reportUsage(options, estimateUsage(promptForLogging, ''));
            return stale;
          }
        }
        throw err;
      }

      // Report here rather than inside runVeniceFetch: the deduplicator shares
      // one promise across concurrent identical requests, and each caller passed
      // its own onUsage callback and budget context.
      this.reportUsage(options, outcome.usage);

      if (!force) {
        this.cache.set(promptForLogging, agentType, this.modelVersion, outcome.content);
      }
      return outcome.content;
    } finally {
      // Give back a HALF_OPEN probe slot the call never used. Harmless when the
      // slot was already settled — the breaker floors the counter at zero.
      if (probeHeld && !settled) {
        this.breaker.release();
      }
    }
  }

  /** Fire the caller's usage callback, if any. Never throws into the caller. */
  private reportUsage(options: CompleteOptions | undefined, usage: VeniceUsage): void {
    if (!options?.onUsage) return;
    try {
      options.onUsage(usage);
    } catch (err) {
      log.warn(
        { error: err instanceof Error ? err.message : String(err) },
        'onUsage callback threw — usage already recorded upstream'
      );
    }
  }

  private async runVeniceFetch({
    messages,
    model,
    options,
    maxTokens,
    promptForLogging,
    agentType,
    settleSuccess,
    settleFailure,
  }: {
    messages: VeniceMessage[];
    model: string;
    options?: CompleteOptions;
    maxTokens: number;
    promptForLogging: string;
    agentType: string;
    /** Records a success with the breaker (idempotent per call). */
    settleSuccess: () => void;
    /** Records a failure with the breaker (idempotent per call). */
    settleFailure: () => void;
  }): Promise<FetchOutcome> {
    const requestId = randomUUID();
    const start = Date.now();
    let retries = 0;
    const succeed = settleSuccess ?? ((): void => { this.breaker.recordSuccess(); });
    const fail = settleFailure ?? ((): void => { this.breaker.recordFailure(); });

    const body = JSON.stringify({
      model,
      messages,
      temperature: options?.temperature ?? 0.2,
      max_tokens: maxTokens,
    });

    let lastError: Error | undefined;
    let attempted = 0;

    // Try providers in order (fallback chain), skipping keys in cooldown (#806)
    for (let pIndex = 0; pIndex < this.providers.length; pIndex++) {
      const provider = this.providers[pIndex]!;
      if (!this.keyPool.isAvailable(provider.apiKey)) {
        log.warn({ agentType, model, skippedProvider: provider.name }, 'venice key in cooldown — skipping');
        continue;
      }
      attempted += 1;

      try {
        const response = await this.fetchWithRetryForProvider(
          body,
          provider,
          () => { retries++; },
        );
        const data: unknown = await response.json();
        const content = (data as any)?.choices?.[0]?.message?.content;
        if (typeof content !== 'string') {
          throw new Error('Venice response missing expected content field');
        }

        // Prefer the provider's own counts. If the payload has no usage block
        // (some deployments omit it), fall back to estimating rather than
        // reporting zero — under-counting is how a budget stops meaning
        // anything.
        const usage = parseUsage(data) ?? estimateUsage(promptForLogging, content);

        this.keyPool.recordResult(provider.apiKey, true);
        settleSuccess();
        this.logRequest(requestId, agentType, model, promptForLogging, Date.now() - start, 'ok', retries, provider.name, usage);
        return { content, usage };
      } catch (err) {
        if (err instanceof CircuitOpenError || err instanceof TokenBudgetExceededError) {
          throw err;
        }
        lastError = err instanceof Error ? err : new Error(String(err));
        this.keyHealth.recordFailure(
          provider.name ?? 'primary',
          classifyVeniceFailure(lastError),
          Date.now() - attemptStart,
        );
        // A 401 may still succeed on a fallback holding a different key, so it
        // fails over; other 4xx statuses will be rejected by every provider and
        // only serve to amplify load, so they fail fast.
        const mayFailover = shouldFailoverToNextProvider(lastError);
        // Only failures that reflect on the key count against its health; a 400
        // says nothing about the key that issued it.
        if (mayFailover) {
          this.keyPool.recordResult(provider.apiKey, false);
        }
        if (mayFailover && pIndex < this.providers.length - 1) {
          const nextProvider = this.providers[pIndex + 1]!.name ?? `fallback-${pIndex + 1}`;
          log.warn(
            {
              agentType,
              model,
              failedProvider: provider.name,
              failedKeyId: this.keyHealth.keyIdFor(provider.name ?? 'primary'),
              nextProvider,
              error: lastError.message,
              retries,
            },
            'venice provider failed — failing over to next provider',
          );
          // small backoff before failover to next provider
          await this.sleep(100);
          continue;
        }
        // Last provider failed — record failure for circuit breaker
        fail();
        this.logRequest(requestId, agentType, model, promptForLogging, Date.now() - start, 'error', retries, provider.name);
        // If we have stale cache fallback enabled, the caller (createCompletion) will handle it
        throw lastError;
      }
    }

    // Every key was skipped for cooldown: fail fast rather than hang (#806).
    if (attempted === 0) {
      settleFailure();
      throw new VeniceUnavailableError(this.providers.length);
    }

    // Should not reach here, but fallback
    fail();
    throw lastError ?? new Error('Venice AI is unreachable (all providers failed)');
  }

  async stream(
    prompt: string,
    agentType: AgentType,
    onChunk: (chunk: string) => void,
    options?: CompleteOptions
  ): Promise<void> {
    // Same ceiling rule as complete(): the budget caps, it never raises.
    const requested = options?.maxTokens ?? DEFAULT_MAX_TOKENS;
    const maxTokens = options?.budget?.maxTokens
      ? Math.min(requested, options.budget.maxTokens)
      : requested;
    if (maxTokens > HARD_TOKEN_CAP) {
      throw new TokenBudgetExceededError(maxTokens, HARD_TOKEN_CAP);
    }
    if (maxTokens <= 0) {
      throw new TokenBudgetExceededError(requested, 0);
    }

    // Streams have no cache to fall back on, so an open circuit is shed with
    // CircuitOpenError. In HALF_OPEN a probe slot is reserved and settled by
    // exactly one of the recordSuccess/recordFailure calls below.
    let probeHeld = false;
    let settled = false;
    const settleSuccess = (): void => {
      if (settled) return;
      settled = true;
      this.breaker.recordSuccess();
    };
    const settleFailure = (): void => {
      if (settled) return;
      settled = true;
      this.breaker.recordFailure();
    };

    this.breaker.acquire();
    probeHeld = this.breaker.getState() === 'HALF_OPEN';

    const model = this.getModelFor(agentType);
    const requestId = randomUUID();
    const start = Date.now();
    let retries = 0;

    const body = JSON.stringify({
      model,
      messages: [{ role: 'user', content: prompt }],
      temperature: options?.temperature ?? 0.2,
      max_tokens: maxTokens,
      stream: true,
    });

    // Deltas are buffered per provider attempt and only handed to the caller
    // once an attempt completes. Emitting eagerly meant that a mid-stream
    // failure left the caller's first provider's partial output already
    // delivered, and the failover then appended a second provider's output on
    // top of it — the caller received two responses concatenated with nothing
    // marking the boundary (issue #661).
    let delivered = 0;
    let lastError: Error | undefined;

    try {
      for (let pIndex = 0; pIndex < this.providers.length; pIndex++) {
        const provider = this.providers[pIndex]!;
        // Per-attempt buffer. Reset up front so no state leaks between providers.
        let accumulated = '';
        const deltas: string[] = [];
        try {
        const response = await this.fetchWithRetryForProvider(body, provider, () => { retries++; });

          if (!response.body) {
            throw new Error('Venice stream response has no body');
          }

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let done = false;
        // Chunk boundaries land wherever the network puts them, so a `data:`
        // line can be split across two reads. Carry the trailing partial line
        // between iterations instead of parsing each chunk in isolation —
        // otherwise both halves fail to parse and the content is dropped with
        // no error, which is silent output corruption (issue #660).
        let buffer = '';
        let parseFailures = 0;

        const handleLine = (line: string): void => {
          if (!line.startsWith('data: ')) return;
          const payload = line.slice(6).trim();
          if (payload === '[DONE]') return;
          try {
            const parsed = JSON.parse(payload);
            const delta = parsed?.choices?.[0]?.delta?.content;
            if (typeof delta === 'string' && delta.length > 0) {
              accumulated += delta;
              // Buffered rather than delivered here: the caller only sees an
              // attempt's output once that attempt completes (issue #661).
              deltas.push(delta);
            }
          } catch (err) {
            // A complete-but-unparseable frame is counted and surfaced rather
            // than swallowed, so a provider regression is visible in the logs
            // instead of showing up only as shorter output.
            parseFailures += 1;
            log.warn(
              {
                error: err instanceof Error ? err.message : String(err),
                agentType,
                model,
                payloadPreview: payload.slice(0, 200),
              },
              'venice SSE frame failed to parse — frame dropped'
            );
          }
        };

        while (!done) {
          const result = await reader.read();
          done = result.done;
          if (result.value) {
            const text = decoder.decode(result.value, { stream: !done });
            const lines = text.split('\n');
            for (const line of lines) {
              if (!line.startsWith('data: ')) continue;
              const payload = line.slice(6).trim();
              if (payload === '[DONE]') continue;
              try {
                const parsed = JSON.parse(payload);
                const delta = parsed?.choices?.[0]?.delta?.content;
                if (typeof delta === 'string' && delta.length > 0) {
                  accumulated += delta;
                  deltas.push(delta);
                }
              } catch (err) {
                parseFailures += 1;
                log.warn(
                  {
                    error: err instanceof Error ? err.message : String(err),
                    agentType,
                    model,
                    payloadPreview: payload.slice(0, 200),
                  },
                  'venice SSE frame failed to parse — frame dropped'
                );
              }
            }
          }

          // Everything up to the last newline is a complete line; the remainder
          // is a partial line that must survive until the next chunk.
          const lines = buffer.split('\n');
          buffer = lines.pop() ?? '';
          for (const line of lines) {
            handleLine(line);
          }
        }

        // The stream ended without a trailing newline, so the retained partial
        // line is a complete frame after all.
        if (buffer.length > 0) {
          handleLine(buffer);
        }

        if (parseFailures > 0) {
          log.warn(
            { agentType, model, parseFailures, provider: provider.name },
            'venice SSE stream completed with unparseable frames'
          );
        }

        // The attempt completed, so this output is authoritative. Only now is
        // it safe to hand to the caller.
        for (const delta of deltas) onChunk(delta);
        delivered = accumulated.length;

        settleSuccess();
        // SSE frames only carry deltas, so there is no provider usage block to
        // read. Estimate from the prompt and everything we actually received;
        // the completion side is exact because we buffered it.
        const streamUsage = estimateUsage(prompt, accumulated);
        this.reportUsage(options, streamUsage);
        this.logRequest(requestId, agentType, model, prompt, Date.now() - start, 'ok', retries, provider.name, streamUsage);
        return;
      } catch (err) {
        if (err instanceof CircuitOpenError || err instanceof TokenBudgetExceededError) {
          throw err;
        }
        // Discard the failed provider's partial output: it was never delivered,
        // so counting it would misreport both usage and progress.
        const droppedChars = accumulated.length;
        accumulated = '';
        lastError = err instanceof Error ? err : new Error(String(err));
        this.keyHealth.recordFailure(
          provider.name ?? 'primary',
          classifyVeniceFailure(lastError),
          Date.now() - attemptStart,
        );
        const mayFailover = shouldFailoverToNextProvider(lastError);
        if (mayFailover && pIndex < chain.length - 1) {
          const nextProvider = chain[pIndex + 1]!.name ?? `fallback-${pIndex + 1}`;
          log.warn(
            {
              agentType,
              model,
              failedProvider: provider.name,
              failedKeyId: this.keyHealth.keyIdFor(provider.name ?? 'primary'),
              nextProvider,
              error: lastError.message,
              droppedChars,
            },
            'venice stream provider failed — failover',
          );
          await this.sleep(100);
          continue;
        }
        settleFailure();
        this.logRequest(requestId, agentType, model, prompt, Date.now() - start, 'error', retries, provider.name);
        throw new Error(
          `Venice stream error after ${delivered} characters delivered: ${lastError.message}`
        );
      }
      }

      settleFailure();
      throw lastError ?? new Error('Venice stream failed (all providers)');
    } finally {
      if (probeHeld && !settled) {
        this.breaker.release();
      }
    }
  }

  /**
   * Per-provider fetch with retries, exponential backoff and per-call timeout.
   */
  private async fetchWithRetryForProvider(
    body: string,
    provider: VeniceProviderConfig,
    onRetry: () => void
  ): Promise<Response> {
    let lastError: Error | undefined;
    const maxAttempts = Math.min(this.maxRetries, RETRY_DELAYS_MS.length) + 1;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      let timeoutId: ReturnType<typeof setTimeout> | undefined;
      const controller = new AbortController();
      if (this.timeoutMs > 0) {
        timeoutId = setTimeout(() => controller.abort(), this.timeoutMs);
      }

      try {
        // Propagate the active W3C trace context to Venice so provider-side
        // logs correlate with our request spans (#856).
        const traceCtx = currentTraceContext();
        const response = await fetch(`${provider.baseUrl ?? this.baseUrl}/chat/completions`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${provider.apiKey}`,
            ...(traceCtx
              ? { traceparent: toW3cTraceparent(traceCtx.traceId, traceCtx.spanId) }
              : {}),
          },
          body,
          signal: controller.signal,
        });

        if (timeoutId) clearTimeout(timeoutId);

        if (response.ok) {
          return response;
        }

        if (NON_RETRYABLE_STATUS_CODES.has(response.status) && response.status !== 401) {
          // 401 may succeed on fallback with different key, so we treat it as retriable for failover
          throw new VeniceStatusError(response.status, `Venice returned non-retryable status: ${response.status}`);
        }

        // 401 is special: allow failover to next provider, not retry same provider
        if (response.status === 401) {
          throw new VeniceStatusError(response.status, `Venice returned non-retryable status: ${response.status}`);
        }

        if (RETRYABLE_STATUS_CODES.has(response.status) && attempt < maxAttempts - 1) {
          onRetry();
          await this.sleep(this.backoffDelay(attempt));
          continue;
        }

        throw new VeniceStatusError(response.status, `Venice returned status: ${response.status}`);
      } catch (err) {
        if (timeoutId) clearTimeout(timeoutId);
        // AbortError from timeout
        if (err instanceof Error && err.name === 'AbortError') {
          lastError = new Error(`Venice request timed out after ${this.timeoutMs}ms`);
          if (attempt < maxAttempts - 1) {
            onRetry();
            await this.sleep(this.backoffDelay(attempt));
            continue;
          }
          throw lastError;
        }
        if (err instanceof VeniceStatusError) {
          // A status response is final for this provider: do not retry it here.
          // Whether the *next* provider is worth trying is decided by
          // shouldFailoverToNextProvider in the caller.
          throw err;
        }
        lastError = err instanceof Error ? err : new Error(String(err));
        if (attempt < maxAttempts - 1) {
          onRetry();
          await this.sleep(this.backoffDelay(attempt));
          continue;
        }
      }
    }

    throw lastError ?? new Error('Venice AI is unreachable');
  }

  private backoffDelay(attempt: number): number {
    const base = RETRY_DELAYS_MS[attempt] ?? 800;
    // Add jitter ±20% to avoid thundering herd
    const jitter = base * 0.2 * (Math.random() * 2 - 1);
    return Math.max(50, Math.round(base + jitter));
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  private logRequest(
    veniceRequestId: string,
    agentType: string,
    model: string,
    prompt: string,
    durationMs: number,
    status: 'ok' | 'error',
    retries: number,
    providerName?: string,
    usage?: VeniceUsage
  ): void {
    const promptTokenEstimate = Math.ceil(prompt.length / 4);
    log.info({
      veniceRequestId,
      agentType,
      model,
      promptTokenEstimate,
      promptTokens: usage?.prompt_tokens,
      completionTokens: usage?.completion_tokens,
      totalTokens: usage?.total_tokens,
      durationMs,
      status,
      retries,
      provider: providerName ?? 'primary',
      circuitState: this.breaker.getState(),
      promptPreview: prompt.slice(0, 200),
    }, 'venice request');
  }
}
