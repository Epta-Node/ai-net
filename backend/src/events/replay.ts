/**
 * Event replay — reconstruct task state from a stored event history.
 *
 * Usage
 * ─────
 *   const store = createEventStore();
 *   const state = replayTask(store.listByTask(taskId));
 *
 * The replay fold is a pure function: it takes an ordered list of events and
 * returns the current `TaskState`.  This means it can be used for debugging
 * (inspect any historical snapshot), hydration (bootstrap the in-memory
 * coordinator state on server restart), and testing (drive state with
 * hand-crafted event sequences without touching the DB).
 */

import type { StoredEvent } from './eventStore';
import type {
  AppEvent,
  NodeCompletedPayload,
  NodeFailedPayload,
  NodeStartedPayload,
  TaskCreatedPayload,
} from './eventTypes';
import {
  isNodeCompleted,
  isNodeFailed,
  isNodeStarted,
  isPaymentLocked,
  isPaymentReleased,
  isTaskCompleted,
  isTaskCreated,
  isTaskFailed,
} from './eventTypes';

// ---------------------------------------------------------------------------
// Reconstructed state shapes
// ---------------------------------------------------------------------------

export type ReplayedTaskStatus =
  | 'queued'
  | 'running'
  | 'completed'
  | 'failed'
  | 'unknown';

export type ReplayedNodeStatus =
  | 'pending'
  | 'running'
  | 'completed'
  | 'failed';

export interface ReplayedNode {
  nodeId: string;
  /** Agent type derived from NodeStarted payload. */
  agentType?: string;
  status: ReplayedNodeStatus;
  result?: unknown;
  error?: string;
  /** ISO-8601 timestamp of the NodeStarted event. */
  startedAt?: string;
  /** ISO-8601 timestamp of the NodeCompleted or NodeFailed event. */
  settledAt?: string;
  /** ISO-8601 timestamp of the PaymentLocked event. */
  paymentLockedAt?: string;
  /** Stellar claimable-balance ID from the PaymentLocked event. */
  balanceId?: string;
  /** Locked amount in stroops from the PaymentLocked event. */
  amountStroops?: number;
  /** Stellar transaction hash from the matching PaymentReleased event. */
  paymentTxHash?: string;
}

export interface ReplayedTaskState {
  taskId: string;
  status: ReplayedTaskStatus;
  /** Reconstructed prompt — only available if a TaskCreated event was stored. */
  prompt?: string;
  walletPublicKey?: string;
  /** Node states keyed by nodeId. */
  nodes: Map<string, ReplayedNode>;
  /** ISO-8601 creation time from TaskCreated event. */
  createdAt?: string;
  /** ISO-8601 time of the terminal event (TaskCompleted / TaskFailed). */
  completedAt?: string;
  /** Error message from the terminal TaskFailed event (if present). */
  terminalError?: string;
  /** Sequence number of the last event applied to this state. */
  lastTaskSeq: number;
  /** Total number of events applied. */
  eventCount: number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function ensureNode(state: ReplayedTaskState, nodeId: string): ReplayedNode {
  let node = state.nodes.get(nodeId);
  if (!node) {
    node = { nodeId, status: 'pending' };
    state.nodes.set(nodeId, node);
  }
  return node;
}

function applyEvent(state: ReplayedTaskState, event: AppEvent): void {
  // Advance the cursor regardless of event type.
  state.eventCount += 1;
  const seq = event.taskSeq;
  if (seq !== undefined && seq > state.lastTaskSeq) {
    state.lastTaskSeq = seq;
  }

  if (isTaskCreated(event)) {
    const p = event.payload as TaskCreatedPayload;
    state.prompt = p.prompt;
    state.walletPublicKey = p.walletPublicKey;
    state.createdAt = event.occurredAt;
    state.status = 'queued';
    return;
  }

  if (isNodeStarted(event)) {
    const node = ensureNode(state, event.nodeId);
    const p = event.payload as NodeStartedPayload;
    node.status = 'running';
    node.agentType = p.agentType;
    node.startedAt = event.occurredAt;
    if (state.status === 'queued') state.status = 'running';
    return;
  }

  if (isNodeCompleted(event)) {
    const node = ensureNode(state, event.nodeId);
    const p = event.payload as NodeCompletedPayload;
    node.status = 'completed';
    node.result = p.result;
    node.settledAt = event.occurredAt;
    return;
  }

  if (isNodeFailed(event)) {
    const node = ensureNode(state, event.nodeId);
    const p = event.payload as NodeFailedPayload;
    node.status = 'failed';
    node.error = p.error;
    node.settledAt = event.occurredAt;
    return;
  }

  if (isPaymentLocked(event)) {
    const node = ensureNode(state, event.nodeId);
    node.paymentLockedAt = event.occurredAt;
    node.balanceId = event.payload.balanceId;
    node.amountStroops = event.payload.amountStroops;
    return;
  }

  if (isPaymentReleased(event)) {
    const node = ensureNode(state, event.nodeId);
    node.paymentTxHash = event.payload.txHash;
    return;
  }

  if (isTaskCompleted(event)) {
    state.status = 'completed';
    state.completedAt = event.occurredAt;
    return;
  }

  if (isTaskFailed(event)) {
    state.status = 'failed';
    state.completedAt = event.occurredAt;
    state.terminalError = event.payload?.error;
    return;
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Reconstruct the full task state by folding an ordered event history.
 *
 * @param events  Ordered slice of stored events (typically the result of
 *                `store.listByTask(taskId)`).
 * @returns       The task state as of the last event in the slice.
 *                Returns `undefined` when `events` is empty.
 */
export function replayTask(
  events: ReadonlyArray<AppEvent | StoredEvent>
): ReplayedTaskState | undefined {
  if (events.length === 0) return undefined;

  const first = events[0];
  const state: ReplayedTaskState = {
    taskId: first.taskId,
    status: 'unknown',
    nodes: new Map(),
    lastTaskSeq: -1,
    eventCount: 0,
  };

  for (const event of events) {
    applyEvent(state, event as AppEvent);
  }

  return state;
}

/**
 * Replay events up to (and including) the event at `targetSeq`.
 *
 * Useful for debugging: "what did the task look like after event 5?".
 *
 * @param events     Full ordered event history for the task.
 * @param targetSeq  The `taskSeq` value to stop at (inclusive).
 */
export function replayTaskUpTo(
  events: ReadonlyArray<AppEvent | StoredEvent>,
  targetSeq: number
): ReplayedTaskState | undefined {
  const slice = events.filter(
    e => e.taskSeq === undefined || e.taskSeq <= targetSeq
  );
  return replayTask(slice);
}

/**
 * Incrementally apply a single new event onto an existing `ReplayedTaskState`.
 * Mutates `state` in place and returns it.
 *
 * Use this to keep an in-memory view current as new events arrive, rather than
 * replaying the full history from scratch on every event.
 *
 * @param state  The current task state (must have been created by
 *               {@link replayTask} or a previous call to this function).
 * @param event  The new event to apply.
 */
export function applyEventToState(
  state: ReplayedTaskState,
  event: AppEvent | StoredEvent
): ReplayedTaskState {
  applyEvent(state, event as AppEvent);
  return state;
}
