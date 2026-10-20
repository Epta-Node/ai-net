import type { CircuitBreaker, CircuitTransition } from './circuitBreaker.js';
import type { CircuitMetrics, CircuitState } from './circuitBreaker.js';
import type { VeniceResponseCache } from './cache.js';
import type { RequestDeduplicator } from './dedup.js';
import type { VeniceKeyHealthStore } from './keyHealth.js';

export type AgentType = 'research' | 'risk' | 'coding' | 'design' | 'report';

/** Token counts as reported by the Venice completions API. */
export interface VeniceUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}

export interface CompleteOptions {
  maxTokens?: number;
  temperature?: number;
  /** Bypass the response cache (both read and write) when true. */
  force?: boolean;
  /**
   * Correlation for the call's spend. Supplied by the task budget ledger so
   * the burn is attributed to the right task/node/agent (Issue #390).
   */
  budget?: VeniceBudgetContext;
  /**
   * Invoked with the provider-reported token usage after every call, including
   * cache hits (where the estimate is passed instead of provider numbers).
   */
  onUsage?: (usage: VeniceUsage) => void;
}

/** Identity + allowance for a single LLM call, used for cost attribution. */
export interface VeniceBudgetContext {
  taskId: string;
  nodeId: string;
  agentId: string;
  agentType: AgentType;
  /** Tokens the caller may still spend; clamped to the hard cap internally. */
  maxTokens?: number;
}

/** Tunables for the Venice response cache. */
export interface VeniceCacheConfig {
  /** TTL (ms) for non-coding agents (research/design/risk/report). */
  defaultTtlMs?: number;
  /** TTL (ms) for the coding agent (more volatile). */
  codingTtlMs?: number;
  /** Minimum similarity score (0..1) for a fuzzy cache hit. */
  similarityThreshold?: number;
}

export interface VeniceMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface VeniceChatOptions extends CompleteOptions {
  model?: string;
}

export interface VeniceProviderConfig {
  apiKey: string;
  baseUrl?: string;
  name?: string;
}

export interface VeniceClientConfig {
  apiKey: string;
  baseUrl?: string;
  circuitBreaker?: CircuitBreaker;
  /** Ordered fallback providers; first is primary. When supplied, overrides apiKey/baseUrl. */
  providers?: VeniceProviderConfig[];
  /** Per-call timeout in ms. Default: 10_000. */
  timeoutMs?: number;
  /** Retries per provider with exponential backoff. Default: 3. */
  maxRetries?: number;
  /** When true, stale cache is returned if all providers fail. Default: true. */
  enableCacheFallback?: boolean;
  /** Model version used as part of the cache key; changing it invalidates entries. */
  modelVersion?: string;
  /** Cache behaviour; built-in defaults are used when omitted. */
  cacheConfig?: VeniceCacheConfig;
  /** Inject a custom cache (mainly for tests). */
  cache?: VeniceResponseCache;
  /** Inject a custom deduplicator (mainly for tests). */
  deduplicator?: RequestDeduplicator;
  /** Inject a custom key-health store (mainly for tests); defaults to the process-wide one. */
  keyHealth?: VeniceKeyHealthStore;

  // ── Circuit breaker tuning (issue #495) ───────────────────────────────────
  /**
   * Consecutive failures that open the circuit. Only used when no
   * `circuitBreaker` instance is injected. Default: 3 (env
   * `VENICE_CIRCUIT_FAILURE_THRESHOLD`).
   */
  failureThreshold?: number;
  /** How long the circuit stays `OPEN` before probing. Default: 60_000 (env `VENICE_CIRCUIT_COOLDOWN_MS`). */
  cooldownMs?: number;
  /** Concurrent probes admitted while `HALF_OPEN`. Default: 1 (env `VENICE_CIRCUIT_PROBE_COUNT`). */
  probeCount?: number;
  /** Notified on every `opened` / `closed` / `half_opened` transition. */
  onCircuitStateChange?: (transition: CircuitTransition) => void;
}

export interface VeniceClientLike {
  getModelFor(agentType: AgentType): string;
  getCircuitState(): CircuitState;
  getFailureCount(): number;
  /** Full breaker observability: `{ state, failures, successes, lastFailureAt, lastSuccessAt }`. */
  getCircuitMetrics(): CircuitMetrics;
  chat(messages: VeniceMessage[], options?: VeniceChatOptions): Promise<string>;
  complete(prompt: string, agentType: AgentType, options?: CompleteOptions): Promise<string>;
  stream(
    prompt: string,
    agentType: AgentType,
    onChunk: (chunk: string) => void,
    options?: CompleteOptions
  ): Promise<void>;
}
