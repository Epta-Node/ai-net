import axios from 'axios';
import * as fs from 'fs';
import {
  decomposeTask,
  assignAgents,
  executeDAG,
  handleAgentFailure,
  CyclicDAGError,
  DAGNode,
} from '../src/coordinator/coordinator';
import { registerAgent, clearRegistry } from '../src/registry/registry';

jest.mock('axios');
jest.mock('fs', () => ({ mkdirSync: jest.fn(), writeFileSync: jest.fn() }));

const mockedAxios = axios as jest.Mocked<typeof axios>;
const mockedFs = fs as jest.Mocked<typeof fs>;

// ── Fixtures ──────────────────────────────────────────────────────────────────

function makeFiveNodeDAG(): DAGNode[] {
  return [
    { id: 'n1', taskType: 'research', dependsOn: [],            status: 'pending' },
    { id: 'n2', taskType: 'risk',     dependsOn: ['n1'],        status: 'pending' },
    { id: 'n3', taskType: 'coding',   dependsOn: ['n1'],        status: 'pending' },
    { id: 'n4', taskType: 'design',   dependsOn: ['n2', 'n3'], status: 'pending' },
    { id: 'n5', taskType: 'report',   dependsOn: ['n4'],        status: 'pending' },
  ];
}

beforeEach(() => clearRegistry());

// ── decomposeTask ─────────────────────────────────────────────────────────────

describe('decomposeTask', () => {
  it('returns a valid DAG with ≥ 3 nodes for a multi-step prompt', async () => {
    const mockNodes = [
      { id: 'a', taskType: 'research', dependsOn: [] },
      { id: 'b', taskType: 'risk',     dependsOn: ['a'] },
      { id: 'c', taskType: 'report',   dependsOn: ['b'] },
    ];
    mockedAxios.post.mockResolvedValueOnce({
      data: { choices: [{ message: { content: JSON.stringify(mockNodes) } }] },
    });

    const dag = await decomposeTask('Generate a market-entry report for solar energy in Southeast Asia');
    expect(dag.length).toBeGreaterThanOrEqual(3);
    expect(dag[0].status).toBe('pending');
    dag.forEach((n) => expect(n).toHaveProperty('taskType'));
  });
});

// ── assignAgents ──────────────────────────────────────────────────────────────

describe('assignAgents', () => {
  it('assigns cheapest agent matching taskType', () => {
    registerAgent({ id: 'expensive', name: 'E', capability: 'research', priceXLM: 10, stellarAddress: '' });
    registerAgent({ id: 'cheap',     name: 'C', capability: 'research', priceXLM: 2,  stellarAddress: '' });

    const dag: DAGNode[] = [{ id: 'n1', taskType: 'research', dependsOn: [], status: 'pending' }];
    assignAgents(dag);
    expect(dag[0].assignedAgent).toBe('cheap');
  });
});

// ── Topological order ─────────────────────────────────────────────────────────

describe('executeDAG — topological order', () => {
  it('no node starts before its dependencies resolve', async () => {
    const order: string[] = [];
    const dag = makeFiveNodeDAG();
    ['research', 'risk', 'coding', 'design', 'report'].forEach((cap) =>
      registerAgent({ id: cap, name: cap, capability: cap, priceXLM: 1, stellarAddress: '' }),
    );
    assignAgents(dag);

    const runNode = async (node: DAGNode, _ctx: Record<string, unknown>) => {
      node.dependsOn.forEach((dep) => expect(order).toContain(dep));
      order.push(node.id);
      return {};
    };

    await executeDAG(dag, 'test-order', runNode);
    expect(order).toHaveLength(5);
  });
});

// ── handleAgentFailure / retry ────────────────────────────────────────────────

describe('handleAgentFailure', () => {
  it('retries with next-cheapest agent, not a hard crash', async () => {
    registerAgent({ id: 'a1', name: 'A1', capability: 'research', priceXLM: 1, stellarAddress: '' });
    registerAgent({ id: 'a2', name: 'A2', capability: 'research', priceXLM: 2, stellarAddress: '' });

    const node: DAGNode = { id: 'n1', taskType: 'research', dependsOn: [], status: 'running' };
    let calls = 0;
    const runNode = async () => {
      calls++;
      if (calls === 1) throw new Error('agent down');
      return { ok: true };
    };

    await handleAgentFailure(node, {}, runNode);
    expect(calls).toBe(2);
    expect(node.status).toBe('done');
  });

  it('marks node failed after 3 failures', async () => {
    registerAgent({ id: 'b1', name: 'B1', capability: 'risk', priceXLM: 1, stellarAddress: '' });
    registerAgent({ id: 'b2', name: 'B2', capability: 'risk', priceXLM: 2, stellarAddress: '' });
    registerAgent({ id: 'b3', name: 'B3', capability: 'risk', priceXLM: 3, stellarAddress: '' });

    const node: DAGNode = { id: 'n1', taskType: 'risk', dependsOn: [], status: 'running' };
    const runNode = async () => { throw new Error('always fails'); };

    await handleAgentFailure(node, {}, runNode);
    expect(node.status).toBe('failed');
  });

  it('marks node failed immediately when registry returns 0 agents', async () => {
    // no agents registered for 'design'
    const node: DAGNode = { id: 'n1', taskType: 'design', dependsOn: [], status: 'running' };
    await handleAgentFailure(node, {}, async () => ({}));
    expect(node.status).toBe('failed');
  });
});

// ── CyclicDAGError ────────────────────────────────────────────────────────────

describe('executeDAG — cyclic detection', () => {
  it('throws CyclicDAGError when circular dependency detected', async () => {
    const dag: DAGNode[] = [
      { id: 'x', taskType: 'research', dependsOn: ['z'], status: 'pending' },
      { id: 'y', taskType: 'risk',     dependsOn: ['x'], status: 'pending' },
      { id: 'z', taskType: 'report',   dependsOn: ['y'], status: 'pending' },
    ];
    await expect(executeDAG(dag, 'cyclic-test')).rejects.toBeInstanceOf(CyclicDAGError);
  });
});

// ── Execution trace ───────────────────────────────────────────────────────────

describe('executeDAG — trace persistence', () => {
  it('writes execution trace JSON to logs/tasks/<taskId>.json', async () => {
    const dag: DAGNode[] = [{ id: 'n1', taskType: 'research', dependsOn: [], status: 'pending' }];
    registerAgent({ id: 'r1', name: 'R1', capability: 'research', priceXLM: 1, stellarAddress: '' });
    assignAgents(dag);

    await executeDAG(dag, 'trace-test', async () => ({}));

    expect(mockedFs.writeFileSync).toHaveBeenCalledWith(
      expect.stringContaining('trace-test.json'),
      expect.any(String),
    );
  });
});

// ── Merged result ─────────────────────────────────────────────────────────────

describe('executeDAG — merged result', () => {
  it('returns merged result object when all nodes succeed', async () => {
    const dag: DAGNode[] = [
      { id: 'n1', taskType: 'research', dependsOn: [],     status: 'pending' },
      { id: 'n2', taskType: 'report',   dependsOn: ['n1'], status: 'pending' },
    ];
    registerAgent({ id: 'r', name: 'R', capability: 'research', priceXLM: 1, stellarAddress: '' });
    registerAgent({ id: 'p', name: 'P', capability: 'report',   priceXLM: 1, stellarAddress: '' });
    assignAgents(dag);

    const results = await executeDAG(dag, 'merge-test', async (node) => ({ value: node.id }));
    expect(results).toHaveProperty('n1');
    expect(results).toHaveProperty('n2');
  });
});
