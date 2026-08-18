/**
 * Canonical type definitions for tasks, DAG nodes, and related statuses.
 *
 * All task-related types MUST be imported from this module.
 * Do NOT re-define TaskStatus, NodeStatus, or DAGEventType elsewhere.
 */

export type TaskStatus = "queued" | "running" | "completed" | "cancelled" | "failed";

/** Node-level statuses used by the coordinator during DAG execution. */
export type NodeStatus = "pending" | "running" | "completed" | "failed";

export interface DAGNode {
  nodeId: string;
  type: string;
  dependencies: string[];
  status: NodeStatus;
  result?: any;
  error?: string;
  prompt?: string;
  description?: string;
}

export interface Task {
  id: string;
  prompt: string;
  walletPublicKey: string;
  status: TaskStatus;
  dag: DAGNode[];
  createdAt: string;
  updatedAt: string;
  requestId?: string;
}

/** Events emitted by the coordinator */
export type DAGEventType =
  | "node_started"
  | "node_completed"
  | "node_failed"
  | "payment_locked"
  | "payment_released"
  | "task_completed"
  | "task_failed";

export interface DAGEvent {
  type: DAGEventType;
  taskId: string;
  nodeId?: string;
  timestamp: string;
  payload?: unknown;
  /**
   * Per-task monotonic sequence number assigned by the EventBus when the event
   * is emitted. Starts at 0 for each taskId and increments by 1 per event, so
   * a client can resume a stream from a known cursor. Absent only on events
   * that have not yet passed through the bus.
   */
  seq?: number;
}
