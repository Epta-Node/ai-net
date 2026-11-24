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
  id?: string;
  label?: string;
}

export type DagNode = DAGNode;

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

/** Platform-wide LLM spend rollup (Issue #390). */
export interface CostTotals {
  tasks: number;
  calls: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  costUsd: number;
  overBudgetTasks: number;
  costLast7d?: TimePoint[];
}

export interface NetworkStats {
  totalAgents: number;
  totalTasks: number;
  totalXLMTransacted: number;
  uptimePercent: number;
  tasksLast24h?: TimePoint[];
  xlmLast24h?: TimePoint[];
  /** 7-day daily series for sparklines */
  tasksLast7d?: TimePoint[];
  xlmLast7d?: TimePoint[];
  /** LLM spend rollup. Absent on older backends. */
  cost?: CostTotals;
}

/** One node's slice of a task's LLM spend (Issue #390). */
export interface TaskNodeCost {
  nodeId: string;
  agentId: string;
  agentType: string;
  model: string;
  calls: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  costUsd: number;
  trimmed: boolean;
  budgetExhausted: boolean;
}

/** A task's token budget and what it actually consumed. */
export interface TaskCost {
  taskId: string;
  budgetTokens: number;
  usedTokens: number;
  remainingTokens: number;
  costUsd: number;
  currency: string;
  exceeded: boolean;
  calls: number;
  /** True while the task is still running and these numbers are provisional. */
  inProgress: boolean;
  agents: TaskNodeCost[];
}

/** A persisted watchdog alert (Issue #379). */
export interface AgentWatchdogAlert {
  id: string;
  agentId: string;
  type: 'heartbeat_stale' | 'quarantined' | 'evicted' | 'recovered' | 'eviction_failed';
  severity: 'warning' | 'critical';
  message: string;
  lastSeenAt: string | null;
  detectedAt: string;
  resolvedAt: string | null;
  metadata: Record<string, unknown>;
}

/** An agent currently inside its heartbeat grace period (Issue #379). */
export interface QuarantinedAgent {
  agentId: string;
  capabilities: string[];
  endpoint: string;
  lastSeenAt: string;
  silentForMs: number | null;
  quarantinedSince: string | null;
  reputationScore: number;
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
  /** Per-task monotonic sequence cursor used to resume a stream after a drop. */
  seq?: number;
  payload?: DAGEventPayload | string;
}

/** Generic cursor-paginated page returned by v2 list endpoints. */
export interface CursorPage<T> {
  items: T[];
  pagination: {
    limit: number;
    nextCursor: string | null;
    hasNextPage: boolean;
  };
  _links?: {
    self: string;
    next?: string;
  };
}

export type CursorPageEnvelope<T> = CursorPage<T> & {
  data?: CursorPage<T>;
};

