/**
 * Shared constants for event-store retention and compaction (issue #383).
 *
 * Kept in their own module so the archive, the retention service and the event
 * store agree on them without importing each other.
 */

import type { EventType } from "./eventTypes";

/**
 * Pseudo task id used by the agent monitor for agent-lifecycle events
 * (`AgentRecovered`, `AgentMarkedOffline`, `AgentFailedOver`).
 *
 * These are emitted on the event bus under `taskId: "system"` but are not task
 * events and have no row in the `tasks` table, so they are explicitly excluded
 * from compaction — see `AgentMonitor`.
 */
export const SYSTEM_TASK_ID = "system";

/**
 * Event types that mark a task as finished.
 *
 * A task is only ever compacted when its highest-`task_seq` event is one of
 * these.  Requiring the event-stream witness (not just a terminal `tasks.status`)
 * guards against compacting a task that was marked terminal by some other code
 * path while its DAG was still running.
 */
export const TERMINAL_EVENT_TYPES = ["TaskCompleted", "TaskFailed"] as const satisfies readonly EventType[];

/** Task statuses that make a task eligible for compaction. */
export const TERMINAL_TASK_STATUSES = ["completed", "failed", "cancelled", "payment_failed"] as const;

export type TerminalTaskStatusName = (typeof TERMINAL_TASK_STATUSES)[number];

/** Type guard for {@link TERMINAL_TASK_STATUSES}. */
export function isTerminalTaskStatus(status: string | undefined): status is TerminalTaskStatusName {
  return status != null && (TERMINAL_TASK_STATUSES as readonly string[]).includes(status);
}
