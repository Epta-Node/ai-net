/**
 * `RECONCILIATION_EVENT` emission (issue #496).
 *
 * Every drift the reconciliation service detects, and every remediation it
 * applies, is published as a {@link ReconciliationEventEvent}. The event is
 * appended to the canonical event store (so it survives a restart and can be
 * replayed / projected like any other task event) and delivered to any
 * in-process subscribers.
 *
 * Failure to publish is deliberately non-fatal: a broken event sink must never
 * prevent the reconciliation pass from remediating real money drift. Failures
 * are logged and swallowed.
 */

import { eventBus } from "../coordinator/eventBus";
import type { EventStore } from "../events/eventStore";
import type { ReconciliationEventEvent } from "../events/eventTypes";
import { createLogger } from "../utils/logger";

const log = createLogger({ component: "reconciliationEvents" });

/**
 * Sink for reconciliation events.
 *
 * The default implementation appends to the process-wide event bus/store. Tests
 * (and alternative deployments) can substitute an in-memory sink.
 */
export interface ReconciliationEventSink {
  emit(event: ReconciliationEventEvent): void;
}

/** An in-memory sink. Used by tests and by callers inspecting a single run. */
export function createInMemoryReconciliationEventSink(): ReconciliationEventSink & {
  events: ReconciliationEventEvent[];
} {
  const events: ReconciliationEventEvent[] = [];
  return {
    events,
    emit(event: ReconciliationEventEvent): void {
      events.push(event);
    },
  };
}

/**
 * The production sink: append to the event bus (which persists to the event
 * store before notifying subscribers) *or* to an explicitly supplied store.
 */
export function createEventBusReconciliationEventSink(
  store?: EventStore,
): ReconciliationEventSink {
  return {
    emit(event: ReconciliationEventEvent): void {
      try {
        if (store) {
          store.append(event);
          return;
        }
        // The bus persists the event and stamps a per-task sequence number.
        eventBus.emit(event.taskId, {
          type: event.type as never,
          taskId: event.taskId,
          ...(event.payload.nodeId ? { nodeId: event.payload.nodeId } : {}),
          timestamp: event.occurredAt,
          payload: event.payload,
        });
      } catch (err) {
        // Telemetry must never break remediation.
        log.error(
          { err, driftType: event.payload.driftType },
          "failed to emit RECONCILIATION_EVENT",
        );
      }
    },
  };
}

/** A sink that swallows everything — the default when no store is configured. */
export function createNoopReconciliationEventSink(): ReconciliationEventSink {
  return {
    emit(): void {
      /* no-op */
    },
  };
}
