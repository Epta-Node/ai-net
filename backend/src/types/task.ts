/**
 * Canonical type definitions for tasks, DAG nodes, and related statuses.
 *
 * All task-related types MUST be imported from this module.
 * Do NOT re-define TaskStatus, NodeStatus, or DAGEventType elsewhere.
 */

import type { QualityScore } from "../services/qualityScorer.types";

export type TaskStatus =
  | "queued"
  | "running"
  | "completed"
  | "cancelled"
  | "failed"
  /**
   * Terminal: every DAG node succeeded but an escrow release failed after the
   * work was done (#852). Kept distinct from `failed` so operators and
   * reconciliation can tell payment faults from agent faults.
   */
  | "payment_failed";

/** Node-level statuses used by the coordinator during DAG execution. */
export type NodeStatus = "pending" | "running" | "completed" | "failed" | "cancelled";

export interface DAGNode {
  nodeId: string;
  type: string;
  dependencies: string[];
  status: NodeStatus;
  result?: any;
  error?: string;
  prompt?: string;
  description?: string;
  /**
   * Quality scoring result attached after agent execution, persisted with the
   * node's task execution record. Absent when scoring is disabled or fails.
   */
  quality?: QualityScore;
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
  /** Trace identifier (correlationId) propagated from the triggering request. */
  traceId?: string;
}

/** Events emitted by the coordinator */
export type DAGEventType =
  | "node_started"
  | "node_completed"
  | "node_failed"
  | "payment_locked"
  | "payment_released"
  | "task_completed"
  | "task_failed"
  /** A job exhausted its retry budget and was parked in the DLQ (issue #802). */
  | "job.dead_lettered"
  | "AgentFailedOver"
  | "AgentRecovered"
  | "AgentMarkedOffline";

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
