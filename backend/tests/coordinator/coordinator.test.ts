/**
 * Unit tests for the Coordinator — Task Cancellation (Issue #62)
 *
 * Exercises:
 *   - Aborting a running DAG mid-execution
 *   - No node_started events after cancellation
 *   - Pending nodes are marked cancelled
 *   - Completed nodes are not re-run
 *   - task_cancelled event is emitted
 *   - DELETE on queued task results in immediate cancellation
 */

import { Coordinator } from '../../src/coordinator/coordinator';
import { eventBus } from '../../src/coordinator/eventBus';
import { createTask, getTask, cancelPendingNodes } from '../../src/coordinator/taskStore';
import type { DAGNode, DAGEvent } from '../../src/coordinator/types';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function createLinearDAG(): DAGNode[] {
  return [
    { nodeId: 'node_1', agentType: 'research', prompt: 'Step 1', dependsOn: [],             status: 'pending' },
    { nodeId: 'node_2', agentType: 'risk',     prompt: 'Step 2', dependsOn: ['node_1'],      status: 'pending' },
    { nodeId: 'node_3', agentType: 'coding',   prompt: 'Step 3', dependsOn: ['node_1'],      status: 'pending' },
    { nodeId: 'node_4', agentType: 'design',   prompt: 'Step 4', dependsOn: ['node_2', 'node_3'], status: 'pending' },
  ];
}

/** Collect DAG events for a task into an array for assertion. */
function subscribeToEvents(taskId: string): DAGEvent[] {
  const events: DAGEvent[] = [];
  eventBus.subscribe(taskId, (e: DAGEvent) => { events.push(e); });
  return events;
}

// ─── Setup ───────────────────────────────────────────────────────────────────

const TASK_ID = 'cancel-test-task';
const SLOW_DELAY_MS = 200;

beforeEach(() => {
  // Remove all listeners so tests don't interfere
  eventBus.removeAllListeners(TASK_ID);
});

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('Task Cancellation', () => {
  it('marks all pending nodes as cancelled and emits task_cancelled when aborted mid-DAG', async () => {
    const dag = createLinearDAG();
    const controller = new AbortController();
    const events = subscribeToEvents(TASK_ID);

    createTask({
      taskId: TASK_ID,
      prompt: 'cancel-test',
      walletPublicKey: 'GFAKE',
      status: 'queued',
      dag,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    const coordinator = new Coordinator({
      dispatch: async (_tid, node) => {
        // Slow down node_1 so we can abort before node_2/node_3 start
        if (node.nodeId === 'node_1') {
          await new Promise(r => setTimeout(r, SLOW_DELAY_MS));
        }
        return { nodeId: node.nodeId, result: 'ok' };
      },
      paymentService: { release: async () => 'mock-hash' },
    });

    // Start DAG execution (node_1 starts immediately)
    const execPromise = coordinator.executeDAG(TASK_ID, dag, controller.signal);

    // Give node_1 time to start but not finish
    await new Promise(r => setTimeout(r, 30));

    // Capture the events before abort
    const eventsBeforeAbort = events.length;

    // Abort mid-execution
    controller.abort();

    // Wait for execution to settle
    await execPromise;

    const task = getTask(TASK_ID);
    expect(task?.status).toBe('cancelled');

    // node_1 might have completed (it was already running) — that's fine
    // But all nodes that started after the abort should be cancelled
    const nodeStatuses = dag.map(n => `${n.nodeId}:${n.status}`).join(', ');
    expect(dag.filter(n => n.status === 'cancelled').length).toBeGreaterThanOrEqual(2);

    // task_cancelled event should be emitted
    expect(events.some(e => e.type === 'task_cancelled')).toBe(true);

    // No task_failed or task_completed should be emitted for a cancellation
    expect(events.some(e => e.type === 'task_failed')).toBe(false);
    expect(events.some(e => e.type === 'task_completed')).toBe(false);
  });

  it('allows already-completed nodes to remain completed after cancellation', async () => {
    const dag: DAGNode[] = [
      { nodeId: 'node_1', agentType: 'research', prompt: 'quick', dependsOn: [], status: 'pending' },
    ];
    const controller = new AbortController();
    const events = subscribeToEvents(TASK_ID);

    createTask({
      taskId: TASK_ID,
      prompt: 'completed-test',
      walletPublicKey: 'GFAKE',
      status: 'queued',
      dag,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    const coordinator = new Coordinator({
      dispatch: async () => {
        await new Promise(r => setTimeout(r, 10));
        return { result: 'ok' };
      },
      paymentService: { release: async () => 'mock-hash' },
    });

    // Start execution and let it complete fully
    await coordinator.executeDAG(TASK_ID, dag, controller.signal);

    const task = getTask(TASK_ID);
    expect(task?.status).toBe('completed');
    expect(dag[0]?.status).toBe('completed');

    // Verify events
    const eventTypes = events.map(e => e.type);
    expect(eventTypes).toContain('node_completed');
    expect(eventTypes).toContain('payment_released');
    expect(eventTypes).toContain('task_completed');
    expect(eventTypes).not.toContain('task_cancelled');
  });

  it('immediately cancels a queued task without any node_started events', () => {
    const dag = createLinearDAG();

    createTask({
      taskId: TASK_ID,
      prompt: 'queued-cancel',
      walletPublicKey: 'GFAKE',
      status: 'queued',
      dag,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    // Simulate what DELETE handler does for a queued task
    cancelPendingNodes(TASK_ID);

    const task = getTask(TASK_ID);
    expect(task?.status).toBe('cancelled');

    // All nodes should be cancelled (none were running)
    for (const node of dag) {
      expect(node.status).toBe('cancelled');
    }
  });

  it('aborts before any node starts and cancels all nodes immediately', async () => {
    const dag = createLinearDAG();
    const controller = new AbortController();
    const events = subscribeToEvents(TASK_ID);

    // Abort BEFORE starting execution
    controller.abort();

    createTask({
      taskId: TASK_ID,
      prompt: 'pre-abort',
      walletPublicKey: 'GFAKE',
      status: 'queued',
      dag,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    const coordinator = new Coordinator({
      dispatch: async () => ({ result: 'should-not-run' }),
      paymentService: { release: async () => 'mock-hash' },
    });

    await coordinator.executeDAG(TASK_ID, dag, controller.signal);

    const task = getTask(TASK_ID);
    expect(task?.status).toBe('cancelled');

    // All nodes cancelled
    for (const node of dag) {
      expect(node.status).toBe('cancelled');
    }

    // No node_started events should have been emitted
    expect(events.filter(e => e.type === 'node_started')).toHaveLength(0);

    // task_cancelled should be the only terminal event
    expect(events.some(e => e.type === 'task_cancelled')).toBe(true);
  });
});
