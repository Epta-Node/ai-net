/**
 * Canonical event-type definitions for the ai-net event sourcing system.
 *
 * Design decisions
 * ────────────────
 * • Every event is a discriminated union on the `type` field so TypeScript can
 *   narrow payload shapes without casting.
 * • `version` travels with every event record so consumers can handle schema
 *   evolution without a separate schema-registry lookup.
 * • `globalSeq` and `taskSeq` are assigned by the EventStore and are absent
 *   (undefined) on events that have not yet been persisted.
 * • All monetary amounts are in stroops (integer) to avoid floating-point
 *   rounding when dealing with Stellar payments.
 */

// ---------------------------------------------------------------------------
// Shared schema
// ---------------------------------------------------------------------------

/** Current schema version emitted by this code.  Increment when a payload
 *  shape changes in a backward-incompatible way.
 *
 * Version history:
 *  - v1: Initial event schema.
 *  - v2: Added optional fields to TaskCreated (agentId, durationMs),
 *       NodeStarted (timeoutMs), NodeCompleted (durationMs),
 *       NodeFailed (retryCount), PaymentLocked (xlmAmount),
 *       PaymentReleased (ledgerSequence), TaskCompleted (durationMs),
 *       TaskFailed (failedStage).
 */
export const CURRENT_EVENT_VERSION = 2 as const;

/** The earliest schema version this codebase can read. */
export const MIN_SUPPORTED_EVENT_VERSION = 1 as const;

/** Base fields carried by every event. */
export interface BaseEvent {
  /** Discriminator — identifies the concrete event shape. */
  type: EventType;
  /** The task this event belongs to. */
  taskId: string;
  /** ISO-8601 wall-clock time when the event occurred. */
  occurredAt: string;
  /** Schema version (defaults to CURRENT_EVENT_VERSION if omitted). */
  version: number;
  /**
   * Globally-ordered sequence number across all tasks. Assigned by the
   * EventStore on append; absent before persistence.
   */
  globalSeq?: number;
  /**
   * Per-task monotonic cursor starting at 0. Assigned by the EventBus before
   * any subscriber sees the event; absent on events not yet emitted.
   */
  taskSeq?: number;
}

// ---------------------------------------------------------------------------
// Payload shapes — one interface per event type
// ---------------------------------------------------------------------------

export interface TaskCreatedPayload {
  prompt: string;
  walletPublicKey: string;
  /** DAG node count at creation time. */
  dagSize: number;
  /** v2: The agent that was dispatched (populated after dispatch). */
  agentId?: string;
  /** v2: Duration from creation to completion in milliseconds. */
  durationMs?: number;
}

export interface NodeStartedPayload {
  agentType: string;
  /** v2: Maximum time allowed for this node before timeout. */
  timeoutMs?: number;
}

export interface NodeCompletedPayload {
  /** Arbitrary result returned by the agent. */
  result: unknown;
  /** v2: Agent response time in milliseconds. */
  durationMs?: number;
}

export interface NodeFailedPayload {
  error: string;
  /** v2: Number of retry attempts before failure. */
  retryCount?: number;
}

export interface PaymentLockedPayload {
  /** Stellar claimable-balance ID. */
  balanceId: string;
  /** Amount in stroops. */
  amountStroops: number;
  /** v2: XLM equivalent of the locked amount. */
  xlmAmount?: number;
}

export interface PaymentReleasedPayload {
  /** Stellar transaction hash. */
  txHash: string;
  /** v2: Stellar ledger sequence at which the release was confirmed. */
  ledgerSequence?: number;
}

// task_completed and task_failed carry no additional payload beyond BaseEvent.

// ---------------------------------------------------------------------------
// Discriminated union
// ---------------------------------------------------------------------------

export type EventType =
  | 'TaskCreated'
  | 'NodeStarted'
  | 'NodeCompleted'
  | 'NodeFailed'
  | 'PaymentLocked'
  | 'PaymentReleased'
  | 'TaskCompleted'
  | 'TaskFailed';

export interface TaskCreatedEvent extends BaseEvent {
  type: 'TaskCreated';
  payload: TaskCreatedPayload;
}

export interface NodeStartedEvent extends BaseEvent {
  type: 'NodeStarted';
  /** DAG node this event relates to. */
  nodeId: string;
  payload: NodeStartedPayload;
}

export interface NodeCompletedEvent extends BaseEvent {
  type: 'NodeCompleted';
  nodeId: string;
  payload: NodeCompletedPayload;
}

export interface NodeFailedEvent extends BaseEvent {
  type: 'NodeFailed';
  nodeId: string;
  payload: NodeFailedPayload;
}

export interface PaymentLockedEvent extends BaseEvent {
  type: 'PaymentLocked';
  nodeId: string;
  payload: PaymentLockedPayload;
}

export interface PaymentReleasedEvent extends BaseEvent {
  type: 'PaymentReleased';
  nodeId: string;
  payload: PaymentReleasedPayload;
}

export interface TaskCompletedEvent extends BaseEvent {
  type: 'TaskCompleted';
  payload?: {
    /** v2: Total duration from task creation to completion in milliseconds. */
    durationMs?: number;
  };
}

export interface TaskFailedEvent extends BaseEvent {
  type: 'TaskFailed';
  payload?: {
    error?: string;
    /** v2: The stage at which the task failed. */
    failedStage?: string;
  };
}

/** Union of all typed event variants. */
export type AppEvent =
  | TaskCreatedEvent
  | NodeStartedEvent
  | NodeCompletedEvent
  | NodeFailedEvent
  | PaymentLockedEvent
  | PaymentReleasedEvent
  | TaskCompletedEvent
  | TaskFailedEvent;

// ---------------------------------------------------------------------------
// Guards
// ---------------------------------------------------------------------------

export function isTaskCreated(e: AppEvent): e is TaskCreatedEvent {
  return e.type === 'TaskCreated';
}

export function isNodeStarted(e: AppEvent): e is NodeStartedEvent {
  return e.type === 'NodeStarted';
}

export function isNodeCompleted(e: AppEvent): e is NodeCompletedEvent {
  return e.type === 'NodeCompleted';
}

export function isNodeFailed(e: AppEvent): e is NodeFailedEvent {
  return e.type === 'NodeFailed';
}

export function isPaymentLocked(e: AppEvent): e is PaymentLockedEvent {
  return e.type === 'PaymentLocked';
}

export function isPaymentReleased(e: AppEvent): e is PaymentReleasedEvent {
  return e.type === 'PaymentReleased';
}

export function isTaskCompleted(e: AppEvent): e is TaskCompletedEvent {
  return e.type === 'TaskCompleted';
}

export function isTaskFailed(e: AppEvent): e is TaskFailedEvent {
  return e.type === 'TaskFailed';
}

// ---------------------------------------------------------------------------
// Factory helpers — enforce required fields and stamp the current version
// ---------------------------------------------------------------------------

function nowIso(): string {
  return new Date().toISOString();
}

export function makeTaskCreated(
  taskId: string,
  payload: TaskCreatedPayload,
  occurredAt = nowIso()
): TaskCreatedEvent {
  return { type: 'TaskCreated', taskId, occurredAt, version: CURRENT_EVENT_VERSION, payload };
}

export function makeNodeStarted(
  taskId: string,
  nodeId: string,
  payload: NodeStartedPayload,
  occurredAt = nowIso()
): NodeStartedEvent {
  return { type: 'NodeStarted', taskId, nodeId, occurredAt, version: CURRENT_EVENT_VERSION, payload };
}

export function makeNodeCompleted(
  taskId: string,
  nodeId: string,
  payload: NodeCompletedPayload,
  occurredAt = nowIso()
): NodeCompletedEvent {
  return { type: 'NodeCompleted', taskId, nodeId, occurredAt, version: CURRENT_EVENT_VERSION, payload };
}

export function makeNodeFailed(
  taskId: string,
  nodeId: string,
  payload: NodeFailedPayload,
  occurredAt = nowIso()
): NodeFailedEvent {
  return { type: 'NodeFailed', taskId, nodeId, occurredAt, version: CURRENT_EVENT_VERSION, payload };
}

export function makePaymentLocked(
  taskId: string,
  nodeId: string,
  payload: PaymentLockedPayload,
  occurredAt = nowIso()
): PaymentLockedEvent {
  return { type: 'PaymentLocked', taskId, nodeId, occurredAt, version: CURRENT_EVENT_VERSION, payload };
}

export function makePaymentReleased(
  taskId: string,
  nodeId: string,
  payload: PaymentReleasedPayload,
  occurredAt = nowIso()
): PaymentReleasedEvent {
  return { type: 'PaymentReleased', taskId, nodeId, occurredAt, version: CURRENT_EVENT_VERSION, payload };
}

export function makeTaskCompleted(taskId: string, occurredAt = nowIso()): TaskCompletedEvent {
  return { type: 'TaskCompleted', taskId, occurredAt, version: CURRENT_EVENT_VERSION };
}

export function makeTaskFailed(
  taskId: string,
  error?: string,
  occurredAt = nowIso()
): TaskFailedEvent {
  return {
    type: 'TaskFailed',
    taskId,
    occurredAt,
    version: CURRENT_EVENT_VERSION,
    payload: error !== undefined ? { error } : undefined,
  };
}
