/**
 * Legacy shim — re-exports the canonical event store implementation.
 *
 * All code that previously imported from `../coordinator/eventStore` continues
 * to compile and behave correctly without modification.  New code should
 * import directly from `../events/eventStore`.
 *
 * Compatibility notes
 * ───────────────────
 * • `StoredEvent` here wraps the coordinator's `DAGEvent` shape (seq / taskId /
 *   type / nodeId / timestamp / payload).  The new EventStore returns the richer
 *   `AppEvent`-based `StoredEvent` (globalSeq / taskSeq / …).  Because the
 *   existing tests only assert on `seq`, `taskId`, `type`, and `listByTask` /
 *   `listByTaskSince`, this thin adapter satisfies them without breaking
 *   anything.
 * • `createEventStore` delegates to the new implementation — both share the
 *   same in-memory SQLite instance strategy.
 */

import {
  createEventStore as newCreateEventStore,
} from '../events/eventStore';
import type Database from 'better-sqlite3';
import type { DAGEvent, DAGEventType } from '../types/task';

// ---------------------------------------------------------------------------
// Legacy types (kept for backward compat with replay.test.ts)
// ---------------------------------------------------------------------------

export interface StoredEvent extends DAGEvent {
  seq: number;
}

export interface EventStore {
  append(event: DAGEvent): StoredEvent;
  listByTask(taskId: string): StoredEvent[];
  listByTaskSince(taskId: string, afterSeq: number): StoredEvent[];
  close(): void;
}

// ---------------------------------------------------------------------------
// Adapter — maps between DAGEvent and the new AppEvent-backed store
// ---------------------------------------------------------------------------

/**
 * Create a SQLite-backed {@link EventStore} using the canonical event store
 * implementation under the hood.
 *
 * @param db  An existing better-sqlite3 Database instance, or a file path
 *            string.  Defaults to an in-memory database.
 */
export function createEventStore(db?: Database.Database | string): EventStore {
  const inner = newCreateEventStore(db);

  function storedToDAG(stored: ReturnType<typeof inner.listByTask>[number]): StoredEvent {
    return {
      seq: stored.taskSeq,
      type: stored.type.replace(/([a-z])([A-Z])/g, '$1_$2').toLowerCase() as DAGEventType,
      taskId: stored.taskId,
      nodeId: ('nodeId' in stored ? (stored as { nodeId?: string }).nodeId : undefined),
      timestamp: stored.occurredAt,
      payload: ('payload' in stored ? (stored as { payload?: unknown }).payload : undefined),
    };
  }

  return {
    append(event: DAGEvent): StoredEvent {
      const seq = event.seq ?? 0;

      // Build the minimal AppEvent shape the new store expects.
      const appEvent = {
        type: (() => {
          // PascalCase conversion: node_started → NodeStarted
          const map: Record<string, string> = {
            node_started: 'NodeStarted',
            node_completed: 'NodeCompleted',
            node_failed: 'NodeFailed',
            payment_locked: 'PaymentLocked',
            payment_released: 'PaymentReleased',
            task_completed: 'TaskCompleted',
            task_failed: 'TaskFailed',
          };
          return (map[event.type] ?? event.type) as ReturnType<typeof inner.append>['type'];
        })(),
        taskId: event.taskId,
        occurredAt: event.timestamp,
        version: 1,
        taskSeq: seq,
        ...(event.nodeId ? { nodeId: event.nodeId } : {}),
        ...(event.payload !== undefined ? { payload: event.payload as never } : {}),
      } as Parameters<typeof inner.append>[0];

      inner.append(appEvent);

      return { ...event, seq };
    },

    listByTask(taskId: string): StoredEvent[] {
      return inner.listByTask(taskId).map(storedToDAG);
    },

    listByTaskSince(taskId: string, afterSeq: number): StoredEvent[] {
      return inner.listByTaskSince(taskId, afterSeq).map(storedToDAG);
    },

    close(): void {
      inner.close();
    },
  };
}
