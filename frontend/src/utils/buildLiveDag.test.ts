import { describe, expect, it } from 'vitest';
import { buildLiveDag } from './buildLiveDag';

const LABELS: Record<string, string> = {
  research: 'Research Agent',
  risk: 'Risk Agent',
  coding: 'Coding Agent',
  design: 'Design Agent',
  report: 'Report Agent',
};

const labelOf = (p: string) => LABELS[p];

describe('buildLiveDag', () => {
  it('returns an empty preview when no agents are selected', () => {
    const dag = buildLiveDag([], labelOf);
    expect(dag).toEqual({ nodes: [], edges: [] });
  });

  it('builds a single isolated node for a single preference', () => {
    const dag = buildLiveDag(['research'], labelOf);
    expect(dag.nodes).toEqual([{ id: 'research', label: 'Research Agent' }]);
    expect(dag.edges).toEqual([]);
  });

  it('chains multiple preferences into a sequential DAG', () => {
    const dag = buildLiveDag(['research', 'coding', 'report'], labelOf);
    expect(dag.nodes.map((n) => n.id)).toEqual(['research', 'coding', 'report']);
    expect(dag.nodes.map((n) => n.label)).toEqual([
      'Research Agent',
      'Coding Agent',
      'Report Agent',
    ]);
    expect(dag.edges).toEqual([
      { source: 'research', target: 'coding' },
      { source: 'coding', target: 'report' },
    ]);
  });

  it('produces a different structure when selections change (drives live preview)', () => {
    const twoAgents = buildLiveDag(['research', 'risk'], labelOf);
    const threeAgents = buildLiveDag(['research', 'coding', 'report'], labelOf);
    expect(threeAgents.nodes).not.toEqual(twoAgents.nodes);
    expect(threeAgents.edges.length).toBeGreaterThan(twoAgents.edges.length);
  });

  it('does not mutate the input preferences array', () => {
    const preferences: string[] = ['research', 'coding'];
    buildLiveDag(preferences as never, labelOf);
    expect(preferences).toEqual(['research', 'coding']);
  });
});
