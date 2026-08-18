export type AgentPreference = 'research' | 'risk' | 'coding' | 'design' | 'report';

export interface TaskSubmissionPayload {
  prompt: string;
  maxBudgetXLM: number;
  agentPreferences: AgentPreference[];
}

export type NodeStatus = 'pending' | 'running' | 'completed' | 'failed';

export interface DAGNode {
  nodeId: string;
  agentType: string;
  prompt: string;
  dependsOn: string[];
  status: NodeStatus;
  result?: unknown;
  error?: string;
}

export interface TaskResponse {
  taskId: string;
  id?: string;
  prompt: string;
  walletPublicKey: string;
  status: 'queued' | 'running' | 'completed' | 'failed';
  dag: DAGNode[];
  createdAt: string;
  updatedAt: string;
}

export interface DagNode {
  id: string;
  label: string;
}

export interface DagEdge {
  source: string;
  target: string;
}

export interface TaskSubmitResponse {
  taskId: string;
  dagPreview: {
    nodes: DagNode[];
    edges: DagEdge[];
  };
  status: string;
}

export interface AgentRecord {
  id: string;
  name: string;
  capabilities: string[];
  price: number;
  reputation: number;
  status: 'active' | 'inactive' | string;
  endpoint?: string;
  registrationTxHash?: string;
}

export interface TimePoint {
  timestamp: string;
  value: number;
}

export interface NetworkStats {
  totalAgents: number;
  totalTasks: number;
  totalXLMTransacted: number;
  uptimePercent: number;
  tasksLast24h?: TimePoint[];
  xlmLast24h?: TimePoint[];
}

export interface PaymentEvent {
  amount: string;
  direction: 'in' | 'out';
  counterparty: string;
  memo?: string;
  timestamp: string;
  txHash: string;
}

export type DAGEventType =
  | 'node_started'
  | 'node_completed'
  | 'node_failed'
  | 'payment_locked'
  | 'payment_released'
  | 'task_completed'
  | 'task_failed';

// Covers all known shapes of DAG event payloads
// Each event type may carry different fields, so we allow additional properties
// while still providing type safety for the common fields.
export interface DAGEventPayload {
  status?: string;
  message?: string;
  error?: string;
  txHash?: string;
  summary?: string;
  content?: string;
  markdown?: string;
  output?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface DAGEvent {
  type: DAGEventType;
  taskId: string;
  nodeId?: string;
  timestamp: string;
  payload?: DAGEventPayload | string;
}

