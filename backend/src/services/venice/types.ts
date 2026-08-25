import type { CircuitBreaker } from '../../venice/circuitBreaker.js';
import type { VeniceResponseCache } from './cache.js';
import type { RequestDeduplicator } from './dedup.js';

export type AgentType = 'research' | 'risk' | 'coding' | 'design' | 'report';

export interface CompleteOptions {
  maxTokens?: number;
  temperature?: number;
  /** Bypass the response cache (both read and write) when true. */
  force?: boolean;
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

export interface VeniceClientConfig {
  apiKey: string;
  baseUrl?: string;
  circuitBreaker?: CircuitBreaker;
  /** Model version used as part of the cache key; changing it invalidates entries. */
  modelVersion?: string;
  /** Cache behaviour; built-in defaults are used when omitted. */
  cacheConfig?: VeniceCacheConfig;
  /** Inject a custom cache (mainly for tests). */
  cache?: VeniceResponseCache;
  /** Inject a custom deduplicator (mainly for tests). */
  deduplicator?: RequestDeduplicator;
}

export interface VeniceClientLike {
  getModelFor(agentType: AgentType): string;
  getCircuitState(): unknown;
  getFailureCount(): number;
  chat(messages: VeniceMessage[], options?: VeniceChatOptions): Promise<string>;
  complete(prompt: string, agentType: AgentType, options?: CompleteOptions): Promise<string>;
  stream(
    prompt: string,
    agentType: AgentType,
    onChunk: (chunk: string) => void,
    options?: CompleteOptions
  ): Promise<void>;
}
