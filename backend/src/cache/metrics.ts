/**
 * Registry cache hit-rate and staleness counters.
 *
 * Issue #427 — acceptance criteria:
 *   "Cache hit rate reported in metrics."
 *   "Updates invalidate within one TTL."
 *
 * Counters are intentionally in-process integers — no external dependency.
 * The health dashboard consumes them via {@link getCacheMetrics}.
 *
 * All counters reset when the process restarts.  For persistent metrics export
 * (Prometheus, CloudWatch) wire `getCacheMetrics()` into your exporter.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A snapshot of cache activity since process start. */
export interface CacheMetrics {
  /** Number of successful cache reads. */
  hits: number;
  /** Number of cache misses that fell through to the DB / upstream. */
  misses: number;
  /** Number of requests that bypassed the cache (bypass header or TTL=0). */
  bypasses: number;
  /**
   * Number of times a cached entry was considered stale (served past its
   * ideal TTL while a background refresh was in flight). This counter
   * increments when a HIT is served with a key whose staleness flag has been
   * set by {@link markStale}.
   */
  staleHits: number;
  /** Number of times the cache was explicitly invalidated. */
  invalidations: number;
  /**
   * Hit rate as a fraction in `[0, 1]`.  Returns `0` when no requests have
   * been recorded yet.
   */
  hitRate: number;
}

// ---------------------------------------------------------------------------
// Mutable counters (module-level singletons, reset on process restart)
// ---------------------------------------------------------------------------

let _hits = 0;
let _misses = 0;
let _bypasses = 0;
let _staleHits = 0;
let _invalidations = 0;

/** The set of cache keys currently marked as stale (background refresh pending). */
const _staleKeys = new Set<string>();

// ---------------------------------------------------------------------------
// Mutators — called by cache middleware and invalidation helpers
// ---------------------------------------------------------------------------

/** Record a cache hit. */
export function recordHit(cacheKey?: string): void {
  _hits++;
  if (cacheKey && _staleKeys.has(cacheKey)) {
    _staleHits++;
    _staleKeys.delete(cacheKey);
  }
}

/** Record a cache miss (fell through to origin). */
export function recordMiss(): void {
  _misses++;
}

/** Record a bypass (header or TTL=0). */
export function recordBypass(): void {
  _bypasses++;
}

/** Record a cache invalidation sweep. */
export function recordInvalidation(): void {
  _invalidations++;
}

/**
 * Flag a key as stale so the next hit for it increments `staleHits`.
 * Call this when you know a registry sync has invalidated the underlying data
 * but the cached entry has not yet been evicted.
 */
export function markStale(cacheKey: string): void {
  _staleKeys.add(cacheKey);
}

// ---------------------------------------------------------------------------
// Snapshot reader
// ---------------------------------------------------------------------------

/**
 * Returns a point-in-time snapshot of all cache counters.
 * Suitable for serialisation into JSON (health dashboard, metrics endpoints).
 */
export function getCacheMetrics(): CacheMetrics {
  const total = _hits + _misses;
  return {
    hits: _hits,
    misses: _misses,
    bypasses: _bypasses,
    staleHits: _staleHits,
    invalidations: _invalidations,
    hitRate: total === 0 ? 0 : _hits / total,
  };
}

/** Reset all counters — used in tests only. */
export function resetCacheMetrics(): void {
  _hits = 0;
  _misses = 0;
  _bypasses = 0;
  _staleHits = 0;
  _invalidations = 0;
  _staleKeys.clear();
}
