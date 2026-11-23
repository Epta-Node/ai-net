import type { EventStore } from "../events/eventStore";
import {
  EventRetentionService,
  getEventRetentionMetrics,
  resetEventRetentionMetrics,
} from "./eventRetention";

function makeStore(compact: () => unknown): EventStore {
  const archive = {
    findCompactionCandidates: jest.fn(() => [{ taskId: "task-1", lastEventType: "TaskCompleted" }]),
    compactTask: jest.fn(compact),
  };
  return { archive } as unknown as EventStore;
}

function makeService(store: EventStore): EventRetentionService {
  return new EventRetentionService({
    enabled: true,
    eventStore: store,
    getTaskStatus: () => "completed",
  });
}

describe("event retention metrics (#913)", () => {
  beforeEach(() => resetEventRetentionMetrics());

  it("starts with zeroed totals", () => {
    expect(getEventRetentionMetrics()).toEqual({
      passes: 0,
      compactedTasks: 0,
      eventsArchived: 0,
      eventsPurged: 0,
      failedTasks: 0,
    });
  });

  it("accumulates archived and purged event counts across passes", () => {
    const store = makeStore(() => ({
      compacted: true,
      eventsArchived: 3,
      eventsPurged: 3,
      summariesWritten: 1,
    }));
    const service = makeService(store);

    service.run();
    service.run();

    expect(getEventRetentionMetrics()).toEqual({
      passes: 2,
      compactedTasks: 2,
      eventsArchived: 6,
      eventsPurged: 6,
      failedTasks: 0,
    });
  });

  it("counts a rolled-back compaction as failed and records no purged events", () => {
    const store = makeStore(() => {
      throw new Error("archive read-back mismatch");
    });

    makeService(store).run();

    expect(getEventRetentionMetrics()).toEqual({
      passes: 1,
      compactedTasks: 0,
      eventsArchived: 0,
      eventsPurged: 0,
      failedTasks: 1,
    });
  });

  it("returns a copy so callers cannot change the totals", () => {
    const snapshot = getEventRetentionMetrics();
    snapshot.eventsPurged = 999;
    expect(getEventRetentionMetrics().eventsPurged).toBe(0);
  });
});
