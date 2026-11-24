/**
 * TaskStreamHub — shared per-task fan-out for the WebSocket stream (#655).
 *
 * These use an array-backed store and an `EventEmitter`-backed bus rather than
 * SQLite, because the hub's contract is about paging and fan-out, not SQL. The
 * real `EventBus.subscribe` is a two-line `on`/`off`, so an `EventEmitter` is a
 * faithful stand-in for the listener behaviour under test.
 */

import { EventEmitter } from 'events';
import { execFileSync } from 'child_process';
import { join } from 'path';
import { describe, it, expect } from '@jest/globals';
import type { DAGEvent } from '../../types/task';
import type { StoredEvent } from '../../events/eventStore';
import { TaskStreamHub, type TaskStreamBus } from './taskStreamHub';

/**
 * Run `tests/fixtures/listenerWarningCheck.ts` in a real Node process and parse
 * its two report lines. Kept out of Jest because its `warning` handling hides
 * MaxListenersExceededWarning from in-test listeners.
 */
function runListenerWarningCheck(): {
  hubWarnings: number;
  hubListeners: number;
  hubBusSubscriptions: number;
  subscribers: number;
  perClientWarnings: number;
  perClientListeners: number;
} {
  const backendRoot = join(__dirname, '../../..');
  const script = join(backendRoot, 'tests/fixtures/listenerWarningCheck.ts');
  const tsNodeBin = require.resolve('ts-node/dist/bin.js');
  const stdout = execFileSync(process.execPath, [tsNodeBin, '--transpile-only', script], {
    encoding: 'utf8',
    cwd: backendRoot,
  });

  const parse = (prefix: string): Record<string, number> => {
    const line = stdout
      .split('\n')
      .map((l) => l.trim())
      .find((l) => l.startsWith(prefix));
    if (!line) throw new Error(`missing "${prefix}" line in child output:\n${stdout}`);
    const pairs: Record<string, number> = {};
    for (const token of line.split(/\s+/)) {
      const eq = token.indexOf('=');
      if (eq > 0) pairs[token.slice(0, eq)] = Number(token.slice(eq + 1));
    }
    return pairs;
  };

  const hub = parse('HUB_WARNINGS=');
  const perClient = parse('PERCLIENT_WARNINGS=');
  return {
    hubWarnings: hub.HUB_WARNINGS,
    hubListeners: hub.hubListeners,
    hubBusSubscriptions: hub.hubBusSubscriptions,
    subscribers: hub.subscribers,
    perClientWarnings: perClient.PERCLIENT_WARNINGS,
    perClientListeners: perClient.perClientListeners,
  };
}

// ---------------------------------------------------------------------------
// Doubles
// ---------------------------------------------------------------------------

interface ListCall {
  taskId: string;
  afterSeq: number;
  limit: number | undefined;
}

class ArrayStore {
  /** taskId -> events, kept sorted by taskSeq. */
  readonly rows = new Map<string, StoredEvent[]>();
  readonly calls: ListCall[] = [];
  /** Largest page the store ever handed back, to prove reads stayed bounded. */
  maxRowsReturned = 0;

  seed(taskId: string, count: number, startSeq = 0): void {
    const existing = this.rows.get(taskId) ?? [];
    for (let i = 0; i < count; i++) {
      const taskSeq = startSeq + i;
      existing.push({ taskSeq, taskId, type: 'NodeCompleted' } as unknown as StoredEvent);
    }
    existing.sort((a, b) => a.taskSeq - b.taskSeq);
    this.rows.set(taskId, existing);
  }

  append(taskId: string, taskSeq: number): void {
    this.seed(taskId, 1, taskSeq);
  }

  get queryCount(): number {
    return this.calls.length;
  }

  resetCalls(): void {
    this.calls.length = 0;
  }

  listByTaskSince(taskId: string, afterSeq: number, limit?: number): StoredEvent[] {
    this.calls.push({ taskId, afterSeq, limit });
    const all = (this.rows.get(taskId) ?? []).filter((e) => e.taskSeq > afterSeq);
    const page = limit === undefined ? all : all.slice(0, limit);
    if (page.length > this.maxRowsReturned) this.maxRowsReturned = page.length;
    return page;
  }
}

class EmitterBus implements TaskStreamBus {
  private readonly emitter = new EventEmitter();

  constructor(maxListeners = 100) {
    this.emitter.setMaxListeners(maxListeners);
  }

  subscribe(taskId: string, handler: (event: DAGEvent) => void): () => void {
    this.emitter.on(taskId, handler);
    return () => this.emitter.off(taskId, handler);
  }

  /** Simulate one broadcast tick for a task. */
  tick(taskId: string): void {
    this.emitter.emit(taskId, {} as DAGEvent);
  }

  listenerCount(taskId: string): number {
    return this.emitter.listenerCount(taskId);
  }
}

function makeHub(store: ArrayStore, bus: EmitterBus, pageSize?: number): TaskStreamHub {
  return new TaskStreamHub({ store, bus, pageSize });
}

function collector(): { events: number[]; deliver: (event: StoredEvent) => void } {
  const events: number[] = [];
  return { events, deliver: (event) => events.push(event.taskSeq) };
}

// ---------------------------------------------------------------------------

describe('TaskStreamHub (#655)', () => {
  describe('bounded reads that still drain the whole backlog', () => {
    it('reads at most one page per query and still delivers all 10,000 events', () => {
      const store = new ArrayStore();
      const bus = new EmitterBus();
      const pageSize = 500;
      const hub = makeHub(store, bus, pageSize);
      store.seed('task-big', 10_000);

      const { events, deliver } = collector();
      hub.subscribe('task-big', {}, deliver);
      const rowsRead = hub.flush('task-big');

      // AC: complete delivery, in order, no gaps and no duplicates.
      expect(events).toHaveLength(10_000);
      expect(events[0]).toBe(0);
      expect(events[9_999]).toBe(9_999);
      expect(new Set(events).size).toBe(10_000);
      for (let i = 1; i < events.length; i++) {
        expect(events[i]).toBe(events[i - 1] + 1);
      }

      // AC: every read carried a limit and none returned more than a page.
      expect(store.calls.length).toBeGreaterThan(1);
      expect(store.calls.every((c) => c.limit === pageSize)).toBe(true);
      expect(store.maxRowsReturned).toBeLessThanOrEqual(pageSize);
      expect(rowsRead).toBe(10_000);
    });

    it('passes the page size through as the SQL LIMIT bound', () => {
      const store = new ArrayStore();
      const bus = new EmitterBus();
      const hub = makeHub(store, bus, 25);
      store.seed('task-limit', 60);

      const { events, deliver } = collector();
      hub.subscribe('task-limit', {}, deliver);
      hub.flush('task-limit');

      // 60 rows at 25/page: two full pages (25, 25) then a short one (10).
      expect(store.calls).toHaveLength(3);
      expect(store.calls.every((c) => c.limit === 25)).toBe(true);
      // Each read starts where the previous one stopped.
      expect(store.calls.map((c) => c.afterSeq)).toEqual([-1, 24, 49]);
      expect(events).toHaveLength(60);
    });

    it('rejects a nonsensical page size up front', () => {
      const bus = new EmitterBus();
      expect(() => new TaskStreamHub({ store: new ArrayStore(), bus, pageSize: 0 })).toThrow(
        RangeError,
      );
      expect(() => new TaskStreamHub({ store: new ArrayStore(), bus, pageSize: 1.5 })).toThrow(
        RangeError,
      );
    });
  });

  describe('one bus subscription per task, not per client', () => {
    it('holds a single EventBus listener for 200 subscribers on one task', () => {
      const store = new ArrayStore();
      const bus = new EmitterBus();
      const hub = makeHub(store, bus);
      store.seed('task-hot', 1);

      const detachers: Array<() => void> = [];
      for (let i = 0; i < 200; i++) {
        const { deliver } = collector();
        detachers.push(hub.subscribe('task-hot', { lastEventId: 0 }, deliver));
      }

      expect(hub.subscriberCount('task-hot')).toBe(200);
      expect(hub.busSubscriptionCount()).toBe(1);
      // The whole point: the emitter sees one listener, not 200.
      expect(bus.listenerCount('task-hot')).toBe(1);

      for (const detach of detachers) detach();
    });

    it('emits no MaxListenersExceededWarning for 200 subscribers on one task', async () => {
      // Verified in a plain Node child process, because Jest installs its own
      // `warning` handling and swallows MaxListenersExceededWarning — a
      // `process.on('warning')` listener inside a test never sees it (checked
      // empirically, both via the event and by spying on process.emitWarning).
      const output = runListenerWarningCheck();

      // The shape this PR introduced: 200 clients, one bus subscription, no warning.
      expect(output.hubWarnings).toBe(0);
      expect(output.hubListeners).toBe(1);
      expect(output.hubBusSubscriptions).toBe(1);
      expect(output.subscribers).toBe(200);

      // Positive control in the same process: the previous per-client wiring
      // really does register 200 listeners and really does warn. Without this,
      // the assertion above could pass for the wrong reason.
      expect(output.perClientWarnings).toBeGreaterThan(0);
      expect(output.perClientListeners).toBe(200);
    });

    it('would warn with one listener per client — the shape this replaced', () => {
      // In-process structural control: the old wiring left one listener per
      // connection on the same channel.
      const bus = new EmitterBus();
      const detachers: Array<() => void> = [];
      for (let i = 0; i < 200; i++) {
        detachers.push(bus.subscribe('task-old-shape', () => undefined));
      }

      expect(bus.listenerCount('task-old-shape')).toBe(200);
      for (const detach of detachers) detach();
    });

    it('releases the bus subscription when the last client leaves', () => {
      const store = new ArrayStore();
      const bus = new EmitterBus();
      const hub = makeHub(store, bus);

      const first = hub.subscribe('task-a', {}, () => undefined);
      const second = hub.subscribe('task-a', {}, () => undefined);
      expect(bus.listenerCount('task-a')).toBe(1);

      first();
      expect(bus.listenerCount('task-a')).toBe(1);
      expect(hub.subscriberCount('task-a')).toBe(1);

      second();
      expect(bus.listenerCount('task-a')).toBe(0);
      expect(hub.busSubscriptionCount()).toBe(0);
      expect(hub.activeTaskCount()).toBe(0);
    });

    it('keeps separate tasks on separate bus subscriptions', () => {
      const store = new ArrayStore();
      const bus = new EmitterBus();
      const hub = makeHub(store, bus);

      const a1 = hub.subscribe('task-1', {}, () => undefined);
      const a2 = hub.subscribe('task-1', {}, () => undefined);
      const b1 = hub.subscribe('task-2', {}, () => undefined);

      expect(hub.busSubscriptionCount()).toBe(2);
      expect(bus.listenerCount('task-1')).toBe(1);
      expect(bus.listenerCount('task-2')).toBe(1);

      // Unsubscribing twice must not release the shared subscription early.
      a1();
      a1();
      expect(bus.listenerCount('task-1')).toBe(1);

      a2();
      b1();
      expect(hub.busSubscriptionCount()).toBe(0);
    });
  });

  describe('a burst costs one query per tick regardless of subscriber count', () => {
    it('issues the same number of queries for 1 subscriber and for 200', () => {
      const run = (subscriberCount: number): number => {
        const store = new ArrayStore();
        const bus = new EmitterBus();
        const hub = makeHub(store, bus, 500);
        store.seed('task-burst', 1);

        for (let i = 0; i < subscriberCount; i++) {
          const { deliver } = collector();
          hub.subscribe('task-burst', { lastEventId: 0 }, deliver);
        }
        hub.flush('task-burst');
        store.resetCalls();

        // One tick per emitted event.
        for (let seq = 1; seq <= 5; seq++) {
          store.append('task-burst', seq);
          bus.tick('task-burst');
        }
        return store.queryCount;
      };

      const one = run(1);
      const many = run(200);

      expect(one).toBe(5);
      // Before the fix this was 5 ticks x 200 subscribers = 1000 queries.
      expect(many).toBe(one);
    });

    it('delivers the burst to every subscriber', () => {
      const store = new ArrayStore();
      const bus = new EmitterBus();
      const hub = makeHub(store, bus);
      store.seed('task-burst2', 0);

      const seen: number[][] = [];
      for (let i = 0; i < 200; i++) {
        const { events, deliver } = collector();
        seen.push(events);
        hub.subscribe('task-burst2', {}, deliver);
      }

      for (let seq = 0; seq < 5; seq++) {
        store.append('task-burst2', seq);
        bus.tick('task-burst2');
      }

      expect(seen).toHaveLength(200);
      for (const events of seen) {
        expect(events).toEqual([0, 1, 2, 3, 4]);
      }
    });
  });

  describe('per-subscriber cursors', () => {
    it('replays the backlog only for the client that joined late', () => {
      const store = new ArrayStore();
      const bus = new EmitterBus();
      const hub = makeHub(store, bus);
      store.seed('task-cursor', 3);

      const early = collector();
      hub.subscribe('task-cursor', {}, early.deliver);
      hub.flush('task-cursor');
      expect(early.events).toEqual([0, 1, 2]);

      const late = collector();
      hub.subscribe('task-cursor', { lastEventId: 1 }, late.deliver);
      hub.flush('task-cursor');

      // The late joiner resumes from its own cursor and is not re-sent history.
      expect(late.events).toEqual([2]);
      // The early client is already current, so it gains nothing.
      expect(early.events).toEqual([0, 1, 2]);

      store.resetCalls();
      store.append('task-cursor', 3);
      bus.tick('task-cursor');

      expect(early.events).toEqual([0, 1, 2, 3]);
      expect(late.events).toEqual([2, 3]);
    });

    it('sends nothing when a task has no new events', () => {
      const store = new ArrayStore();
      const bus = new EmitterBus();
      const hub = makeHub(store, bus);
      store.seed('task-idle', 2);

      const { events, deliver } = collector();
      hub.subscribe('task-idle', {}, deliver);
      hub.flush('task-idle');
      store.resetCalls();

      bus.tick('task-idle');

      expect(events).toEqual([0, 1]);
      // One bounded probe to discover there is nothing new.
      expect(store.queryCount).toBe(1);
    });
  });

  describe('robustness', () => {
    it('does not lose an event emitted from inside a delivery', () => {
      const store = new ArrayStore();
      const bus = new EmitterBus();
      const hub = makeHub(store, bus, 2);
      store.seed('task-reentrant', 4);

      const seen: number[] = [];
      hub.subscribe('task-reentrant', {}, (event) => {
        seen.push(event.taskSeq);
        // Re-emitting mid-drain must not recurse, and must not be dropped.
        if (event.taskSeq === 1) {
          store.append('task-reentrant', 4);
          store.append('task-reentrant', 5);
          bus.tick('task-reentrant');
        }
      });
      hub.flush('task-reentrant');

      expect(seen).toEqual([0, 1, 2, 3, 4, 5]);
    });

    it('ignores a flush for a task with no subscribers', () => {
      const store = new ArrayStore();
      const bus = new EmitterBus();
      const hub = makeHub(store, bus);
      store.seed('task-none', 5);

      expect(hub.flush('task-none')).toBe(0);
      expect(store.queryCount).toBe(0);
    });

    it('keeps delivering to the remaining clients when one unsubscribes', () => {
      const store = new ArrayStore();
      const bus = new EmitterBus();
      const hub = makeHub(store, bus);
      store.seed('task-drop', 0);

      const staying = collector();
      const leaving = collector();
      const detachLeaving = hub.subscribe('task-drop', {}, leaving.deliver);
      hub.subscribe('task-drop', {}, staying.deliver);

      store.append('task-drop', 0);
      bus.tick('task-drop');
      detachLeaving();
      store.append('task-drop', 1);
      bus.tick('task-drop');

      expect(leaving.events).toEqual([0]);
      expect(staying.events).toEqual([0, 1]);
    });
  });
});
