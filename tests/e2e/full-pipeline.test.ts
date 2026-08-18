import http from 'http';
import supertest from 'supertest';
import type { Server as HttpServer } from 'http';

import { createApp } from '../../backend/src/api/app';
import type { DispatchFn, PaymentReleaseFn } from '../../backend/src/coordinator/coordinator';
import type { DAGNode } from '../../backend/src/types/task';
import type { AgentResult } from '../../backend/src/agents/research/types';
import { MOCK_CONTRACT_IDS } from './helpers';

process.env.NODE_ENV = 'test';
process.env.SKIP_STELLAR_ACCOUNT_VERIFY = 'true';
process.env.REGISTRY_CONTRACT_ID = MOCK_CONTRACT_IDS.REGISTRY;
process.env.ERROR_RESOLVER_CONTRACT_ID = MOCK_CONTRACT_IDS.ERROR_RESOLVER;

const PROMPT =
  'Generate a market-entry report for solar energy in Southeast Asia, including software implementation and UI design';

const AGENT_NODE_IDS = ['node_research', 'node_risk', 'node_coding', 'node_design', 'node_report'];

const paymentReleases: Array<{ taskId: string; nodeId: string; txHash: string }> = [];

const mockReleasePayment: PaymentReleaseFn = async (taskId, nodeId) => {
  const txHash = `fakehash_${nodeId}_${Date.now()}`;
  paymentReleases.push({ taskId, nodeId, txHash });
  return txHash;
};

const fixtures: Record<string, AgentResult> = {
  research: {
    taskId: '',
    nodeId: 'node_research',
    summary: 'Southeast Asia solar energy market is growing rapidly.',
    keyFindings: [
      'Solar capacity in SEA grew 30% YoY in 2023.',
      'Vietnam leads with 16 GW installed capacity.',
    ],
    sources: [{ url: 'https://example.com/solar', title: 'Solar Market SEA 2024' }],
    confidence: 0.9,
  },
  risk: {
    taskId: '',
    nodeId: 'node_risk',
    summary: 'Regulatory uncertainty and currency risk are the top barriers.',
    keyFindings: [
      'Feed-in tariff changes in Vietnam create policy risk.',
      'Grid curtailment risk is high in peak generation periods.',
    ],
    sources: [],
    confidence: 0.6,
  },
  coding: {
    taskId: '',
    nodeId: 'node_coding',
    summary: 'Recommended tech stack: Python FastAPI backend, React dashboard.',
    keyFindings: [
      'FastAPI provides async support for real-time monitoring.',
      'React + Recharts renders solar generation sparklines.',
    ],
    sources: [],
    confidence: 0.3,
  },
  design: {
    taskId: '',
    nodeId: 'node_design',
    summary: 'Dashboard design uses a dark theme with green accent colours.',
    keyFindings: [
      'Color palette: #1A1A2E primary, #00FF7F accent.',
      'Mobile-first layout for field technician use.',
    ],
    sources: [],
    confidence: 0.3,
  },
  report: {
    taskId: '',
    nodeId: 'node_report',
    summary: [
      '## Executive Summary',
      'Southeast Asia presents a compelling solar energy market opportunity.',
      '',
      '## Findings',
      'Vietnam, Thailand, and the Philippines lead in installed capacity.',
      '',
      '## Risk Analysis',
      'Regulatory volatility and grid infrastructure gaps are primary risks.',
      '',
      '## Recommendations',
      'Enter through a joint venture with a local utility partner.',
      '',
      '## Conclusion',
      'A phased entry strategy offers the best risk-adjusted return.',
    ].join('\n'),
    keyFindings: [
      'Executive Summary included.',
      'Findings included.',
      'Risk Analysis included.',
      'Recommendations included.',
      'Conclusion included.',
    ],
    sources: [],
    confidence: 0.6,
  },
};

const mockDispatch: DispatchFn = async (taskId, node, _context) => {
  const fixture = fixtures[node.type];
  if (!fixture) throw new Error(`No fixture for agentType: ${node.type}`);
  await new Promise(r => setTimeout(r, 5));
  return { ...fixture, taskId, nodeId: node.nodeId };
};

let httpServer: HttpServer;
let request: ReturnType<typeof supertest>;
let closeApp: () => void;

beforeAll(done => {
  paymentReleases.length = 0;

  const app = createApp({ dispatch: mockDispatch, releasePayment: mockReleasePayment });
  httpServer = app.httpServer;
  closeApp = app.close;
  request = supertest(httpServer);

  httpServer.listen(0, '127.0.0.1', done);
}, 10_000);

afterAll(done => {
  closeApp();
  done();
});

async function pollUntilStatus(
  taskId: string,
  targetStatus: string,
  timeoutMs = 120_000
): Promise<Record<string, unknown>> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const res = await request
      .get(`/api/tasks/${taskId}`)
      .set('walletpublickey', 'GFAKEWALLETPUBLICKEY');
    if (res.status === 200 && res.body.status === targetStatus) {
      return res.body as Record<string, unknown>;
    }
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error(`Task ${taskId} did not reach status "${targetStatus}" within ${timeoutMs}ms`);
}

describe('Full Pipeline E2E', () => {
  let taskId: string;
  let finalTask: Record<string, unknown>;

  it('submits a task and the full 5-node DAG completes', async () => {
    const res = await request
      .post('/api/tasks')
      .set('walletpublickey', 'GFAKEWALLETPUBLICKEY')
      .send({ prompt: PROMPT, walletPublicKey: 'GFAKEWALLETPUBLICKEY' });

    expect(res.status).toBe(201);
    expect(res.body.taskId).toMatch(/^task_/);
    expect(res.body.dagPreview).toHaveLength(5);
    expect(res.body.status).toBe('queued');
    taskId = res.body.taskId as string;

    finalTask = await pollUntilStatus(taskId, 'completed');
    expect(finalTask.status).toBe('completed');
  });

  it('all 5 DAG nodes are completed in the final response', () => {
    const dag = finalTask.dag as Array<{ nodeId: string; status: string }>;
    for (const nodeId of AGENT_NODE_IDS) {
      const node = dag.find(n => n.nodeId === nodeId);
      expect(node).toBeDefined();
      expect(node!.status).toBe('completed');
    }
  });

  it('releases payment exactly once per node', () => {
    expect(paymentReleases).toHaveLength(5);
    const releasedNodeIds = paymentReleases.map(r => r.nodeId).sort();
    expect(releasedNodeIds).toEqual([...AGENT_NODE_IDS].sort());
    for (const r of paymentReleases) {
      expect(r.taskId).toBe(taskId);
    }
  });

  it('final report contains all 5 mandatory sections', () => {
    const dag = finalTask.dag as Array<{ nodeId: string; result?: { summary?: string } }>;
    const reportNode = dag.find(n => n.nodeId === 'node_report');
    expect(reportNode).toBeDefined();

    const summary = reportNode!.result?.summary ?? '';
    for (const section of ['Executive Summary', 'Findings', 'Risk Analysis', 'Recommendations', 'Conclusion']) {
      expect(summary).toContain(section);
    }
  });

  it('returns 404 for unknown taskId', async () => {
    const res = await request
      .get('/api/tasks/task_doesnotexist')
      .set('walletpublickey', 'GFAKEWALLETPUBLICKEY');
    expect(res.status).toBe(404);
  });

  it('returns 400 when prompt is missing', async () => {
    const res = await request
      .post('/api/tasks')
      .send({ walletPublicKey: 'GFAKEWALLETPUBLICKEY' });
    expect(res.status).toBe(400);
  });
});

describe('Full Pipeline E2E — agent failure', () => {
  let failServer: HttpServer;
  let failClose: () => void;

  beforeAll(done => {
    const failDispatch: DispatchFn = async (taskId, node, context) => {
      if (node.type === 'coding') throw new Error('Coding agent unavailable');
      return mockDispatch(taskId, node, context);
    };

    const app = createApp({ dispatch: failDispatch, releasePayment: mockReleasePayment });
    failServer = app.httpServer;
    failClose = app.close;
    failServer.listen(0, '127.0.0.1', done);
  }, 10_000);

  afterAll(done => {
    failClose();
    done();
  });

  it('handles agent failure gracefully without crashing the server', async () => {
    const req = supertest(failServer);

    const res = await req
      .post('/api/tasks')
      .set('walletpublickey', 'GFAKEWALLETPUBLICKEY')
      .send({ prompt: PROMPT, walletPublicKey: 'GFAKEWALLETPUBLICKEY' });

    expect(res.status).toBe(201);
    const failTaskId = res.body.taskId as string;

    const deadline = Date.now() + 120_000;
    let status = 'queued';
    while (Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 200));
      const getRes = await req
        .get(`/api/tasks/${failTaskId}`)
        .set('walletpublickey', 'GFAKEWALLETPUBLICKEY');
      status = getRes.body.status as string;
      if (status === 'failed' || status === 'completed') break;
    }
    expect(status).toBe('failed');
  }, 125_000);
});
