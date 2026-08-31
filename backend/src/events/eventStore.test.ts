/**
 * Unit tests for the event sourcing implementation.
 *
 * Coverage
 * ────────
 * EventStore
 *   • append — stores event, returns StoredEvent with globalSeq
 *   • append — enforces UNIQUE(task_id, task_seq) constraint
 *   • listByTask — full ordered replay
 *   • listByTaskSince — cursor-based partial replay
 *   • listByTimeRange — time-window query
 *   • listByType — type filter (with and without time range)
 *   • multi-task isolation
 *
 * replay.ts
 *   • replayTask — reconstructs TaskState from ordered events
 *   • replayTaskUpTo — snapshot at a given taskSeq
 *   • applyEventToState — incremental state update
 *
 * projection.ts
 *   • projectTaskSummary — per-task status roll-up
 *   • projectNodeTimeline — per-node execution timeline + durationMs
 *   • projectPaymentLedger — locked → released lifecycle
 *   • projectThroughput — aggregate event-rate stats
 *   • buildProjection — generic reducer runner
 *
 * Versioning
 *   • stored events carry the emitted version number
 *   • version round-trips through serialisation intact
 */

import { createEventStore } from './eventStore';
import type { StoredEvent } from './eventStore';
import {
  makeTaskCreated,
  makeNodeStarted,
  makeNodeCompleted,
  makeNodeFailed,
  makePaymentLocked,
  makePaymentReleased,
  makeTaskCompleted,
  makeTaskFailed,
  CURRENT_EVENT_VERSION,
} from './eventTypes';
import {
  replayTask,
  replayTaskUpTo,
  applyEventToState,
} from './replay';
import {
  projectTaskSummary,
  projectNodeTimeline,
  projectPaymentLedger,
  projectThroughput,
  buildProjection,
} from './projection';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Stamp a taskSeq onto an event so it can be passed to append(). */
function withSeq<T extends { taskSeq?: number }>(event: T, seq: number): T {
  return { ...event, taskSeq: seq };
}

/** Build a minimal task event sequence (TaskCreated + a node lifecycle). */
function buildTaskEvents(taskId: string, nodeId = 'node-1') {
  const t0 = '2025-01-01T00:00:00.000Z';
  const t1 = '2025-01-01T00:00:01.000Z';
  const t2 = '2025-01-01T00:00:02.000Z';
  const t3 = '2025-01-01T00:00:03.000Z';

  return [
    withSeq(makeTaskCreated(taskId, { prompt: 'test', walletPublicKey: 'GABC', dagSize: 1 }, t0), 0),
    withSeq(makeNodeStarted(taskId, nodeId, { agentType: 'research' }, t1), 1),
    withSeq(makeNodeCompleted(taskId, nodeId, { result: { ok: true } }, t2), 2),
    withSeq(makeTaskCompleted(taskId, t3), 3),
  ];
}

// ---------------------------------------------------------------------------
// EventStore — append
// ---------------------------------------------------------------------------

describe('EventStore.append', () => {
  it('returns a StoredEvent with globalSeq assigned', () => {
    const store = createEventStore();
    const event = withSeq(makeTaskCreated('t1', { prompt: 'hi', walletPublicKey: 'GABC', dagSize: 1 }), 0);
    const stored = store.append(event);

    expect(stored.globalSeq).toBe(1); // SQLite AUTOINCREMENT starts at 1
    expect(stored.taskSeq).toBe(0);
    expect(stored.type).toBe('TaskCreated');
    expect(stored.taskId).toBe('t1');
    store.close();
  });

  it('globalSeq is monotonically increasing across tasks', () => {
    const store = createEventStore();

    const e1 = store.append(withSeq(makeTaskCreated('ta', { prompt: 'a', walletPublicKey: 'GA', dagSize: 1 }), 0));
    const e2 = store.append(withSeq(makeTaskCreated('tb', { prompt: 'b', walletPublicKey: 'GB', dagSize: 1 }), 0));
    const e3 = store.append(withSeq(makeNodeStarted('ta', 'n1', { agentType: 'coding' }), 1));

    expect(e1.globalSeq).toBeLessThan(e2.globalSeq);
    expect(e2.globalSeq).toBeLessThan(e3.globalSeq);
    store.close();
  });

  it('stores the event version field and round-trips it', () => {
    const store = createEventStore();
    const event = withSeq(makeTaskCreated('tv', { prompt: 'versioned', walletPublicKey: 'GV', dagSize: 2 }), 0);
    store.append(event);

    const [stored] = store.listByTask('tv');
    expect(stored.version).toBe(CURRENT_EVENT_VERSION);
    store.close();
  });

  it('rejects a duplicate (task_id, task_seq) on the second append', () => {
    const store = createEventStore();
    const event = withSeq(makeNodeStarted('dup', 'n1', { agentType: 'risk' }), 0);
    store.append(event);

    expect(() => store.append(event)).toThrow();
    store.close();
  });

  it('stores nodeId for node-level events and null for task-level events', () => {
    const store = createEventStore();
    store.append(withSeq(makeTaskCreated('nodetest', { prompt: 'x', walletPublicKey: 'G', dagSize: 1 }), 0));
    store.append(withSeq(makeNodeStarted('nodetest', 'n42', { agentType: 'design' }), 1));

    const [taskEvt, nodeEvt] = store.listByTask('nodetest');
    expect((taskEvt as any).nodeId).toBeUndefined();
    expect((nodeEvt as any).nodeId).toBe('n42');
    store.close();
  });
});

// ---------------------------------------------------------------------------
// EventStore — listByTask (full replay)
// ---------------------------------------------------------------------------

describe('EventStore.listByTask', () => {
  it('returns events in taskSeq order', () => {
    const store = createEventStore();
    const events = buildTaskEvents('replay-order');
    for (const e of events) store.append(e);

    const stored = store.listByTask('replay-order');
    expect(stored.map(e => e.taskSeq)).toEqual([0, 1, 2, 3]);
    store.close();
  });

  it('returns an empty array for an unknown taskId', () => {
    const store = createEventStore();
    expect(store.listByTask('ghost')).toEqual([]);
    store.close();
  });

  it('isolates events by taskId', () => {
    const store = createEventStore();
    for (const e of buildTaskEvents('task-a')) store.append(e);
    for (const e of buildTaskEvents('task-b')) store.append(e);

    const a = store.listByTask('task-a');
    const b = store.listByTask('task-b');
    expect(a.every(e => e.taskId === 'task-a')).toBe(true);
    expect(b.every(e => e.taskId === 'task-b')).toBe(true);
    store.close();
  });
});

// ---------------------------------------------------------------------------
// EventStore — listByTaskSince (cursor replay)
// ---------------------------------------------------------------------------

describe('EventStore.listByTaskSince', () => {
  it('returns only events with taskSeq > afterSeq', () => {
    const store = createEventStore();
    for (const e of buildTaskEvents('cursor-task')) store.append(e);

    const resumed = store.listByTaskSince('cursor-task', 1);
    expect(resumed.map(e => e.taskSeq)).toEqual([2, 3]);
    store.close();
  });

  it('returns all events when afterSeq is -1', () => {
    const store = createEventStore();
    for (const e of buildTaskEvents('cursor-all')) store.append(e);

    const all = store.listByTaskSince('cursor-all', -1);
    expect(all.map(e => e.taskSeq)).toEqual([0, 1, 2, 3]);
    store.close();
  });

  it('returns an empty array when cursor is at the latest event', () => {
    const store = createEventStore();
    for (const e of buildTaskEvents('cursor-end')) store.append(e);

    expect(store.listByTaskSince('cursor-end', 3)).toEqual([]);
    store.close();
  });
});

// ---------------------------------------------------------------------------
// EventStore — listByTimeRange
// ---------------------------------------------------------------------------

describe('EventStore.listByTimeRange', () => {
  it('returns events within the inclusive [from, to] window', () => {
    const store = createEventStore();
    const events = buildTaskEvents('time-range-task');
    for (const e of events) store.append(e);

    // Events at t1 and t2 fall inside this window
    const results = store.listByTimeRange({
      from: '2025-01-01T00:00:01.000Z',
      to: '2025-01-01T00:00:02.000Z',
    });

    expect(results.length).toBe(2);
    expect(results.map(e => e.type)).toEqual(['NodeStarted', 'NodeCompleted']);
    store.close();
  });

  it('returns an empty array when no events fall within the window', () => {
    const store = createEventStore();
    for (const e of buildTaskEvents('time-range-empty')) store.append(e);

    const results = store.listByTimeRange({
      from: '2030-01-01T00:00:00.000Z',
      to: '2030-12-31T23:59:59.000Z',
    });

    expect(results).toEqual([]);
    store.close();
  });

  it('spans multiple tasks when the window encompasses both', () => {
    const store = createEventStore();

    store.append(withSeq(
      makeTaskCreated('tA', { prompt: 'A', walletPublicKey: 'GA', dagSize: 1 }, '2025-06-01T10:00:00.000Z'),
      0,
    ));
    store.append(withSeq(
      makeTaskCreated('tB', { prompt: 'B', walletPublicKey: 'GB', dagSize: 1 }, '2025-06-01T11:00:00.000Z'),
      0,
    ));

    const results = store.listByTimeRange({
      from: '2025-06-01T09:00:00.000Z',
      to: '2025-06-01T12:00:00.000Z',
    });

    expect(results.length).toBe(2);
    expect(results.map(e => e.taskId)).toContain('tA');
    expect(results.map(e => e.taskId)).toContain('tB');
    store.close();
  });
});

// ---------------------------------------------------------------------------
// EventStore — listByType
// ---------------------------------------------------------------------------

describe('EventStore.listByType', () => {
  it('filters events by type across all tasks', () => {
    const store = createEventStore();
    for (const e of buildTaskEvents('type-filter-a')) store.append(e);
    for (const e of buildTaskEvents('type-filter-b')) store.append(e);

    const nodeStarted = store.listByType('NodeStarted');
    expect(nodeStarted.length).toBe(2);
    expect(nodeStarted.every(e => e.type === 'NodeStarted')).toBe(true);
    store.close();
  });

  it('applies optional time range when provided', () => {
    const store = createEventStore();
    store.append(withSeq(makeNodeStarted('tr1', 'n1', { agentType: 'report' }, '2025-03-01T08:00:00.000Z'), 0));
    store.append(withSeq(makeNodeStarted('tr2', 'n1', { agentType: 'report' }, '2025-03-01T09:00:00.000Z'), 0));
    store.append(withSeq(makeNodeStarted('tr3', 'n1', { agentType: 'report' }, '2025-03-01T10:00:00.000Z'), 0));

    const results = store.listByType('NodeStarted', {
      from: '2025-03-01T08:30:00.000Z',
      to: '2025-03-01T09:30:00.000Z',
    });

    expect(results.length).toBe(1);
    expect(results[0].taskId).toBe('tr2');
    store.close();
  });

  it('returns empty array when no events match the type', () => {
    const store = createEventStore();
    for (const e of buildTaskEvents('type-empty')) store.append(e);

    expect(store.listByType('PaymentLocked')).toEqual([]);
    store.close();
  });
});

// ---------------------------------------------------------------------------
// replay.ts — replayTask
// ---------------------------------------------------------------------------

describe('replayTask', () => {
  it('returns undefined for an empty event list', () => {
    expect(replayTask([])).toBeUndefined();
  });

  it('reconstructs TaskCreated fields', () => {
    const events = buildTaskEvents('replay-created');
    const state = replayTask(events)!;

    expect(state.taskId).toBe('replay-created');
    expect(state.prompt).toBe('test');
    expect(state.walletPublicKey).toBe('GABC');
    expect(state.createdAt).toBe('2025-01-01T00:00:00.000Z');
  });

  it('marks task as completed after TaskCompleted event', () => {
    const events = buildTaskEvents('replay-complete');
    const state = replayTask(events)!;

    expect(state.status).toBe('completed');
    expect(state.completedAt).toBe('2025-01-01T00:00:03.000Z');
  });

  it('marks task as failed after TaskFailed event', () => {
    const taskId = 'replay-failed';
    const events = [
      withSeq(makeTaskCreated(taskId, { prompt: 'fail', walletPublicKey: 'G', dagSize: 1 }, '2025-01-01T00:00:00.000Z'), 0),
      withSeq(makeTaskFailed(taskId, 'timeout', '2025-01-01T00:00:05.000Z'), 1),
    ];
    const state = replayTask(events)!;

    expect(state.status).toBe('failed');
    expect(state.terminalError).toBe('timeout');
  });

  it('tracks node status through start → complete lifecycle', () => {
    const events = buildTaskEvents('replay-node');
    const state = replayTask(events)!;

    const node = state.nodes.get('node-1')!;
    expect(node.status).toBe('completed');
    expect(node.agentType).toBe('research');
    expect(node.startedAt).toBe('2025-01-01T00:00:01.000Z');
    expect(node.settledAt).toBe('2025-01-01T00:00:02.000Z');
  });

  it('tracks node status through start → fail lifecycle', () => {
    const taskId = 'replay-node-fail';
    const events = [
      withSeq(makeTaskCreated(taskId, { prompt: 'x', walletPublicKey: 'G', dagSize: 1 }), 0),
      withSeq(makeNodeStarted(taskId, 'n1', { agentType: 'risk' }), 1),
      withSeq(makeNodeFailed(taskId, 'n1', { error: 'network error' }), 2),
      withSeq(makeTaskFailed(taskId, 'node failed'), 3),
    ];
    const state = replayTask(events)!;

    const node = state.nodes.get('n1')!;
    expect(node.status).toBe('failed');
    expect(node.error).toBe('network error');
  });

  it('attaches payment txHash from PaymentReleased event', () => {
    const taskId = 'replay-payment';
    const events = [
      withSeq(makeTaskCreated(taskId, { prompt: 'pay', walletPublicKey: 'G', dagSize: 1 }), 0),
      withSeq(makeNodeStarted(taskId, 'n1', { agentType: 'coding' }), 1),
      withSeq(makePaymentLocked(taskId, 'n1', { balanceId: 'BAL1', amountStroops: 5_000_000 }), 2),
      withSeq(makeNodeCompleted(taskId, 'n1', { result: null }), 3),
      withSeq(makePaymentReleased(taskId, 'n1', { txHash: '0xabc123' }), 4),
      withSeq(makeTaskCompleted(taskId), 5),
    ];
    const state = replayTask(events)!;

    const node = state.nodes.get('n1')!;
    expect(node.paymentTxHash).toBe('0xabc123');
  });

  it('captures PaymentLocked fields (balanceId, amountStroops, paymentLockedAt)', () => {
    const taskId = 'replay-locked';
    const lockedAt = '2026-08-22T10:00:00.000Z';
    const events = [
      withSeq(makeTaskCreated(taskId, { prompt: 'p', walletPublicKey: 'G', dagSize: 1 }), 0),
      withSeq(makeNodeStarted(taskId, 'n1', { agentType: 'research' }), 1),
      { ...makePaymentLocked(taskId, 'n1', { balanceId: 'BAL-XYZ', amountStroops: 10_000_000 }), taskSeq: 2, occurredAt: lockedAt },
    ];
    const state = replayTask(events)!;

    const node = state.nodes.get('n1')!;
    expect(node.balanceId).toBe('BAL-XYZ');
    expect(node.amountStroops).toBe(10_000_000);
    expect(node.paymentLockedAt).toBe(lockedAt);
    // paymentTxHash not yet set — PaymentReleased hasn't been applied
    expect(node.paymentTxHash).toBeUndefined();
  });

  it('advances lastTaskSeq and eventCount correctly', () => {
    const events = buildTaskEvents('replay-counts');
    const state = replayTask(events)!;

    expect(state.eventCount).toBe(4);
    expect(state.lastTaskSeq).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// replay.ts — replayTaskUpTo
// ---------------------------------------------------------------------------

describe('replayTaskUpTo', () => {
  it('returns state as of the specified taskSeq snapshot', () => {
    const events = buildTaskEvents('snapshot-task');

    // After seq 1 (NodeStarted), task should be running with one running node
    const snap = replayTaskUpTo(events, 1)!;
    expect(snap.status).toBe('running');
    expect(snap.nodes.get('node-1')?.status).toBe('running');
  });

  it('includes the event exactly at targetSeq', () => {
    const events = buildTaskEvents('snapshot-inclusive');

    // seq 2 is NodeCompleted — node should be completed
    const snap = replayTaskUpTo(events, 2)!;
    expect(snap.nodes.get('node-1')?.status).toBe('completed');
    expect(snap.status).toBe('running'); // TaskCompleted not yet applied
  });
});

// ---------------------------------------------------------------------------
// replay.ts — applyEventToState
// ---------------------------------------------------------------------------

describe('applyEventToState', () => {
  it('incrementally updates state without a full replay', () => {
    const taskId = 'incremental-task';
    const events = buildTaskEvents(taskId);

    // Bootstrap from first three events, then apply the fourth incrementally
    let state = replayTask(events.slice(0, 3))!;
    expect(state.status).toBe('running');

    state = applyEventToState(state, events[3]);
    expect(state.status).toBe('completed');
    expect(state.completedAt).toBe('2025-01-01T00:00:03.000Z');
  });

  it('mutates and returns the same state reference', () => {
    const taskId = 'ref-task';
    const events = buildTaskEvents(taskId);
    let state = replayTask(events.slice(0, 1))!;
    const ref = state;

    state = applyEventToState(state, events[1]);
    expect(state).toBe(ref); // same object reference
  });
});

// ---------------------------------------------------------------------------
// projection.ts — projectTaskSummary
// ---------------------------------------------------------------------------

describe('projectTaskSummary', () => {
  it('builds a summary for each distinct task', () => {
    const store = createEventStore();
    for (const e of buildTaskEvents('sum-a')) store.append(e);
    for (const e of buildTaskEvents('sum-b')) store.append(e);

    const allEvents = [
      ...store.listByTask('sum-a'),
      ...store.listByTask('sum-b'),
    ];
    const summaries = projectTaskSummary(allEvents);

    expect(summaries.size).toBe(2);
    expect(summaries.get('sum-a')!.status).toBe('completed');
    expect(summaries.get('sum-b')!.status).toBe('completed');
    store.close();
  });

  it('counts completed and failed nodes correctly', () => {
    const taskId = 'sum-counts';
    const events = [
      withSeq(makeTaskCreated(taskId, { prompt: 'x', walletPublicKey: 'G', dagSize: 2 }), 0),
      withSeq(makeNodeStarted(taskId, 'n1', { agentType: 'a' }), 1),
      withSeq(makeNodeStarted(taskId, 'n2', { agentType: 'b' }), 2),
      withSeq(makeNodeCompleted(taskId, 'n1', { result: null }), 3),
      withSeq(makeNodeFailed(taskId, 'n2', { error: 'oops' }), 4),
      withSeq(makeTaskFailed(taskId, 'node failed'), 5),
    ];

    const summaries = projectTaskSummary(events);
    const s = summaries.get(taskId)!;

    expect(s.nodeCount).toBe(2);
    expect(s.completedNodeCount).toBe(1);
    expect(s.failedNodeCount).toBe(1);
    expect(s.status).toBe('failed');
  });
});

// ---------------------------------------------------------------------------
// projection.ts — projectNodeTimeline
// ---------------------------------------------------------------------------

describe('projectNodeTimeline', () => {
  it('builds timeline entries with start, settled, and durationMs', () => {
    const taskId = 'timeline-task';
    const events = [
      withSeq(makeNodeStarted(taskId, 'n1', { agentType: 'research' }, '2025-01-01T10:00:00.000Z'), 0),
      withSeq(makeNodeCompleted(taskId, 'n1', { result: 'done' }, '2025-01-01T10:00:02.500Z'), 1),
    ];

    const timeline = projectNodeTimeline(events);
    const entry = timeline.get('n1')!;

    expect(entry.status).toBe('completed');
    expect(entry.agentType).toBe('research');
    expect(entry.durationMs).toBe(2500);
  });

  it('sets status to failed with error message on NodeFailed', () => {
    const taskId = 'timeline-fail';
    const events = [
      withSeq(makeNodeStarted(taskId, 'n2', { agentType: 'risk' }), 0),
      withSeq(makeNodeFailed(taskId, 'n2', { error: 'API timeout' }), 1),
    ];

    const timeline = projectNodeTimeline(events);
    expect(timeline.get('n2')!.status).toBe('failed');
    expect(timeline.get('n2')!.error).toBe('API timeout');
  });

  it('ignores task-level events (no nodeId)', () => {
    const taskId = 'timeline-task-level';
    const events = [
      withSeq(makeTaskCreated(taskId, { prompt: 'x', walletPublicKey: 'G', dagSize: 1 }), 0),
      withSeq(makeTaskCompleted(taskId), 1),
    ];

    const timeline = projectNodeTimeline(events);
    expect(timeline.size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// projection.ts — projectPaymentLedger
// ---------------------------------------------------------------------------

describe('projectPaymentLedger', () => {
  it('transitions entry from locked to released', () => {
    const taskId = 'ledger-task';
    const nodeId = 'n1';
    const events = [
      withSeq(makePaymentLocked(taskId, nodeId, { balanceId: 'BAL42', amountStroops: 10_000_000 }), 0),
      withSeq(makePaymentReleased(taskId, nodeId, { txHash: 'TX99' }), 1),
    ];

    const ledger = projectPaymentLedger(events);
    const entry = ledger.get(`${taskId}:${nodeId}`)!;

    expect(entry.status).toBe('released');
    expect(entry.balanceId).toBe('BAL42');
    expect(entry.amountStroops).toBe(10_000_000);
    expect(entry.txHash).toBe('TX99');
  });

  it('creates a partial entry when PaymentReleased has no prior PaymentLocked', () => {
    const taskId = 'ledger-orphan';
    const events = [
      withSeq(makePaymentReleased(taskId, 'n99', { txHash: 'TX_ORPHAN' }), 0),
    ];

    const ledger = projectPaymentLedger(events);
    const entry = ledger.get(`${taskId}:n99`)!;

    expect(entry.status).toBe('released');
    expect(entry.txHash).toBe('TX_ORPHAN');
    expect(entry.balanceId).toBeUndefined();
  });

  it('tracks multiple (taskId, nodeId) pairs independently', () => {
    const events = [
      withSeq(makePaymentLocked('t1', 'n1', { balanceId: 'B1', amountStroops: 1_000 }), 0),
      withSeq(makePaymentLocked('t1', 'n2', { balanceId: 'B2', amountStroops: 2_000 }), 1),
      withSeq(makePaymentReleased('t1', 'n1', { txHash: 'TX1' }), 2),
    ];

    const ledger = projectPaymentLedger(events);
    expect(ledger.get('t1:n1')!.status).toBe('released');
    expect(ledger.get('t1:n2')!.status).toBe('locked');
  });
});

// ---------------------------------------------------------------------------
// projection.ts — projectThroughput
// ---------------------------------------------------------------------------

describe('projectThroughput', () => {
  it('counts total events, distinct tasks, and terminal states', () => {
    const eventsA = buildTaskEvents('thr-a');
    const eventsB = [
      withSeq(makeTaskCreated('thr-b', { prompt: 'b', walletPublicKey: 'G', dagSize: 1 }), 0),
      withSeq(makeTaskFailed('thr-b', 'boom'), 1),
    ];

    const stats = projectThroughput([...eventsA, ...eventsB]);

    expect(stats.totalEvents).toBe(6);
    expect(stats.distinctTasks).toBe(2);
    expect(stats.completedTasks).toBe(1);
    expect(stats.failedTasks).toBe(1);
  });

  it('returns zero-values for an empty slice', () => {
    const stats = projectThroughput([]);
    expect(stats.totalEvents).toBe(0);
    expect(stats.distinctTasks).toBe(0);
    expect(stats.windowStart).toBeUndefined();
    expect(stats.windowEnd).toBeUndefined();
  });

  it('sets windowStart and windowEnd from the event timestamps', () => {
    const events = [
      withSeq(makeTaskCreated('thr-win', { prompt: 'w', walletPublicKey: 'G', dagSize: 1 }, '2025-05-01T08:00:00.000Z'), 0),
      withSeq(makeTaskCompleted('thr-win', '2025-05-01T09:30:00.000Z'), 1),
    ];
    const stats = projectThroughput(events);

    expect(stats.windowStart).toBe('2025-05-01T08:00:00.000Z');
    expect(stats.windowEnd).toBe('2025-05-01T09:30:00.000Z');
  });

  it('populates countByType for every event type in the slice', () => {
    const events = buildTaskEvents('thr-types');
    const stats = projectThroughput(events);

    expect(stats.countByType['TaskCreated']).toBe(1);
    expect(stats.countByType['NodeStarted']).toBe(1);
    expect(stats.countByType['NodeCompleted']).toBe(1);
    expect(stats.countByType['TaskCompleted']).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// projection.ts — buildProjection (generic reducer)
// ---------------------------------------------------------------------------

describe('buildProjection', () => {
  it('accumulates a simple scalar via a custom reducer', () => {
    const events = buildTaskEvents('bp-task');
    const count = buildProjection(events, 0, (acc, e) =>
      e.type === 'NodeStarted' ? acc + 1 : acc
    );

    expect(count).toBe(1);
  });

  it('returns the initial state unchanged for an empty slice', () => {
    const result = buildProjection([], { seen: [] as string[] }, (s, e) => ({
      seen: [...s.seen, e.type],
    }));

    expect(result.seen).toEqual([]);
  });

  it('builds an ordered list of event types', () => {
    const events = buildTaskEvents('bp-list');
    const types = buildProjection(events, [] as string[], (acc, e) => [...acc, e.type]);

    expect(types).toEqual(['TaskCreated', 'NodeStarted', 'NodeCompleted', 'TaskCompleted']);
  });
});

// ---------------------------------------------------------------------------
// EventStore — round-trip with replay (integration)
// ---------------------------------------------------------------------------

describe('EventStore + replayTask (round-trip)', () => {
  it('persists and reconstructs full task state end-to-end', () => {
    const store = createEventStore();
    const taskId = 'e2e-roundtrip';

    const rawEvents = [
      withSeq(makeTaskCreated(taskId, { prompt: 'full pipeline', walletPublicKey: 'GXYZ', dagSize: 2 }, '2025-02-01T10:00:00.000Z'), 0),
      withSeq(makeNodeStarted(taskId, 'research', { agentType: 'research' }, '2025-02-01T10:00:01.000Z'), 1),
      withSeq(makePaymentLocked(taskId, 'research', { balanceId: 'B_RESEARCH', amountStroops: 1_000_000 }, '2025-02-01T10:00:02.000Z'), 2),
      withSeq(makeNodeCompleted(taskId, 'research', { result: { summary: 'market data' } }, '2025-02-01T10:00:05.000Z'), 3),
      withSeq(makePaymentReleased(taskId, 'research', { txHash: 'TX_RESEARCH' }, '2025-02-01T10:00:06.000Z'), 4),
      withSeq(makeNodeStarted(taskId, 'report', { agentType: 'report' }, '2025-02-01T10:00:07.000Z'), 5),
      withSeq(makeNodeCompleted(taskId, 'report', { result: { pdf: 'report.pdf' } }, '2025-02-01T10:00:10.000Z'), 6),
      withSeq(makeTaskCompleted(taskId, '2025-02-01T10:00:11.000Z'), 7),
    ];

    for (const e of rawEvents) store.append(e);

    const stored = store.listByTask(taskId);
    const state = replayTask(stored)!;

    expect(state.status).toBe('completed');
    expect(state.prompt).toBe('full pipeline');
    expect(state.eventCount).toBe(8);
    expect(state.nodes.get('research')!.paymentTxHash).toBe('TX_RESEARCH');
    expect(state.nodes.get('report')!.status).toBe('completed');

    store.close();
  });
});
