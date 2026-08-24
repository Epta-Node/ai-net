import { randomUUID } from 'node:crypto';
import { createLogger } from '../../utils/logger.js';
import { CircuitBreaker } from '../../venice/circuitBreaker.js';
import { CircuitOpenError, TokenBudgetExceededError } from '../../venice/errors.js';
import { VeniceResponseCache, buildCacheKey } from './cache.js';
import { RequestDeduplicator } from './dedup.js';
import { getConfig } from '../../config/index.js';
import type {
  AgentType,
  CompleteOptions,
  VeniceChatOptions,
  VeniceClientConfig,
  VeniceClientLike,
  VeniceMessage,
} from './types.js';

interface CacheEnvConfig {
  VENICE_MODEL_VERSION: string;
  VENICE_CACHE_TTL_MS: number;
  VENICE_CACHE_CODING_TTL_MS: number;
  VENICE_CACHE_SIMILARITY_THRESHOLD: number;
}

const CONFIG_FALLBACK: CacheEnvConfig = {
  VENICE_MODEL_VERSION: 'v1',
  VENICE_CACHE_TTL_MS: 24 * 60 * 60 * 1000,
  VENICE_CACHE_CODING_TTL_MS: 60 * 60 * 1000,
  VENICE_CACHE_SIMILARITY_THRESHOLD: 0.8,
};

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
const RETRY_DELAYS_MS = [200, 400, 800];
const RETRYABLE_STATUS_CODES = new Set([429, 503]);
const NON_RETRYABLE_STATUS_CODES = new Set([400, 401, 422]);
const DEFAULT_CHAT_MODEL = 'llama-3.3-70b';

export class VeniceClient implements VeniceClientLike {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly breaker: CircuitBreaker;
  private readonly cache: VeniceResponseCache;
  private readonly deduplicator: RequestDeduplicator;
  private readonly modelVersion: string;

  constructor(config: VeniceClientConfig) {
    this.apiKey = config.apiKey;
    this.baseUrl = config.baseUrl ?? 'https://api.venice.ai/api/v1';
    this.breaker = config.circuitBreaker ?? new CircuitBreaker();

    const env = this.resolveConfig();
    this.modelVersion = config.modelVersion ?? env.VENICE_MODEL_VERSION;
    const cacheConfig = config.cacheConfig ?? {};
    this.cache =
      config.cache ??
      new VeniceResponseCache({
        defaultTtlMs: cacheConfig.defaultTtlMs ?? env.VENICE_CACHE_TTL_MS,
        codingTtlMs: cacheConfig.codingTtlMs ?? env.VENICE_CACHE_CODING_TTL_MS,
        similarityThreshold:
          cacheConfig.similarityThreshold ?? env.VENICE_CACHE_SIMILARITY_THRESHOLD,
      });
    this.deduplicator = config.deduplicator ?? new RequestDeduplicator();
  }

  private resolveConfig(): CacheEnvConfig {
    try {
      return getConfig() as unknown as CacheEnvConfig;
    } catch {
      return CONFIG_FALLBACK;
    }
  }

  getModelFor(agentType: AgentType): string {
    return MODEL_MAP[agentType];
  }

  getCircuitState() {
    return this.breaker.getState();
  }

  getFailureCount() {
    return this.breaker.getFailureCount();
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
    const maxTokens = options?.maxTokens ?? DEFAULT_MAX_TOKENS;
    if (maxTokens > HARD_TOKEN_CAP) {
      throw new TokenBudgetExceededError(maxTokens, HARD_TOKEN_CAP);
    }

    this.breaker.assertClosed();

    const force = options?.force === true;
    const cacheKey = buildCacheKey(promptForLogging, agentType, this.modelVersion);

    if (!force) {
      const cached = this.cache.get(promptForLogging, agentType, this.modelVersion);
      if (cached !== null) {
        log.info(
          { agentType, model, modelVersion: this.modelVersion, hitRate: this.cache.getHitRate() },
          'venice cache hit',
        );
        return cached;
      }
    }

    const runFetch = (): Promise<string> =>
      this.runVeniceFetch({ messages, model, options, promptForLogging, agentType });

    const result = force
      ? await runFetch()
      : await this.deduplicator.dedup(cacheKey, runFetch);

    if (!force) {
      this.cache.set(promptForLogging, agentType, this.modelVersion, result);
    }
    return result;
  }

  private async runVeniceFetch({
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
    const requestId = randomUUID();
    const start = Date.now();
    let retries = 0;

    const body = JSON.stringify({
      model,
      messages,
      temperature: options?.temperature ?? 0.2,
      max_tokens: options?.maxTokens ?? DEFAULT_MAX_TOKENS,
    });

    try {
      const response = await this.fetchWithRetry(body, () => { retries++; });
      const data: unknown = await response.json();
      const content = (data as any)?.choices?.[0]?.message?.content;
      if (typeof content !== 'string') {
        throw new Error('Venice response missing expected content field');
      }

      this.breaker.recordSuccess();
      this.logRequest(requestId, agentType, model, promptForLogging, Date.now() - start, 'ok', retries);
      return content;
    } catch (err) {
      if (err instanceof CircuitOpenError || err instanceof TokenBudgetExceededError) {
        throw err;
      }
      this.breaker.recordFailure();
      this.logRequest(requestId, agentType, model, promptForLogging, Date.now() - start, 'error', retries);
      throw err;
    }
  }

  async stream(
    prompt: string,
    agentType: AgentType,
    onChunk: (chunk: string) => void,
    options?: CompleteOptions
  ): Promise<void> {
    const maxTokens = options?.maxTokens ?? DEFAULT_MAX_TOKENS;
    if (maxTokens > HARD_TOKEN_CAP) {
      throw new TokenBudgetExceededError(maxTokens, HARD_TOKEN_CAP);
    }

    this.breaker.assertClosed();

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

    let accumulated = '';
    try {
      const response = await this.fetchWithRetry(body, () => { retries++; });

      if (!response.body) {
        throw new Error('Venice stream response has no body');
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let done = false;

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
                onChunk(delta);
              }
            } catch {
              // skip malformed SSE chunks
            }
          }
        }
      }

      this.breaker.recordSuccess();
      this.logRequest(requestId, agentType, model, prompt, Date.now() - start, 'ok', retries);
    } catch (err) {
      if (err instanceof CircuitOpenError || err instanceof TokenBudgetExceededError) {
        throw err;
      }
      this.breaker.recordFailure();
      this.logRequest(requestId, agentType, model, prompt, Date.now() - start, 'error', retries);
      throw new Error(
        `Venice stream error after ${accumulated.length} characters accumulated`
      );
    }
  }

  private async fetchWithRetry(
    body: string,
    onRetry: () => void
  ): Promise<Response> {
    let lastError: Error | undefined;

    for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
      try {
        const response = await fetch(`${this.baseUrl}/chat/completions`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${this.apiKey}`,
          },
          body,
        });

        if (response.ok) {
          return response;
        }

        if (NON_RETRYABLE_STATUS_CODES.has(response.status)) {
          throw new Error(`Venice returned non-retryable status: ${response.status}`);
        }

        if (RETRYABLE_STATUS_CODES.has(response.status) && attempt < RETRY_DELAYS_MS.length) {
          onRetry();
          await this.sleep(RETRY_DELAYS_MS[attempt]!);
          continue;
        }

        throw new Error(`Venice returned status: ${response.status}`);
      } catch (err) {
        if (err instanceof Error && err.message.startsWith('Venice returned')) {
          throw err;
        }
        lastError = err instanceof Error ? err : new Error(String(err));
        if (attempt < RETRY_DELAYS_MS.length) {
          onRetry();
          await this.sleep(RETRY_DELAYS_MS[attempt]!);
          continue;
        }
      }
    }

    throw lastError ?? new Error('Venice AI is unreachable');
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
    retries: number
  ): void {
    const promptTokenEstimate = Math.ceil(prompt.length / 4);
    log.info({
      veniceRequestId,
      agentType,
      model,
      promptTokenEstimate,
      durationMs,
      status,
      retries,
      circuitState: this.breaker.getState(),
      promptPreview: prompt.slice(0, 200),
    }, 'venice request');
  }
}
