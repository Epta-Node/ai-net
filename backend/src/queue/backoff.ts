/**
 * Full-jitter exponential backoff for failed jobs (issue #752).
 *
 * `delay = random(0, min(cap, base * 2^attempt))`. Without jitter, jobs that
 * fail during the same incident retry in lockstep and stampede the upstream.
 */

/** Default ceiling for a single retry delay: five minutes. */
export const DEFAULT_JOB_BACKOFF_MAX_MS = 300_000;

/** Source of randomness in `[0, 1)`; injectable so tests are deterministic. */
export type RandomFn = () => number;

/**
 * Upper bound (exclusive of jitter) of the delay window after `attempt`
 * failed attempts. `attempt` is 1 after the first failure.
 */
export function backoffCeilingMs(attempt: number, baseMs: number, capMs: number): number {
  const exponent = Math.max(0, attempt - 1);
  return Math.min(capMs, baseMs * Math.pow(2, exponent));
}

/** Full-jitter delay in milliseconds, uniformly drawn from `[0, ceiling)`. */
export function computeBackoffDelayMs(
  attempt: number,
  baseMs: number,
  capMs: number = DEFAULT_JOB_BACKOFF_MAX_MS,
  random: RandomFn = Math.random
): number {
  return Math.floor(random() * backoffCeilingMs(attempt, baseMs, capMs));
}

/** Process-wide counters for retry behaviour, rendered by `/metrics`. */
export interface QueueRetryMetrics {
  retriesTotal: number;
  deadLetterTotal: number;
  /** Sum of (actual start - scheduled retry time), in ms, over retried runs. */
  retryLagMsSum: number;
  /** Number of retried runs that contributed to `retryLagMsSum`. */
  retryLagCount: number;
}

const retryMetrics: QueueRetryMetrics = {
  retriesTotal: 0,
  deadLetterTotal: 0,
  retryLagMsSum: 0,
  retryLagCount: 0,
};

export function recordJobRetry(): void {
  retryMetrics.retriesTotal++;
}

export function recordJobDeadLetter(): void {
  retryMetrics.deadLetterTotal++;
}

export function recordRetryLag(lagMs: number): void {
  retryMetrics.retryLagMsSum += Math.max(0, lagMs);
  retryMetrics.retryLagCount++;
}

export function getQueueRetryMetrics(): Readonly<QueueRetryMetrics> {
  return { ...retryMetrics };
}

/** Test helper: zero all counters. */
export function resetQueueRetryMetrics(): void {
  retryMetrics.retriesTotal = 0;
  retryMetrics.deadLetterTotal = 0;
  retryMetrics.retryLagMsSum = 0;
  retryMetrics.retryLagCount = 0;
}
