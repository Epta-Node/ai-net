/**
 * Event projections — derive read models from a stream of stored events.
 *
 * What is a projection?
 * ─────────────────────
 * A projection is a read-model built by scanning and aggregating events.  It
 * answers a specific query efficiently (e.g. "how many tasks completed today?")
 * without requiring a full task replay or a join-heavy SQL query.
 *
 * Each projection function in this module is a pure transform that takes a
 * slice of `StoredEvent[]` (retrieved via the EventStore) and returns the
 * derived model.  Callers are responsible for fetching and caching the events;
 * the projections themselves have no I/O.
 *
 * Available projections
 * ──────────────────────
 * • `projectTaskSummary`   — lightweight status view per task
 * • `projectNodeTimeline`  — per-node execution timeline for a single task
 * • `projectPaymentLedger` — payment records across tasks
 * • `projectThroughput`    — event-rate stats over a time window
 * • `buildProjection`      — generic incremental projection runner
 */

import type { StoredEvent } from './eventStore';
import type { AppEvent } from './eventTypes';
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
// Task summary projection
// ---------------------------------------------------------------------------

export type TaskSummaryStatus = 'queued' | 'running' | 'completed' | 'failed';

export interface TaskSummary {
  taskId: string;
  status: TaskSummaryStatus;
  prompt?: string;
  walletPublicKey?: string;
  nodeCount: number;
  completedNodeCount: number;
  failedNodeCount: number;
  createdAt?: string;
  completedAt?: string;
}

/**
 * Build a lightweight summary view for each distinct task found in `events`.
 * Suitable for listing pages that show status without full DAG details.
 *
 * @param events  Any ordered slice from the event store (may span multiple tasks).
 */
export function projectTaskSummary(
  events: ReadonlyArray<StoredEvent | AppEvent>
): Map<string, TaskSummary> {
  const summaries = new Map<string, TaskSummary>();

  function ensure(taskId: string): TaskSummary {
    let s = summaries.get(taskId);
    if (!s) {
      s = {
        taskId,
        status: 'queued',
        nodeCount: 0,
        completedNodeCount: 0,
        failedNodeCount: 0,
      };
      summaries.set(taskId, s);
    }
    return s;
  }

  for (const event of events as AppEvent[]) {
    const s = ensure(event.taskId);

    if (isTaskCreated(event)) {
      s.prompt = event.payload.prompt;
      s.walletPublicKey = event.payload.walletPublicKey;
      s.createdAt = event.occurredAt;
      s.status = 'queued';
      continue;
    }

    if (isNodeStarted(event)) {
      s.status = 'running';
      s.nodeCount += 1;
      continue;
    }

    if (isNodeCompleted(event)) {
      s.completedNodeCount += 1;
      continue;
    }

    if (isNodeFailed(event)) {
      s.failedNodeCount += 1;
      continue;
    }

    if (isTaskCompleted(event)) {
      s.status = 'completed';
      s.completedAt = event.occurredAt;
      continue;
    }

    if (isTaskFailed(event)) {
      s.status = 'failed';
      s.completedAt = event.occurredAt;
    }
  }

  return summaries;
}

// ---------------------------------------------------------------------------
// Node timeline projection
// ---------------------------------------------------------------------------

export interface NodeTimelineEntry {
  nodeId: string;
  agentType?: string;
  startedAt?: string;
  settledAt?: string;
  durationMs?: number;
  status: 'pending' | 'running' | 'completed' | 'failed';
  error?: string;
}

/**
 * Build an execution timeline for every node in a single task.
 * Nodes appear in the map ordered by first-seen event.
 *
 * @param events  Events for a single task (e.g. from `store.listByTask(taskId)`).
 */
export function projectNodeTimeline(
  events: ReadonlyArray<StoredEvent | AppEvent>
): Map<string, NodeTimelineEntry> {
  const timeline = new Map<string, NodeTimelineEntry>();

  function ensure(nodeId: string): NodeTimelineEntry {
    let entry = timeline.get(nodeId);
    if (!entry) {
      entry = { nodeId, status: 'pending' };
      timeline.set(nodeId, entry);
    }
    return entry;
  }

  for (const event of events as AppEvent[]) {
    if (!('nodeId' in event) || !event.nodeId) continue;

    const entry = ensure(event.nodeId);

    if (isNodeStarted(event)) {
      entry.status = 'running';
      entry.agentType = event.payload.agentType;
      entry.startedAt = event.occurredAt;
      continue;
    }

    if (isNodeCompleted(event)) {
      entry.status = 'completed';
      entry.settledAt = event.occurredAt;
      if (entry.startedAt) {
        entry.durationMs =
          new Date(entry.settledAt).getTime() - new Date(entry.startedAt).getTime();
      }
      continue;
    }

    if (isNodeFailed(event)) {
      entry.status = 'failed';
      entry.error = event.payload.error;
      entry.settledAt = event.occurredAt;
      if (entry.startedAt) {
        entry.durationMs =
          new Date(entry.settledAt).getTime() - new Date(entry.startedAt).getTime();
      }
    }
  }

  return timeline;
}

// ---------------------------------------------------------------------------
// Payment ledger projection
// ---------------------------------------------------------------------------

export type PaymentEntryStatus = 'locked' | 'released';

export interface PaymentEntry {
  taskId: string;
  nodeId: string;
  balanceId?: string;
  amountStroops?: number;
  txHash?: string;
  status: PaymentEntryStatus;
  lockedAt?: string;
  releasedAt?: string;
}

/**
 * Build a payment ledger across all tasks in the provided event slice.
 * Each entry represents a single (taskId, nodeId) payment lifecycle.
 *
 * @param events  Any ordered event slice (may span multiple tasks).
 */
export function projectPaymentLedger(
  events: ReadonlyArray<StoredEvent | AppEvent>
): Map<string, PaymentEntry> {
  // Key: `${taskId}:${nodeId}`
  const ledger = new Map<string, PaymentEntry>();

  for (const event of events as AppEvent[]) {
    if (!('nodeId' in event) || !event.nodeId) continue;

    const key = `${event.taskId}:${event.nodeId}`;

    if (isPaymentLocked(event)) {
      ledger.set(key, {
        taskId: event.taskId,
        nodeId: event.nodeId,
        balanceId: event.payload.balanceId,
        amountStroops: event.payload.amountStroops,
        status: 'locked',
        lockedAt: event.occurredAt,
      });
      continue;
    }

    if (isPaymentReleased(event)) {
      const existing = ledger.get(key);
      if (existing) {
        existing.status = 'released';
        existing.txHash = event.payload.txHash;
        existing.releasedAt = event.occurredAt;
      } else {
        // PaymentReleased arrived without a preceding PaymentLocked (e.g. in
        // a partial replay window) — create a partial entry.
        ledger.set(key, {
          taskId: event.taskId,
          nodeId: event.nodeId,
          txHash: event.payload.txHash,
          status: 'released',
          releasedAt: event.occurredAt,
        });
      }
    }
  }

  return ledger;
}

// ---------------------------------------------------------------------------
// Throughput projection
// ---------------------------------------------------------------------------

export interface ThroughputStats {
  /** Total events processed. */
  totalEvents: number;
  /** Distinct tasks seen. */
  distinctTasks: number;
  /** Tasks that reached TaskCompleted. */
  completedTasks: number;
  /** Tasks that reached TaskFailed. */
  failedTasks: number;
  /** Count per EventType. */
  countByType: Record<string, number>;
  /** Earliest occurredAt in the slice (ISO-8601). */
  windowStart?: string;
  /** Latest occurredAt in the slice (ISO-8601). */
  windowEnd?: string;
}

/**
 * Compute throughput statistics for an event slice.
 * Useful for dashboards and alerting.
 *
 * @param events  Any ordered event slice.
 */
export function projectThroughput(
  events: ReadonlyArray<StoredEvent | AppEvent>
): ThroughputStats {
  const tasks = new Set<string>();
  let completedTasks = 0;
  let failedTasks = 0;
  const countByType: Record<string, number> = {};
  let windowStart: string | undefined;
  let windowEnd: string | undefined;

  for (const event of events as AppEvent[]) {
    tasks.add(event.taskId);
    countByType[event.type] = (countByType[event.type] ?? 0) + 1;

    if (!windowStart || event.occurredAt < windowStart) windowStart = event.occurredAt;
    if (!windowEnd || event.occurredAt > windowEnd) windowEnd = event.occurredAt;

    if (isTaskCompleted(event)) completedTasks += 1;
    if (isTaskFailed(event)) failedTasks += 1;
  }

  return {
    totalEvents: events.length,
    distinctTasks: tasks.size,
    completedTasks,
    failedTasks,
    countByType,
    windowStart,
    windowEnd,
  };
}

// ---------------------------------------------------------------------------
// Generic incremental projection runner
// ---------------------------------------------------------------------------

/**
 * A reducer function that takes the current state and an event, and returns
 * the next state.  Must be a pure function (no mutations of `state`).
 */
export type ProjectionReducer<S> = (state: S, event: AppEvent) => S;

/**
 * Run a custom {@link ProjectionReducer} over an event slice, starting from
 * an optional initial state.
 *
 * @example
 * const nodeCount = buildProjection(events, 0, (count, e) =>
 *   e.type === 'NodeStarted' ? count + 1 : count
 * );
 */
export function buildProjection<S>(
  events: ReadonlyArray<StoredEvent | AppEvent>,
  initialState: S,
  reducer: ProjectionReducer<S>
): S {
  let state = initialState;
  for (const event of events) {
    state = reducer(state, event as AppEvent);
  }
  return state;
}
