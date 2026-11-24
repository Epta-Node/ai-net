import {
  recordJobProcessed,
  getQueueWorkerMetricsSnapshot,
  resetQueueWorkerMetrics,
} from "./metrics";



describe("Queue worker metrics", () => {
  beforeEach(() => {
    resetQueueWorkerMetrics();
  });

  it("records completed processing attempts", () => {
    recordJobProcessed(25);
    recordJobProcessed(50);

    const snapshot = getQueueWorkerMetricsSnapshot();

    expect(snapshot.jobsProcessed).toBe(2);
    expect(snapshot.jobProcessingDurationCount).toBe(2);
    expect(snapshot.jobProcessingDurationSum).toBe(75);
  });

  it("records duration in the correct histogram buckets", () => {
    recordJobProcessed(3);
    recordJobProcessed(8);
    recordJobProcessed(12000);

    const snapshot = getQueueWorkerMetricsSnapshot();

    expect(snapshot.jobProcessingDurationBuckets[0]).toBe(1);
    expect(snapshot.jobProcessingDurationBuckets[1]).toBe(1);
    expect(snapshot.jobProcessingDurationOverflow).toBe(1);
  });

  it("does not record negative durations", () => {
    recordJobProcessed(-10);

    const snapshot = getQueueWorkerMetricsSnapshot();

    expect(snapshot.jobsProcessed).toBe(1);
    expect(snapshot.jobProcessingDurationSum).toBe(0);
    expect(snapshot.jobProcessingDurationBuckets[0]).toBe(1);
  });

  it("resets all metrics", () => {
    recordJobProcessed(100);
    resetQueueWorkerMetrics();

    const snapshot = getQueueWorkerMetricsSnapshot();

    expect(snapshot.jobsProcessed).toBe(0);
    expect(snapshot.jobProcessingDurationCount).toBe(0);
    expect(snapshot.jobProcessingDurationSum).toBe(0);
    expect(snapshot.jobProcessingDurationBuckets.every((count) => count === 0)).toBe(true);
    expect(snapshot.jobProcessingDurationOverflow).toBe(0);
  });
});