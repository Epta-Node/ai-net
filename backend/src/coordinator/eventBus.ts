/**
 * In-process pub/sub bus with integrated event-store persistence.
 *
 * Every event emitted on the bus is:
 *  1. Stamped with a per-task monotonic `taskSeq` (starts at 0 per taskId).
 *  2. Persisted to the SQLite-backed EventStore BEFORE any per-task subscriber
 *     receives it — guaranteeing that the row exists by the time WebSocket
 *     handlers replay "events since cursor".
 *  3. Delivered to per-task subscribers.
 *
 * The EventStore is injected at construction time so it can be replaced with a
 * custom instance (e.g. a file-backed DB for production, or a fresh in-memory
 * DB in tests).  If no store is supplied the bus creates a default in-memory
 * instance — this preserves the zero-config behaviour used throughout the test
 * suite.
 *
 * Backward compatibility
 * ──────────────────────
 * The exported `eventBus` singleton is still the primary integration point for
 * the coordinator, stream routes, and tests.  The `subscribe`, `subscribeAll`,
 * and `emit` signatures are unchanged.
 *
 * The coordinator's legacy `createEventStore` import path
 * (`../coordinator/eventStore`) is kept as a re-export so the existing
 * `tests/replay.test.ts` and any other consumers continue to compile and pass
 * without modification.
 */

import { EventEmitter } from 'events';
import type { DAGEvent } from '../types/task';
import { createEventStore } from '../events/eventStore';
import type { EventStore } from '../events/eventStore';
import type { AppEvent } from '../events/eventTypes';
import { CURRENT_EVENT_VERSION } from '../events/eventTypes';

// ---------------------------------------------------------------------------
// Adapter — convert a legacy DAGEvent to AppEvent
// ---------------------------------------------------------------------------

/**
 * Map a coordinator `DAGEvent` to the richer `AppEvent` shape expected by the
 * new EventStore.  The mapping uses PascalCase type names to match the
 * EventType union in eventTypes.ts.
 */
const TYPE_MAP: Record<string, AppEvent['type']> = {
  node_started: 'NodeStarted',
  node_completed: 'NodeCompleted',
  node_failed: 'NodeFailed',
  payment_locked: 'PaymentLocked',
  payment_released: 'PaymentReleased',
  task_completed: 'TaskCompleted',
  task_failed: 'TaskFailed',
};

function dagEventToAppEvent(event: DAGEvent): AppEvent {
  const mapped = TYPE_MAP[event.type] ?? (event.type as AppEvent['type']);

  const base = {
    type: mapped,
    taskId: event.taskId,
    occurredAt: event.timestamp,
    version: CURRENT_EVENT_VERSION,
    taskSeq: event.seq,
  } as const;

  // Attach nodeId only for node-level events so TypeScript narrowing stays
  // accurate on the stored events side.
  if (event.nodeId) {
    return {
      ...base,
      nodeId: event.nodeId,
      payload: (event.payload ?? {}) as never,
    } as AppEvent;
  }

  return {
    ...base,
    payload: (event.payload ?? undefined) as never,
  } as AppEvent;
}

// ---------------------------------------------------------------------------
// EventBus
// ---------------------------------------------------------------------------

export interface EventBusOptions {
  /**
   * Provide a pre-configured EventStore.  When omitted the bus creates a
   * default in-memory SQLite store.
   */
  store?: EventStore;
  /** Maximum number of listeners (default: 100). */
  maxListeners?: number;
}

class EventBus extends EventEmitter {
  /** Internal channel that receives every event regardless of taskId. */
  private static readonly ALL = '__all__';

  /** Next sequence number to assign per taskId (counter starts at 0). */
  private readonly nextSeqByTask = new Map<string, number>();

  /** Underlying append-only event store. */
  readonly store: EventStore;

  constructor(options: EventBusOptions = {}) {
    super();
    this.store = options.store ?? createEventStore();
    this.setMaxListeners(options.maxListeners ?? 100);

    // ── Rehydrate seq counters from the DB ──────────────────────────────────
    // On restart the in-memory Map is empty, so the first event for any
    // in-progress task would be stamped seq=0 — colliding with the
    // UNIQUE(task_id, task_seq) constraint and getting silently swallowed.
    // Seed each counter from the highest task_seq already stored so that
    // post-restart events continue from where the previous run left off.
    try {
      const maxSeqs = this.store.maxTaskSeqPerTask();
      for (const [taskId, maxSeq] of maxSeqs) {
        // next seq to assign = max already stored + 1
        this.nextSeqByTask.set(taskId, maxSeq + 1);
      }
    } catch (err) {
      // Surface rehydration errors — a silent failure here means duplicate
      // seq=0 events after restart, which is worse than a startup warning.
      console.error('[eventBus] failed to rehydrate taskSeq counters from DB:', err);
    }

    // Wire the persistence recorder: every event is persisted BEFORE per-task
    // subscribers see it so the DB row exists during their handlers.
    this.on(EventBus.ALL, (event: DAGEvent) => {
      try {
        this.store.append(dagEventToAppEvent(event));
      } catch (err) {
        // Persistence failures must not crash the process — log and continue.
        // The event has already been emitted to live subscribers.
        console.error('[eventBus] failed to persist event:', err);
      }
    });
  }

  emit(taskId: string, event: DAGEvent): boolean {
    // Stamp a per-task monotonic sequence number BEFORE any subscriber sees
    // the event, so the persistence recorder and every live handler observe
    // the same taskSeq.  Starts at 0 for each taskId.
    const seq = this.nextSeqByTask.get(taskId) ?? 0;
    this.nextSeqByTask.set(taskId, seq + 1);
    event.seq = seq;

    // Notify the persistence recorder FIRST (see constructor), then per-task
    // subscribers.  The ALL channel listener runs synchronously here before
    // the per-task emit below, ensuring the row is committed before any
    // WebSocket handler drains "events since cursor".
    super.emit(EventBus.ALL, event);
    return super.emit(taskId, event);
  }

  subscribe(taskId: string, handler: (e: DAGEvent) => void): () => void {
    this.on(taskId, handler);
    return () => this.off(taskId, handler);
  }

  /** Subscribe to every event on the bus (used by the persistence recorder). */
  subscribeAll(handler: (e: DAGEvent) => void): () => void {
    this.on(EventBus.ALL, handler);
    return () => this.off(EventBus.ALL, handler);
  }
}

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

export const eventBus = new EventBus();
