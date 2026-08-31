/**
 * Cache invalidation helpers.
 *
 * Issue #263 — acceptance criterion:
 *   "Cache invalidation on data mutations (agent registration, task creation)"
 *
 * Call the appropriate invalidator from any mutation handler (POST, PUT, DELETE).
 * All invalidators use `delByPattern` so they sweep every variant (different
 * query strings) of the affected route family.
 *
 * Pattern convention:   api:GET:{prefix}*
 */

import { getCacheClient } from './index';

// ---------------------------------------------------------------------------
// Route-family constants
// ---------------------------------------------------------------------------

export const CACHE_PREFIX = {
  AGENTS: 'api:GET:/api/agents',
  STATS: 'api:GET:/api/stats',
  HEALTH: 'api:GET:/api/health',
} as const;

// ---------------------------------------------------------------------------
// Invalidators
// ---------------------------------------------------------------------------

/**
 * Bust all cached GET /api/agents responses.
 * Call after:  POST /api/agents/register, DELETE /api/agents/:id, reputation updates
 */
export async function invalidateAgentsCache(): Promise<void> {
  await getCacheClient().delByPattern(`${CACHE_PREFIX.AGENTS}*`);
}

/**
 * Bust all cached GET /api/stats responses.
 * Call after:  task creation, task completion, payment events
 */
export async function invalidateStatsCache(): Promise<void> {
  await getCacheClient().delByPattern(`${CACHE_PREFIX.STATS}*`);
}

/**
 * Bust all cached GET /api/health responses.
 * Typically not needed (health is short-lived) but exposed for completeness.
 */
export async function invalidateHealthCache(): Promise<void> {
  await getCacheClient().delByPattern(`${CACHE_PREFIX.HEALTH}*`);
}

/**
 * Convenience: invalidate both agents and stats at once.
 * Call after agent registration (affects both agent list and stats.totalAgents).
 */
export async function invalidateOnAgentRegistration(): Promise<void> {
  await Promise.all([invalidateAgentsCache(), invalidateStatsCache()]);
}

/**
 * Convenience: invalidate stats when a task is created or completed.
 */
export async function invalidateOnTaskMutation(): Promise<void> {
  await invalidateStatsCache();
}

/**
 * Nuke the entire cache — useful in tests or emergency admin reset.
 */
export async function flushAllCaches(): Promise<void> {
  await getCacheClient().flush();
}
