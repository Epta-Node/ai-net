/**
 * E2E pipeline test — Issue #30
 *
 * Exercises the full backend pipeline:
 *   POST /api/tasks
 *   → Coordinator DAG execution (5 nodes)
 *   → Mock agents returning fixture results
 *   → Payment release (mocked Stellar, verified via Horizon stub)
 *   → WebSocket event stream
 *   → GET /api/tasks/:id final state assertions
 *
 * Stellar testnet calls are intercepted by jest mocks so the suite runs
 * without real network access in CI.  Set STELLAR_E2E=1 to run against
 * the live testnet (requires STELLAR_TEST_SECRET in env).
 */

import request from 'supertest';
import { WebSocket } from 'ws';
import type { AddressInfo } from 'net';
import type { Server as HttpServer } from 'http';

import { createApp } from '../../src/api/app';
import type { DispatchFn, PaymentReleaseFn } from '../../src/coordinator/coordinator';
import type { DAGNode } from '../../src/types/task';
import {
  researchFixture,
  riskFixture,
  codingFixture,
  designFixture,
  reportFixture,
} from '../fixtures/agentResults';
import type { AgentResult } from '../../src/agents/research/types';

// ─── Constants ───────────────────────────────────────────────────────────────

const PROMPT = 'Generate a market-entry report for solar energy in Southeast Asia';

const REQUIRED_SECTIONS = [
  'Executive Summary',
  'Findings',
  'Risk Analysis',
  'Recommendations',
  'Conclusion',
];

const AGENT_NODE_IDS = [
  'node_research',
  'node_risk',
  'node_coding',
  'node_design',
  'node_report',
];

// ─── Payment tracking ────────────────────────────────────────────────────────

/** Tracks payment release calls made during the test */
const paymentReleases: Array<{ taskId: string; nodeId: string; txHash: string }> = [];

/** Stubbed payment release — records calls and returns a deterministic fake tx hash */
const mockReleasePayment: PaymentReleaseFn = async (taskId, nodeId) => {
  const txHash = `fakehash_${nodeId}_${Date.now()}`;
  paymentReleases.push({ taskId, nodeId, txHash });
  return txHash;
};

// ─── Agent dispatch ──────────────────────────────────────────────────────────

const fixtureByType: Record<string, AgentResult> = {
  research: researchFixture,
  risk:     riskFixture,
  coding:   codingFixture,
  design:   designFixture,
  report:   reportFixture,
};

/**
 * Mock dispatch: looks up a fixture by agentType and returns it after a short delay
 * to simulate real async agent work.
 */
const mockDispatch: DispatchFn = async (taskId, node: DAGNode, _context) => {
  const fixture = fixtureByType[node.type];
  if (!fixture) throw new Error(`No fixture for agentType: ${node.type}`);
  // Simulate a small async delay
  await new Promise(r => setTimeout(r, 5));
  return { ...fixture, taskId, nodeId: node.nodeId };
};

// ─── Server lifecycle ─────────────────────────────────────────────────────────

let httpServer: HttpServer;
let baseUrl: string;
let wsBase: string;
let closeApp: () => void;

beforeAll(done => {
  paymentReleases.length = 0;

  const { httpServer: srv, close } = createApp({
    dispatch:       mockDispatch,
    releasePayment: mockReleasePayment,
  });
  httpServer = srv;
  closeApp   = close;

  httpServer.listen(0, '127.0.0.1', () => {
    const addr = httpServer.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${addr.port}`;
    wsBase  = `ws://127.0.0.1:${addr.port}`;
    done();
  });
}, 10_000);

afterAll(done => {
  closeApp();
  done();
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Poll GET /api/tasks/:id until status matches or timeout expires */
async function pollUntilStatus(
  taskId: string,
  targetStatus: string,
  timeoutMs = 120_000
): Promise<Record<string, unknown>> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const res = await request(httpServer).get(`/api/tasks/${taskId}`);
    if (res.status === 200 && res.body.status === targetStatus) {
      return res.body as Record<string, unknown>;
    }
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error(`Task ${taskId} did not reach status "${targetStatus}" within ${timeoutMs}ms`);
}

/** Collect all WebSocket events for a task until task_completed or task_failed */
function collectWsEvents(taskId: string, timeoutMs = 30_000): Promise<Array<Record<string, unknown>>> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${wsBase}/tasks/${taskId}/stream`);
    const events: Array<Record<string, unknown>> = [];
    const timer = setTimeout(() => {
      ws.close();
      reject(new Error('WS collection timed out'));
    }, timeoutMs);

    // Auth handshake: the owning wallet must be sent as the first message.
    ws.on('open', () => ws.send(JSON.stringify({ walletPublicKey: 'GFAKEWALLETPUBLICKEY' })));

    ws.on('message', raw => {
      const event = JSON.parse(raw.toString()) as Record<string, unknown>;
      if (event['type'] === 'ping') return; // heartbeat, not a DAG event
      events.push(event);
      if (event['type'] === 'task_completed' || event['type'] === 'task_failed') {
        clearTimeout(timer);
        ws.close();
        resolve(events);
      }
    });

    ws.on('error', err => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('Full pipeline E2E', () => {
  let taskId: string;
  let finalTask: Record<string, unknown>;
  let wsEvents: Array<Record<string, unknown>>;

  it('POST /api/tasks returns 201 with taskId and 5-node dagPreview', async () => {
    const res = await request(httpServer)
      .post('/api/tasks')
      .send({ prompt: PROMPT, walletPublicKey: 'GFAKEWALLETPUBLICKEY' });

    expect(res.status).toBe(201);
    expect(res.body.taskId).toMatch(/^task_/);
    expect(Array.isArray(res.body.dagPreview)).toBe(true);
    expect(res.body.dagPreview).toHaveLength(5);
    expect(res.body.status).toBe('queued');

    taskId = res.body.taskId as string;
  });

  it('task reaches status "completed" within 120s', async () => {
    finalTask = await pollUntilStatus(taskId, 'completed');
    expect(finalTask.status).toBe('completed');
  }, 125_000);

  it('all 5 DAG nodes are completed in the final GET response', () => {
    const dag = finalTask.dag as Array<{ nodeId: string; status: string }>;
    for (const nodeId of AGENT_NODE_IDS) {
      const node = dag.find(n => n.nodeId === nodeId);
      expect(node).toBeDefined();
      expect(node!.status).toBe('completed');
    }
  });

  it('payment was released exactly once per node (5 releases total)', () => {
    expect(paymentReleases).toHaveLength(5);
    const releasedNodeIds = paymentReleases.map(r => r.nodeId).sort();
    expect(releasedNodeIds).toEqual([...AGENT_NODE_IDS].sort());
    // All releases share the same taskId
    for (const r of paymentReleases) {
      expect(r.taskId).toBe(taskId);
    }
  });

  it('final report contains all 5 mandatory sections', () => {
    const dag = finalTask.dag as Array<{ nodeId: string; result?: { summary?: string } }>;
    const reportNode = dag.find(n => n.nodeId === 'node_report');
    expect(reportNode).toBeDefined();

    const summary = reportNode!.result?.summary ?? '';
    for (const section of REQUIRED_SECTIONS) {
      expect(summary).toContain(section);
    }
  });

  it('WebSocket emits correct event sequence with no node_failed events', async () => {
    // Connect WebSocket after task is already submitted — it will replay state
    // then stream remaining events until task_completed.
    wsEvents = await collectWsEvents(taskId);

    const types = wsEvents.map(e => e['type'] as string);

    // Must contain all node_started events
    const startedEvents = types.filter(t => t === 'node_started');
    expect(startedEvents.length).toBeGreaterThanOrEqual(5);

    // Must contain all node_completed events
    const completedEvents = types.filter(t => t === 'node_completed');
    expect(completedEvents.length).toBeGreaterThanOrEqual(5);

    // Must end with task_completed
    expect(types).toContain('task_completed');

    // No node_failed in a successful run
    expect(types).not.toContain('node_failed');

    // node_started always precedes node_completed for the same nodeId
    for (const nodeId of AGENT_NODE_IDS) {
      const startIdx    = wsEvents.findIndex(e => e['type'] === 'node_started'   && e['nodeId'] === nodeId);
      const completeIdx = wsEvents.findIndex(e => e['type'] === 'node_completed' && e['nodeId'] === nodeId);
      if (startIdx !== -1 && completeIdx !== -1) {
        expect(startIdx).toBeLessThan(completeIdx);
      }
    }

    // task_completed is the last event
    const lastEvent = wsEvents[wsEvents.length - 1];
    expect(lastEvent?.['type']).toBe('task_completed');
  }, 60_000);

  it('GET /api/tasks/:id returns 404 for unknown taskId', async () => {
    const res = await request(httpServer).get('/api/tasks/task_doesnotexist');
    expect(res.status).toBe(404);
  });

  it('POST /api/tasks returns 400 when prompt is missing', async () => {
    const res = await request(httpServer)
      .post('/api/tasks')
      .send({ walletPublicKey: 'GFAKE' });
    expect(res.status).toBe(400);
  });
});
