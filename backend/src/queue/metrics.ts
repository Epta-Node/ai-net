const buckets = [5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000];

const metrics = {
  jobsProcessed: 0,
  jobProcessingDurationCount: 0,
  jobProcessingDurationSum: 0,
  jobProcessingDurationBuckets: buckets.map(() => 0),
  jobProcessingDurationOverflow: 0,
};

export function recordJobProcessed(durationMs: number): void {
  const duration = Math.max(0, durationMs);

  metrics.jobsProcessed += 1;
  metrics.jobProcessingDurationCount += 1;
  metrics.jobProcessingDurationSum += duration;

  const bucketIndex = buckets.findIndex((bucket) => duration <= bucket);

  if (bucketIndex === -1) {
    metrics.jobProcessingDurationOverflow += 1;
  } else {
    metrics.jobProcessingDurationBuckets[bucketIndex] += 1;
  }
}

export function getQueueWorkerMetricsSnapshot() {
  return {
    jobsProcessed: metrics.jobsProcessed,
    jobProcessingDurationCount: metrics.jobProcessingDurationCount,
    jobProcessingDurationSum: metrics.jobProcessingDurationSum,
    jobProcessingDurationBuckets: [...metrics.jobProcessingDurationBuckets],
    jobProcessingDurationOverflow: metrics.jobProcessingDurationOverflow,
    buckets: [...buckets],
  };
}

export function resetQueueWorkerMetrics(): void {
  metrics.jobsProcessed = 0;
  metrics.jobProcessingDurationCount = 0;
  metrics.jobProcessingDurationSum = 0;
  metrics.jobProcessingDurationBuckets = buckets.map(() => 0);
  metrics.jobProcessingDurationOverflow = 0;
}