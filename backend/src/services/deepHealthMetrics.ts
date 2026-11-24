/**
 * Prometheus telemetry for the deep health probe (Issue #919).
 *
 *  • `ainet_deep_health_check_duration_seconds{check="…"}` — histogram of each
 *    sub-check's latency (venice, horizon, database, queue).
 *  • `ainet_deep_health_duration_seconds` — summary of the whole probe
 *    (`_sum` and `_count`), so operators can see total probe cost over time.
 *
 * Cardinality: the `check` label only accepts the fixed names in
 * {@link DEEP_HEALTH_CHECKS}. Any other name is ignored, so a future caller
 * cannot add unbounded series by accident.
 */

/** Sub-checks run by `runDeepHealthCheck`. Fixed set: it bounds the `check` label. */
export const DEEP_HEALTH_CHECKS = ['venice', 'horizon', 'database', 'queue'] as const;
export type DeepHealthCheckName = (typeof DEEP_HEALTH_CHECKS)[number];

/** Upper bounds in seconds. Probes time out well before 10 s, so the top bucket is generous. */
export const DEEP_HEALTH_LATENCY_BUCKETS: readonly number[] = [
  0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10,
];

export const DEEP_HEALTH_CHECK_METRIC = 'ainet_deep_health_check_duration_seconds';
export const DEEP_HEALTH_TOTAL_METRIC = 'ainet_deep_health_duration_seconds';

interface CheckHistogram {
  /** Non-cumulative counts, one per bound in DEEP_HEALTH_LATENCY_BUCKETS. */
  bucketCounts: number[];
  sum: number;
  count: number;
}

function emptyHistogram(): CheckHistogram {
  return { bucketCounts: DEEP_HEALTH_LATENCY_BUCKETS.map(() => 0), sum: 0, count: 0 };
}

/** Converts a measured duration in milliseconds to seconds; bad input records as zero. */
export function millisToSeconds(ms: number): number {
  return Number.isFinite(ms) && ms > 0 ? ms / 1000 : 0;
}

export class DeepHealthMetricsRegistry {
  private readonly checks = new Map<DeepHealthCheckName, CheckHistogram>(
    DEEP_HEALTH_CHECKS.map((name) => [name, emptyHistogram()]),
  );
  private totalSum = 0;
  private totalCount = 0;

  /** Records one sub-check duration. Unknown check names are ignored. */
  observeCheck(name: string, seconds: number): void {
    const histogram = this.checks.get(name as DeepHealthCheckName);
    if (!histogram) return;
    const value = Number.isFinite(seconds) && seconds > 0 ? seconds : 0;
    histogram.count += 1;
    histogram.sum += value;
    const index = DEEP_HEALTH_LATENCY_BUCKETS.findIndex((bound) => value <= bound);
    if (index >= 0) histogram.bucketCounts[index] += 1;
  }

  /** Records the wall-clock time of one whole probe. */
  observeTotal(seconds: number): void {
    this.totalCount += 1;
    this.totalSum += Number.isFinite(seconds) && seconds > 0 ? seconds : 0;
  }

  reset(): void {
    for (const name of DEEP_HEALTH_CHECKS) this.checks.set(name, emptyHistogram());
    this.totalSum = 0;
    this.totalCount = 0;
  }

  /** Prometheus text exposition. Every check is emitted on every scrape so the series set is stable. */
  render(): string {
    const lines: string[] = [];
    lines.push(`# HELP ${DEEP_HEALTH_CHECK_METRIC} Latency of each deep health sub-check`);
    lines.push(`# TYPE ${DEEP_HEALTH_CHECK_METRIC} histogram`);
    for (const name of DEEP_HEALTH_CHECKS) {
      const histogram = this.checks.get(name) ?? emptyHistogram();
      let cumulative = 0;
      DEEP_HEALTH_LATENCY_BUCKETS.forEach((bound, index) => {
        cumulative += histogram.bucketCounts[index];
        lines.push(`${DEEP_HEALTH_CHECK_METRIC}_bucket{check="${name}",le="${bound}"} ${cumulative}`);
      });
      lines.push(`${DEEP_HEALTH_CHECK_METRIC}_bucket{check="${name}",le="+Inf"} ${histogram.count}`);
      lines.push(`${DEEP_HEALTH_CHECK_METRIC}_sum{check="${name}"} ${round(histogram.sum)}`);
      lines.push(`${DEEP_HEALTH_CHECK_METRIC}_count{check="${name}"} ${histogram.count}`);
    }
    lines.push(`# HELP ${DEEP_HEALTH_TOTAL_METRIC} Total wall-clock time of each deep health probe`);
    lines.push(`# TYPE ${DEEP_HEALTH_TOTAL_METRIC} summary`);
    lines.push(`${DEEP_HEALTH_TOTAL_METRIC}_sum ${round(this.totalSum)}`);
    lines.push(`${DEEP_HEALTH_TOTAL_METRIC}_count ${this.totalCount}`);
    return lines.join('\n') + '\n';
  }
}

function round(value: number): number {
  return Math.round(value * 1e6) / 1e6;
}

let registry: DeepHealthMetricsRegistry | null = null;

/** Process-wide deep health registry. */
export function deepHealthMetricsRegistry(): DeepHealthMetricsRegistry {
  registry ??= new DeepHealthMetricsRegistry();
  return registry;
}

/** Clears recorded values (used by the metrics reset endpoint and tests). */
export function resetDeepHealthMetrics(): void {
  deepHealthMetricsRegistry().reset();
}
