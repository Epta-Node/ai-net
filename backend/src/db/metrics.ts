/**
 * Aggregated connection-pool metrics across every database the backend opens.
 *
 * Surfaced by the health dashboard so pool saturation is visible before it
 * turns into request timeouts: a rising `pendingAcquires` or any
 * `timedOutAcquires` means `DB_POOL_MAX` is too low for the offered load.
 */

import type { PoolMetrics } from "./pool";
import { currentPaymentPool } from "./index";
import { currentTaskPool } from "./tasks";
import { currentAgentPool } from "./agents";

/** Per-database metrics, keyed by database name. Absent pools are omitted. */
export type DatabasePoolMetrics = Record<string, PoolMetrics>;

/** Snapshot every open pool. Databases not yet opened are simply absent. */
export function databasePoolMetrics(): DatabasePoolMetrics {
  const metrics: DatabasePoolMetrics = {};

  const payments = currentPaymentPool();
  if (payments) metrics.payments = payments.metrics();

  const tasks = currentTaskPool();
  if (tasks) metrics.tasks = tasks.metrics();

  const agents = currentAgentPool();
  if (agents) metrics.agents = agents.metrics();

  return metrics;
}

/** True when no pool is saturated and none has timed out an acquire. */
export function poolsHealthy(metrics: DatabasePoolMetrics = databasePoolMetrics()): boolean {
  return Object.values(metrics).every(
    (m) => m.timedOutAcquires === 0 && m.pendingAcquires === 0,
  );
}
