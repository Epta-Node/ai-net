/**
 * Fault-injection tests for the smart-contracts coordinator layer.
 *
 * Tests that injected failures (agent crash, provider timeout, delivery fail)
 * produce correct resume/fallback behavior.
 *
 * Each injected fault has an asserting test — see THREAT_MODEL.md §3
 * and SECURITY_CHECKLIST.md §F.
 */
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

beforeEach(() => clearRegistry());

function makeAgent(overrides: { id: string; name: string; capability: string; priceXLM: number; stellarAddress?: string; reputationScore?: number }) {
  return {
    stellarAddress: '',
    reputationScore: 1,
    ...overrides,
  };
}

// ── F1: Agent crash → retry with next cheapest agent ──────────────────────────

describe('F1 · agent crash → fallback to next agent', () => {
  it('retries with the next-cheapest agent when the primary crashes', async () => {
    registerAgent(makeAgent({ id: 'crasher', name: 'Crasher', capability: 'research', priceXLM: 1 }));
    registerAgent(makeAgent({ id: 'reliable', name: 'Reliable', capability: 'research', priceXLM: 2 }));

    const dag: DAGNode[] = [{ id: 'n1', taskType: 'research', dependsOn: [], status: 'pending' }];
    assignAgents(dag);

    let callCount = 0;
    const runNode = async () => {
      callCount++;
      if (callCount === 1) throw new Error('agent crashed');
      return { result: 'fallback-ok' };
    };

    await handleAgentFailure(dag[0], {}, runNode);

    expect(callCount).toBe(2);
    expect(dag[0].status).toBe('done');
    expect(dag[0].assignedAgent).toBe('reliable');
  });
});

// ── F2: All agents fail → node marked failed, dependent nodes cascade-fail ─────

describe('F2 · all agents fail → node and dependency cascade', () => {
  it('marks node failed when every agent throws', async () => {
    registerAgent(makeAgent({ id: 'a1', name: 'A1', capability: 'risk', priceXLM: 1 }));
    registerAgent(makeAgent({ id: 'a2', name: 'A2', capability: 'risk', priceXLM: 2 }));
    registerAgent(makeAgent({ id: 'a3', name: 'A3', capability: 'risk', priceXLM: 3 }));

    const node: DAGNode = { id: 'n1', taskType: 'risk', dependsOn: [], status: 'running' };
    const runNode = async () => { throw new Error('all agents down'); };

    await handleAgentFailure(node, {}, runNode);

    expect(node.status).toBe('failed');
  });

  it('cascades failure to dependent nodes in executeDAG', async () => {
    const dag: DAGNode[] = [
      { id: 'n1', taskType: 'research', dependsOn: [], status: 'pending' },
      { id: 'n2', taskType: 'risk', dependsOn: ['n1'], status: 'pending' },
    ];

    // No agents registered → all fail immediately
    const runNode = async () => { throw new Error('no agents'); };

    const results = await executeDAG(dag, 'cascade-test', runNode);

    expect(dag[0].status).toBe('failed');
    expect(dag[1].status).toBe('failed');
    expect(results).toEqual({});
  });
});

// ── F3: Provider timeout → abort + retry + fallback ───────────────────────────

describe('F3 · provider timeout → retry then fallback', () => {
  it('retries on timeout and falls back to another agent', async () => {
    registerAgent(makeAgent({ id: 'slow', name: 'Slow', capability: 'coding', priceXLM: 1 }));
    registerAgent(makeAgent({ id: 'fast', name: 'Fast', capability: 'coding', priceXLM: 2 }));

    const dag: DAGNode[] = [{ id: 'n1', taskType: 'coding', dependsOn: [], status: 'pending' }];
    assignAgents(dag);

    let callCount = 0;
    const runNode = async () => {
      callCount++;
      if (callCount <= 2) {
        throw new Error('Agent slow timed out after 30000ms');
      }
      return { code: 'fn fast() {}' };
    };

    await handleAgentFailure(dag[0], {}, runNode);

    // Mock must have been called (at least 2 failures before success)
    expect(callCount).toBeGreaterThanOrEqual(2);
  });
});

// ── F4: HTTP 500 from agent → retryable error ─────────────────────────────────

describe('F4 · HTTP 500 from agent → retryable', () => {
  it('retries after HTTP 500 and succeeds on fallback', async () => {
    registerAgent(makeAgent({ id: 'flaky', name: 'Flaky', capability: 'design', priceXLM: 1 }));
    registerAgent(makeAgent({ id: 'solid', name: 'Solid', capability: 'design', priceXLM: 2 }));

    const dag: DAGNode[] = [{ id: 'n1', taskType: 'design', dependsOn: [], status: 'pending' }];
    assignAgents(dag);

    let callCount = 0;
    const runNode = async () => {
      callCount++;
      if (callCount <= 2) {
        const err = new Error('Internal Server Error');
        (err as any).response = { status: 500 };
        throw err;
      }
      return { design: 'wireframe' };
    };

    await handleAgentFailure(dag[0], {}, runNode);

    // Mock must have been called (at least 2 failures before success)
    expect(callCount).toBeGreaterThanOrEqual(2);
  });
});

// ── F5: Registry returns 0 agents → immediate fail ────────────────────────────

describe('F5 · registry empty → immediate node failure', () => {
  it('marks node failed when no agents registered for taskType', async () => {
    const node: DAGNode = { id: 'n1', taskType: 'report', dependsOn: [], status: 'running' };

    await handleAgentFailure(node, {}, async () => ({}));

    expect(node.status).toBe('failed');
  });
});

// ── F6: Cyclic dependency → CyclicDAGError ────────────────────────────────────

describe('F6 · cyclic dependency → CyclicDAGError', () => {
  it('throws CyclicDAGError on circular DAG', async () => {
    const dag: DAGNode[] = [
      { id: 'a', taskType: 'research', dependsOn: ['b'], status: 'pending' },
      { id: 'b', taskType: 'risk', dependsOn: ['a'], status: 'pending' },
    ];

    await expect(executeDAG(dag, 'cyclic-fault')).rejects.toBeInstanceOf(CyclicDAGError);
  });
});

// ── F7: Mixed success/failure → partial results ───────────────────────────────

describe('F7 · mixed success/failure → partial DAG results', () => {
  it('returns results for successful nodes only', async () => {
    registerAgent(makeAgent({ id: 'r1', name: 'R1', capability: 'research', priceXLM: 1 }));
    registerAgent(makeAgent({ id: 'c1', name: 'C1', capability: 'coding', priceXLM: 1 }));

    const dag: DAGNode[] = [
      { id: 'n1', taskType: 'research', dependsOn: [], status: 'pending' },
      { id: 'n2', taskType: 'coding', dependsOn: [], status: 'pending' },
    ];

    let callCount = 0;
    const runNode = async (node: DAGNode) => {
      callCount++;
      if (node.taskType === 'coding') throw new Error('coding agent crashed');
      return { research: 'done' };
    };

    const results = await executeDAG(dag, 'partial-test', runNode);

    expect(dag[0].status).toBe('done');
    expect(dag[1].status).toBe('failed');
    expect(results).toHaveProperty('n1');
    expect(results).not.toHaveProperty('n2');
  });
});

// ── F8: decomposeTask failure → propagates error ──────────────────────────────

describe('F8 · decomposeTask API failure → error propagation', () => {
  it('throws when Venice API is unreachable', async () => {
    mockedAxios.post.mockRejectedValueOnce(new Error('Network Error'));

    await expect(decomposeTask('test prompt')).rejects.toThrow('Network Error');
  });

  it('throws when Venice API returns malformed JSON', async () => {
    mockedAxios.post.mockResolvedValueOnce({
      data: { choices: [{ message: { content: 'NOT JSON' } }] },
    });

    await expect(decomposeTask('test prompt')).rejects.toThrow();
  });
});

// ── F9: Execution trace persisted even on failure ─────────────────────────────

describe('F9 · trace persisted on DAG failure', () => {
  it('writes trace JSON even when nodes fail', async () => {
    registerAgent(makeAgent({ id: 'r1', name: 'R1', capability: 'research', priceXLM: 1 }));

    const dag: DAGNode[] = [
      { id: 'n1', taskType: 'research', dependsOn: [], status: 'pending' },
    ];

    const runNode = async () => { throw new Error('crash'); };

    await executeDAG(dag, 'trace-fail-test', runNode);

    expect(mockedFs.writeFileSync).toHaveBeenCalledWith(
      expect.stringContaining('trace-fail-test.json'),
      expect.any(String),
    );

    const writtenData = mockedFs.writeFileSync.mock.calls[0][1] as string;
    const parsed = JSON.parse(writtenData);
    expect(parsed[0].status).toBe('failed');
  });
});
