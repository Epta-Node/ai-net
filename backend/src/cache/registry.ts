/**
 * Registry-specific cache layer.
 *
 * Issue #427 — TTL cache for agent listings / capabilities, invalidation on
 * heartbeat / update, staleness metrics, keyed cache prefix per deployment.
 *
 * ## Deployment-keyed prefix
 *
 * Every cache key produced by this module is prefixed with the value of
 * `REGISTRY_CACHE_KEY_PREFIX` (env var, default `"registry"`).  Separating
 * per-deployment keys prevents stale cross-environment cache collisions when
 * multiple deployments share the same Redis instance.
 *
 * Example:  `registry:agents:list:noquery`
 *           `staging:agents:list:abc12345`
 *
 * ## Usage
 *
 * ```ts
 * // read-path
 * const cached = await getRegistryCache<Agent[]>('list', {});
 * if (!cached) { ... fetch from DB ... await setRegistryCache('list', {}, agents); }
 *
 * // write-path (heartbeat / register / delete)
 * await invalidateRegistryCache();
 * ```
 */

import { createHash } from 'crypto';
import { getCacheClient } from './index';
import { recordInvalidation, markStale } from './metrics';
import { createLogger } from '../utils/logger';

const logger = createLogger({ module: 'registry-cache' });

// ---------------------------------------------------------------------------
// Deployment-keyed prefix
// ---------------------------------------------------------------------------

/**
 * Returns the deployment-specific cache key prefix.
 * Reads `REGISTRY_CACHE_KEY_PREFIX` at call-time so tests can override it via
 * `process.env` without restarting the module.
 */
export function getRegistryCachePrefix(): string {
  return process.env.REGISTRY_CACHE_KEY_PREFIX ?? 'registry';
}

// ---------------------------------------------------------------------------
// Key builder
// ---------------------------------------------------------------------------

/**
 * Build a registry cache key:
 *   `{prefix}:agents:{segment}:{queryHash}`
 *
 * @param segment - A logical route segment, e.g. `"list"` or `"item"`.
 * @param query   - Query/filter parameters that affect the result set.
 */
export function buildRegistryCacheKey(
  segment: 'list' | 'item',
  query: Record<string, unknown> = {},
): string {
  const prefix = getRegistryCachePrefix();
  const sorted = Object.keys(query)
    .sort()
    .map((k) => `${k}=${query[k]}`)
    .join('&');
  const queryHash = sorted
    ? createHash('sha256').update(sorted).digest('hex').slice(0, 8)
    : 'noquery';
  return `${prefix}:agents:${segment}:${queryHash}`;
}

/**
 * Build the glob pattern used to wipe all keys for the current deployment.
 *   e.g. `registry:agents:*`
 */
export function buildRegistryInvalidationPattern(): string {
  return `${getRegistryCachePrefix()}:agents:*`;
}

// ---------------------------------------------------------------------------
// Typed read / write helpers
// ---------------------------------------------------------------------------

/**
 * Attempt to fetch a typed value from the registry cache.
 *
 * @returns The parsed value, or `undefined` on a miss or deserialisation error.
 */
export async function getRegistryCache<T>(
  segment: 'list' | 'item',
  query: Record<string, unknown> = {},
): Promise<T | undefined> {
  const key = buildRegistryCacheKey(segment, query);
  try {
    const raw = await getCacheClient().get(key);
    if (raw === undefined) return undefined;
    return JSON.parse(raw) as T;
  } catch (err) {
    logger.warn({ err, key }, '[registry-cache] get error');
    return undefined;
  }
}

/**
 * Store a typed value in the registry cache.
 *
 * @param ttlSeconds - Per-item TTL in seconds.
 */
export async function setRegistryCache<T>(
  segment: 'list' | 'item',
  query: Record<string, unknown>,
  value: T,
  ttlSeconds: number,
): Promise<void> {
  const key = buildRegistryCacheKey(segment, query);
  try {
    await getCacheClient().set(key, JSON.stringify(value), ttlSeconds);
  } catch (err) {
    logger.warn({ err, key }, '[registry-cache] set error');
  }
}

// ---------------------------------------------------------------------------
// Invalidation
// ---------------------------------------------------------------------------

/**
 * Invalidate **all** registry cache entries for the current deployment.
 *
 * Call after any mutation that changes the agent list:
 *   - `POST /api/agents/register`
 *   - `POST /api/agents/:id/heartbeat`
 *   - `DELETE /api/agents/:id`
 *   - On-chain sync events (`agent_reg`, `agent_drg`, `freeze`, `unfreeze`, `price_upd`)
 *
 * The function is intentionally best-effort: a cache error never blocks the
 * mutation.  The counter is incremented regardless of errors so operators can
 * detect repeated failures in the metrics.
 */
export async function invalidateRegistryCache(): Promise<void> {
  const pattern = buildRegistryInvalidationPattern();
  try {
    await getCacheClient().delByPattern(pattern);
    recordInvalidation();
    logger.debug({ pattern }, '[registry-cache] invalidated');
  } catch (err) {
    // Record the attempt even on error so the dashboard counter reflects intent
    recordInvalidation();
    logger.warn({ err, pattern }, '[registry-cache] invalidation error');
  }
}

/**
 * Mark a specific registry cache key as stale.
 *
 * Use this when you know the underlying data has changed but the cached entry
 * has not yet been evicted (e.g. between receiving a heartbeat and the TTL
 * expiring).  The next HIT for the key will increment the `staleHits` counter.
 *
 * @param segment - Same segment used when the key was written.
 * @param query   - Same query parameters used when the key was written.
 */
export function markRegistryCacheStale(
  segment: 'list' | 'item',
  query: Record<string, unknown> = {},
): void {
  const key = buildRegistryCacheKey(segment, query);
  markStale(key);
}
