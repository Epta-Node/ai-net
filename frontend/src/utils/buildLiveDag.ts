import type { AgentPreference, DagEdge, DagNode } from '../services/taskService';
import type { DAGEvent } from '../types/api';

export interface LiveDag {
  nodes: DagNode[];
  edges: DagEdge[];
}

/**
 * Builds the execution DAG preview from the currently selected agent
 * preferences so the wizard's review step can reflect selections in real time
 * without a round-trip to the server.
 *
 * Agents run sequentially in the order they appear in `preferences`: each node
 * depends on the previous one ("research → coding → report" for a typical
 * task). This matches the chained dependency shape of the mock/backend preview.
 *
 * Pure — never mutates its inputs — so it can be called on every render.
 */
export function buildLiveDag(
  preferences: AgentPreference[],
  labelOf: (preference: AgentPreference) => string,
): LiveDag {
  const nodes: DagNode[] = preferences.map((preference) => ({
    id: preference,
    label: labelOf(preference),
  }));

  const edges: DagEdge[] = [];
  for (let i = 0; i < preferences.length - 1; i += 1) {
    edges.push({ source: preferences[i], target: preferences[i + 1] });
  }

  return { nodes, edges };
}

// ─── Live execution state (#818) ─────────────────────────────────────────────

export type NodeExecState = 'pending' | 'running' | 'completed' | 'failed' | 'skipped';

export interface NodeExecInfo {
  state: NodeExecState;
  startedAt?: string;
  endedAt?: string;
  output?: string;
  error?: string;
}

export type LiveDagNode<N extends { id: string } = DagNode> = N & { exec: NodeExecInfo };

function payloadText(
  payload: DAGEvent['payload'],
  ...keys: Array<'content' | 'summary' | 'markdown' | 'message' | 'error'>
): string | undefined {
  if (typeof payload === 'string') return payload;
  if (!payload) return undefined;
  for (const key of keys) {
    const value = payload[key];
    if (typeof value === 'string' && value) return value;
  }
  return undefined;
}

/**
 * Folds the WebSocket event stream into the latest state per node. Events are
 * applied in `seq` order (falling back to arrival order), so a late
 * `node_started` can't move a finished node back to running.
 */
export function deriveNodeStates(events: DAGEvent[]): Record<string, NodeExecInfo> {
  const ordered = events
    .map((event, index) => ({ event, index }))
    .sort((a, b) => (a.event.seq ?? a.index) - (b.event.seq ?? b.index));

  const states: Record<string, NodeExecInfo> = {};

  for (const { event } of ordered) {
    if (!event.nodeId) continue;
    const prev = states[event.nodeId] ?? { state: 'pending' as const };
    const terminal = prev.state === 'completed' || prev.state === 'failed';

    if (event.type === 'node_started' && !terminal) {
      states[event.nodeId] = { ...prev, state: 'running', startedAt: event.timestamp };
    } else if (event.type === 'node_completed') {
      states[event.nodeId] = {
        ...prev,
        state: 'completed',
        endedAt: event.timestamp,
        output: payloadText(event.payload, 'content', 'summary', 'markdown', 'message'),
      };
    } else if (event.type === 'node_failed') {
      states[event.nodeId] = {
        ...prev,
        state: 'failed',
        endedAt: event.timestamp,
        error: payloadText(event.payload, 'error', 'message') ?? 'Agent failed',
      };
    }
  }

  return states;
}

/** True once the stream reported the whole task as finished. */
export function isTaskFinished(events: DAGEvent[]): boolean {
  return events.some((e) => e.type === 'task_completed' || e.type === 'task_failed');
}

/**
 * Applies derived states to the rendered nodes. Pure: returns new node objects.
 * Nodes with no events stay `pending`, or become `skipped` once the task has
 * finished without ever starting them.
 */
export function applyNodeStates<N extends { id: string }>(
  nodes: N[],
  states: Record<string, NodeExecInfo>,
  options: { taskFinished?: boolean } = {},
): Array<LiveDagNode<N>> {
  return nodes.map((node) => {
    const info = states[node.id];
    if (info && !(options.taskFinished && info.state === 'pending')) return { ...node, exec: info };
    return { ...node, exec: { ...info, state: options.taskFinished ? 'skipped' : 'pending' } };
  });
}

export type EdgeExecState = 'idle' | 'active' | 'completed' | 'failed';

/** Edge colour/animation: travelling dot while the target runs after its source finished. */
export function edgeExecState(source: NodeExecState, target: NodeExecState): EdgeExecState {
  if (target === 'failed') return 'failed';
  if (source === 'completed' && target === 'running') return 'active';
  if (source === 'completed' && target === 'completed') return 'completed';
  return 'idle';
}

/** Duration in ms between start and end, when both are known. */
export function nodeDurationMs(info: NodeExecInfo): number | undefined {
  if (!info.startedAt || !info.endedAt) return undefined;
  const ms = Date.parse(info.endedAt) - Date.parse(info.startedAt);
  return Number.isFinite(ms) && ms >= 0 ? ms : undefined;
}
