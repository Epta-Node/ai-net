import type { AgentPreference, DagEdge, DagNode } from '../services/taskService';

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
