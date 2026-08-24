import { createHash } from 'node:crypto';
import { createLogger } from '../../utils/logger.js';
import type { AgentType } from './types.js';

const log = createLogger({ module: 'VeniceCache' });

export interface CachedEntry {
  key: string;
  prompt: string;
  agentType: string;
  modelVersion: string;
  content: string;
  createdAt: number;
  expiresAt: number;
}

export interface VeniceCacheOptions {
  /** TTL for non-coding agents (research/design/risk/report). */
  defaultTtlMs: number;
  /** TTL for the coding agent (more volatile). */
  codingTtlMs: number;
  /** Minimum similarity score (0..1) for a fuzzy cache hit. */
  similarityThreshold: number;
}

const DEFAULT_OPTIONS: VeniceCacheOptions = {
  defaultTtlMs: 24 * 60 * 60 * 1000,
  codingTtlMs: 60 * 60 * 1000,
  similarityThreshold: 0.8,
};

export function normalizePrompt(prompt: string): string {
  return prompt.trim().replace(/\s+/g, ' ').toLowerCase();
}

export function hashPrompt(prompt: string): string {
  return createHash('sha256').update(normalizePrompt(prompt)).digest('hex').slice(0, 32);
}

/** Cache key = prompt hash + agent type + model version (per the issue spec). */
export function buildCacheKey(prompt: string, agentType: string, modelVersion: string): string {
  return `${agentType}:${modelVersion}:${hashPrompt(prompt)}`;
}

function tokenize(text: string): Set<string> {
  return new Set(text.split(/[^a-z0-9]+/i).filter((t) => t.length > 1));
}

/**
 * Lightweight lexical similarity (Dice coefficient over token sets). This stands
 * in for "semantic similarity" so that near-duplicate prompts (minor edits,
 * whitespace/typo differences) still hit the cache without requiring an
 * embedding model at request time.
 */
export function similarity(a: string, b: string): number {
  const na = normalizePrompt(a);
  const nb = normalizePrompt(b);
  if (na === nb) return 1;
  const ta = tokenize(na);
  const tb = tokenize(nb);
  // Both prompts consist only of short tokens (e.g. "x" vs "y") that get
  // filtered out: they are distinct, so they are not similar.
  if (ta.size === 0 && tb.size === 0) return 0;
  if (ta.size === 0 || tb.size === 0) return 0;
  let intersection = 0;
  for (const t of ta) {
    if (tb.has(t)) intersection++;
  }
  return (2 * intersection) / (ta.size + tb.size);
}

export class VeniceResponseCache {
  private readonly store = new Map<string, CachedEntry>();
  private hits = 0;
  private misses = 0;
  private readonly options: VeniceCacheOptions;

  constructor(options: Partial<VeniceCacheOptions> = {}) {
    this.options = { ...DEFAULT_OPTIONS, ...options };
  }

  private ttlFor(agentType: string): number {
    return agentType === 'coding' ? this.options.codingTtlMs : this.options.defaultTtlMs;
  }

  /**
   * Returns a cached response for the prompt, or null on a miss. First an exact
   * key match is attempted; if that misses, entries for the same agent/version
   * are scanned for a fuzzy (similarity) match above the configured threshold.
   */
  get(prompt: string, agentType: string, modelVersion: string): string | null {
    const now = Date.now();

    const exact = this.store.get(buildCacheKey(prompt, agentType, modelVersion));
    if (exact && exact.expiresAt > now) {
      this.recordHit();
      return exact.content;
    }

    const norm = normalizePrompt(prompt);
    let best: CachedEntry | null = null;
    let bestScore = 0;
    for (const entry of this.store.values()) {
      if (entry.agentType !== agentType) continue;
      if (entry.modelVersion !== modelVersion) continue;
      if (entry.expiresAt <= now) continue;
      const score = similarity(norm, entry.prompt);
      if (score >= this.options.similarityThreshold && score > bestScore) {
        bestScore = score;
        best = entry;
      }
    }

    if (best) {
      this.recordHit();
      return best.content;
    }

    this.recordMiss();
    return null;
  }

  set(prompt: string, agentType: string, modelVersion: string, content: string): void {
    const now = Date.now();
    const key = buildCacheKey(prompt, agentType, modelVersion);
    this.store.set(key, {
      key,
      prompt: normalizePrompt(prompt),
      agentType,
      modelVersion,
      content,
      createdAt: now,
      expiresAt: now + this.ttlFor(agentType),
    });
  }

  /** Drop all entries created under a given model version (invalidation on version change). */
  invalidateModelVersion(modelVersion: string): void {
    for (const [key, entry] of this.store) {
      if (entry.modelVersion === modelVersion) {
        this.store.delete(key);
      }
    }
  }

  invalidateAll(): void {
    this.store.clear();
  }

  getHitRate(): number {
    const total = this.hits + this.misses;
    return total === 0 ? 0 : this.hits / total;
  }

  get stats() {
    return { hits: this.hits, misses: this.misses, size: this.store.size, hitRate: this.getHitRate() };
  }

  private recordHit(): void {
    this.hits++;
    this.logHitRate('hit');
  }

  private recordMiss(): void {
    this.misses++;
    this.logHitRate('miss');
  }

  private logHitRate(outcome: 'hit' | 'miss'): void {
    // Sampled logging to keep noise down while still surfacing the hit rate.
    if ((this.hits + this.misses) % 100 === 0) {
      log.info({ outcome, ...this.stats }, 'venice cache');
    }
  }
}
