/**
 * Unit tests for cursor-based stream replay (Issue: WebSocket resume).
 *
 * Covers:
 *   - the EventBus assigns a per-task monotonic seq starting at 0;
 *   - the EventStore replays the full history by default;
 *   - the EventStore replays only events with seq > cursor (partial replay).
 */

import { eventBus } from '../src/coordinator/eventBus';
import { createEventStore } from '../src/events/eventStore';
import type { AppEvent } from '../src/events/eventTypes';
import type { DAGEvent } from '../src/types/task';

function makeEvent(taskId: string, seq?: number): AppEvent {
  return {
    type: 'NodeStarted',
    taskId,
    nodeId: `node_${seq ?? 0}`,
    occurredAt: new Date().toISOString(),
    version: 1,
    taskSeq: seq ?? 0,
  } as AppEvent;
}

function makeDAGEvent(taskId: string, seq?: number): DAGEvent {
  return {
    type: 'node_started',
    taskId,
    nodeId: `node_${seq ?? 0}`,
    timestamp: new Date().toISOString(),
    seq,
  };
}

describe('EventBus seq assignment', () => {
  it('stamps a per-task monotonic seq starting at 0', () => {
    const taskId = 'task_seq_basic';
    const seen: Array<number | undefined> = [];
    const unsub = eventBus.subscribe(taskId, e => seen.push(e.seq));

    for (let i = 0; i < 4; i++) {
      eventBus.emit(taskId, makeDAGEvent(taskId));
    }
    unsub();

    expect(seen).toEqual([0, 1, 2, 3]);
  });

  it('keeps separate, independent seq counters per taskId', () => {
    const a = 'task_seq_a';
    const b = 'task_seq_b';
    const seenA: Array<number | undefined> = [];
    const seenB: Array<number | undefined> = [];
    const unsubA = eventBus.subscribe(a, e => seenA.push(e.seq));
    const unsubB = eventBus.subscribe(b, e => seenB.push(e.seq));

    eventBus.emit(a, makeDAGEvent(a)); // a:0
    eventBus.emit(b, makeDAGEvent(b)); // b:0
    eventBus.emit(a, makeDAGEvent(a)); // a:1
    eventBus.emit(b, makeDAGEvent(b)); // b:1
    eventBus.emit(a, makeDAGEvent(a)); // a:2
    unsubA();
    unsubB();

    expect(seenA).toEqual([0, 1, 2]);
    expect(seenB).toEqual([0, 1]);
  });
});

describe('EventStore cursor replay', () => {
  it('replays the full history (seq 0 → latest) by default', () => {
    const store = createEventStore();
    const taskId = 'task_full_replay';
    for (let seq = 0; seq <= 9; seq++) store.append(makeEvent(taskId, seq));

    expect(store.listByTask(taskId).map(e => e.taskSeq)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    store.close();
  });

  it('replays only events with seq greater than the cursor', () => {
    const store = createEventStore();
    const taskId = 'task_partial_replay';
    for (let seq = 0; seq <= 9; seq++) store.append(makeEvent(taskId, seq));

    // Connect with lastEventId=5 → only events 6 onwards.
    expect(store.listByTaskSince(taskId, 5).map(e => e.taskSeq)).toEqual([6, 7, 8, 9]);
    store.close();
  });

  it('isolates replay to a single taskId', () => {
    const store = createEventStore();
    for (let seq = 0; seq <= 2; seq++) store.append(makeEvent('task_x', seq));
    for (let seq = 0; seq <= 2; seq++) store.append(makeEvent('task_y', seq));

    expect(store.listByTaskSince('task_x', 0).map(e => e.taskSeq)).toEqual([1, 2]);
    expect(store.listByTask('task_y').map(e => e.taskSeq)).toEqual([0, 1, 2]);
    store.close();
  });
});
