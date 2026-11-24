/**
 * Backpressure and stale-connection handling for GET /api/tasks/:id/events/stream (#813).
 *
 * The handler is called directly with a fake request and response, so the test
 * controls exactly when the socket "accepts" a write (`write()` return value and
 * `writableLength`) and advances the clock with fake timers.
 */
import { EventEmitter } from "events";
import type { NextFunction, Request, Response } from "express";
import type { StoredEvent } from "../../events/eventStore";
import type { Task } from "../../types/task";
import { setFlag } from "../../services/featureFlags";
import { getSseMetricsSnapshot, resetSseMetrics } from "../../services/sseMetrics";
import type { TaskStreamHub } from "./taskStreamHub";
import { createTaskEventsSseHandler } from "./taskEventsSse";

const WALLET = "GOWNER";
const TASK = { id: "task_1", walletPublicKey: WALLET } as unknown as Task;
const HIGH_WATER_MARK = 65_536;

class FakeResponse extends EventEmitter {
  statusCode = 0;
  chunks: string[] = [];
  /** Bytes the socket reports as buffered. */
  writableLength = 0;
  /** What `write()` returns: `false` simulates a socket that is not draining. */
  accept = true;
  ended = false;

  status(code: number): this {
    this.statusCode = code;
    return this;
  }

  set(): this {
    return this;
  }

  flushHeaders(): void {}

  write(chunk: string): boolean {
    this.chunks.push(chunk);
    return this.accept;
  }

  end(): void {
    this.ended = true;
  }
}

class FakeHub {
  deliver: ((event: StoredEvent) => void) | undefined;
  unsubscribed = false;

  subscribe(_taskId: string, _opts: unknown, deliver: (event: StoredEvent) => void): () => void {
    this.deliver = deliver;
    return () => {
      this.unsubscribed = true;
    };
  }

  flush(): void {}
}

function fakeRequest(): Request {
  return {
    params: { id: TASK.id },
    headers: { walletpublickey: WALLET },
    query: {},
    ip: "10.0.0.1",
    socket: { remoteAddress: "10.0.0.1" },
  } as unknown as Request;
}

/** A stored event with the minimum fields the wire conversion reads. */
function storedEvent(taskSeq: number): StoredEvent {
  return {
    taskSeq,
    globalSeq: taskSeq,
    taskId: TASK.id,
    type: "TaskCreated",
    occurredAt: "2026-10-18T00:00:00.000Z",
    version: 1,
  } as unknown as StoredEvent;
}

interface OpenStream {
  res: FakeResponse;
  hub: FakeHub;
}

function openStream(options: { heartbeatIntervalMs: number; staleTimeoutMs: number }): OpenStream {
  const hub = new FakeHub();
  const handler = createTaskEventsSseHandler({
    hub: hub as unknown as TaskStreamHub,
    getTask: () => TASK,
    highWaterMarkBytes: HIGH_WATER_MARK,
    ...options,
  });
  const res = new FakeResponse();
  const next: NextFunction = (err) => {
    if (err) throw err;
  };
  handler(fakeRequest(), res as unknown as Response, next);
  return { res, hub };
}

describe("task event SSE backpressure and stale connections (#813)", () => {
  beforeAll(() => {
    process.env.VENICE_API_KEY = process.env.VENICE_API_KEY || "test-venice-key";
    process.env.DATABASE_URL = process.env.DATABASE_URL || ":memory:";
    setFlag("streaming_responses", true);
  });

  afterAll(() => {
    setFlag("streaming_responses", null);
  });

  beforeEach(() => {
    resetSseMetrics();
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it("writes events to a client that keeps up and counts them", () => {
    const { res, hub } = openStream({ heartbeatIntervalMs: 60_000, staleTimeoutMs: 120_000 });

    hub.deliver?.(storedEvent(1));

    expect(res.chunks).toHaveLength(1);
    expect(res.chunks[0]).toMatch(/^id: \d+\n/);
    expect(getSseMetricsSnapshot()).toMatchObject({ activeConnections: 1, eventsSent: 1, eventsDropped: 0 });
  });

  it("drops events once the socket buffer passes the high-water mark, and counts the drops", () => {
    const { res, hub } = openStream({ heartbeatIntervalMs: 60_000, staleTimeoutMs: 120_000 });
    res.writableLength = HIGH_WATER_MARK + 1;

    hub.deliver?.(storedEvent(1));
    hub.deliver?.(storedEvent(2));

    expect(res.chunks).toHaveLength(0);
    expect(getSseMetricsSnapshot()).toMatchObject({ eventsSent: 0, eventsDropped: 2 });
  });

  it("closes a stalled stream with stream_timeout and counts it", () => {
    const { res, hub } = openStream({ heartbeatIntervalMs: 1_000, staleTimeoutMs: 3_000 });
    // The client has stopped reading, so no write is accepted from now on.
    res.accept = false;

    jest.advanceTimersByTime(4_000);

    expect(res.chunks.some((chunk) => chunk.startsWith("event: stream_timeout\n"))).toBe(true);
    expect(res.ended).toBe(true);
    expect(hub.unsubscribed).toBe(true);
    expect(getSseMetricsSnapshot()).toMatchObject({ connectionsTimedOut: 1, activeConnections: 0 });
  });

  it("keeps a healthy idle stream open through heartbeats", () => {
    const { res } = openStream({ heartbeatIntervalMs: 1_000, staleTimeoutMs: 3_000 });

    jest.advanceTimersByTime(10_000);

    expect(res.ended).toBe(false);
    expect(res.chunks.filter((chunk) => chunk === ": keep-alive\n\n").length).toBeGreaterThan(0);
    expect(getSseMetricsSnapshot()).toMatchObject({ connectionsTimedOut: 0, activeConnections: 1 });
  });

  it("decrements the active connection gauge when the client disconnects", () => {
    const { res } = openStream({ heartbeatIntervalMs: 60_000, staleTimeoutMs: 120_000 });
    expect(getSseMetricsSnapshot().activeConnections).toBe(1);

    res.emit("close");

    expect(getSseMetricsSnapshot().activeConnections).toBe(0);
  });
});
