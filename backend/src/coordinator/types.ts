/** DAG node statuses */
export type NodeStatus = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';

/** A single node in the execution DAG */
export interface DAGNode {
  nodeId: string;
  /** Agent type / capability required */
  agentType: string;
  /** Prompt fragment for this node */
  prompt: string;
  /** nodeIds this node depends on */
  dependsOn: string[];
  status: NodeStatus;
  result?: unknown;
  error?: string;
}

/** Persisted task record */
export interface Task {
  taskId: string;
  prompt: string;
  walletPublicKey: string;
  status: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';
  dag: DAGNode[];
  createdAt: string;
  updatedAt: string;
}

/** Events emitted by the coordinator */
export type DAGEventType =
  | 'node_started'
  | 'node_completed'
  | 'node_failed'
  | 'payment_locked'
  | 'payment_released'
  | 'task_completed'
  | 'task_failed'
  | 'task_cancelled';

export interface DAGEvent {
  type: DAGEventType;
  taskId: string;
  nodeId?: string;
  timestamp: string;
  payload?: unknown;
}
