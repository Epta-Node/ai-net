/**
 * Content-addressed cache for agent quality scores (issue #812).
 *
 * Scoring the same output against the same rules and prompt always produces
 * the same result, so repeated (templated) outputs are answered from memory
 * instead of being re-scored. Entries are bounded by an LRU limit and expire
 * after a TTL; the LRU structure comes from the `lru-cache` dependency the
 * backend already uses.
 *
 * Key: SHA-256 over the rules identity, the prompt, and the output with
 * surrounding whitespace trimmed. Case is kept, because the completeness and
 * format checks look at schema keys, which are case-sensitive.
 */

import { createHash } from 'crypto';
import { LRUCache } from 'lru-cache';
import type { QualityScore, QualityScoringRules } from './qualityScorer.types';

export interface QualityScoreCacheOptions {
  /** When false, every lookup misses and nothing is stored. */
  enabled: boolean;
  /** How long an entry stays valid, in ms. */
  ttlMs: number;
  /** Maximum entries before the least recently used one is evicted. */
  maxEntries: number;
}

export interface QualityScoreCacheStats {
  size: number;
  hits: number;
  misses: number;
  /** Cumulative hits / (hits + misses); 0 before the first lookup. */
  hitRate: number;
}

/** Process-wide totals read by the Prometheus collector. */
let totalHits = 0;
let totalMisses = 0;
let activeCache: QualityScoreCache | null = null;

export function getQualityScoreCacheTotals(): { hits: number; misses: number; size: number } {
  return { hits: totalHits, misses: totalMisses, size: activeCache?.stats().size ?? 0 };
}

/**
 * Process-local identity for a rules object. Lets the key distinguish two
 * rule sets that share an agent type without serialising schemas.
 */
const ruleIds = new WeakMap<object, number>();
let nextRuleId = 1;

function ruleIdOf(rules: object): number {
  let id = ruleIds.get(rules);
  if (id === undefined) {
    id = nextRuleId;
    nextRuleId += 1;
    ruleIds.set(rules, id);
  }
  return id;
}

/** Deep copy so callers can't mutate the cached entry. */
function cloneScore(score: QualityScore): QualityScore {
  return JSON.parse(JSON.stringify(score)) as QualityScore;
}

export class QualityScoreCache {
  private readonly entries: LRUCache<string, QualityScore> | null;
  private hits = 0;
  private misses = 0;

  constructor(options: QualityScoreCacheOptions) {
    this.entries = options.enabled
      ? new LRUCache<string, QualityScore>({ max: options.maxEntries, ttl: options.ttlMs })
      : null;
    activeCache = this;
  }

  get enabled(): boolean {
    return this.entries !== null;
  }

  /**
   * Cache key for one scoring call, or `undefined` when the call cannot be
   * cached (caching disabled, or the output cannot be serialised).
   */
  keyFor(rules: QualityScoringRules, prompt: string | undefined, output: unknown): string | undefined {
    if (!this.entries) return undefined;
    try {
      const body = typeof output === 'string' ? output.trim() : (JSON.stringify(output) ?? 'undefined');
      return createHash('sha256')
        .update(JSON.stringify([ruleIdOf(rules), prompt ?? '', body]))
        .digest('hex');
    } catch {
      return undefined;
    }
  }

  /** Look up a score. Counts a hit or a miss; returns a copy on hit. */
  lookup(key: string): QualityScore | undefined {
    const cached = this.entries?.get(key);
    if (cached === undefined) {
      this.misses += 1;
      totalMisses += 1;
      return undefined;
    }
    this.hits += 1;
    totalHits += 1;
    return cloneScore(cached);
  }

  /** Store a score under a key from {@link keyFor}. */
  store(key: string, score: QualityScore): void {
    this.entries?.set(key, cloneScore(score));
  }

  /** Drop every entry. Hit and miss counters are kept. */
  clear(): void {
    this.entries?.clear();
  }

  stats(): QualityScoreCacheStats {
    const lookups = this.hits + this.misses;
    return {
      size: this.entries?.size ?? 0,
      hits: this.hits,
      misses: this.misses,
      hitRate: lookups === 0 ? 0 : this.hits / lookups,
    };
  }
}
