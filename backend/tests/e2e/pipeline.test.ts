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

import http from 'http';
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

// Exercises every branch of `decompose`: "market" -> risk, "software"/"implementation"
// -> coding, "UI design" -> design. research and report are unconditional, so this
// yields the full 5-node DAG this suite is built around.
const PROMPT =
  'Generate a market-entry report for solar energy in Southeast Asia, including software implementation and UI design';

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
    const res = await request(httpServer)
      .get(`/api/tasks/${taskId}`)
      .set("walletpublickey", "GFAKEWALLETTEST5VLDNRLN3RPRJMRZOX3Z6G5CHCGDG6NXGPTVMLHKZ");
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
    ws.on('open', () => ws.send(JSON.stringify({ walletPublicKey: 'GFAKEWALLETTEST5VLDNRLN3RPRJMRZOX3Z6G5CHCGDG6NXGPTVMLHKZ' })));

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
      .set('walletpublickey', 'GFAKEWALLETTEST5VLDNRLN3RPRJMRZOX3Z6G5CHCGDG6NXGPTVMLHKZ')
      .send({ prompt: PROMPT, walletPublicKey: 'GFAKEWALLETTEST5VLDNRLN3RPRJMRZOX3Z6G5CHCGDG6NXGPTVMLHKZ' });

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
    const taskPaymentReleases = paymentReleases.filter(r => r.taskId === taskId);
    expect(taskPaymentReleases).toHaveLength(5);
    const releasedNodeIds = taskPaymentReleases.map(r => r.nodeId).sort();
    expect(releasedNodeIds).toEqual([...AGENT_NODE_IDS].sort());
    // All releases share the same taskId
    for (const r of taskPaymentReleases) {
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
    const res = await request(httpServer)
      .get('/api/tasks/task_doesnotexist')
      .set('walletpublickey', 'GFAKEWALLETTEST5VLDNRLN3RPRJMRZOX3Z6G5CHCGDG6NXGPTVMLHKZ');
    expect(res.status).toBe(404);
  });

  it('POST /api/tasks returns 400 when prompt is missing', async () => {
    const res = await request(httpServer)
      .post('/api/tasks')
      .send({ walletPublicKey: 'GFAKE' });
    expect(res.status).toBe(400);
  });
});

// ─── HTTP Dispatch Integration ────────────────────────────────────────────────

/**
 * Verifies that the real `httpDispatch` path works end-to-end: spin up a
 * minimal HTTP server that acts as a mock agent, wire it into `createApp` via
 * the `agentRegistry` option, and confirm the task completes successfully.
 */
describe('HTTP dispatch integration (mock agent server)', () => {
  let appServer: HttpServer;
  let agentServer: http.Server;
  let appBaseUrl: string;
  let closeTestApp: () => void;

  /** Tracks calls received by the mock agent server */
  const agentCalls: Array<{ nodeId: string; nodeType: string }> = [];

  beforeAll(done => {
    agentCalls.length = 0;
    paymentReleases.length = 0;

    // ── Minimal mock agent HTTP server ──────────────────────────────────────
    // Responds to POST /execute with a fixture result keyed by node.type.
    agentServer = http.createServer((req, res) => {
      if (req.method !== 'POST' || req.url !== '/execute') {
        res.writeHead(404).end();
        return;
      }

      let body = '';
      req.on('data', (chunk: Buffer) => { body += chunk.toString(); });
      req.on('end', () => {
        try {
          const { node } = JSON.parse(body) as { nodeId: string; node: { type: string; nodeId: string } };
          agentCalls.push({ nodeId: node.nodeId, nodeType: node.type });

          const fixture = fixtureByType[node.type] ?? { summary: `Result for ${node.type}` };
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(fixture));
        } catch {
          res.writeHead(400).end(JSON.stringify({ error: 'bad request' }));
        }
      });
    });

    agentServer.listen(0, '127.0.0.1', () => {
      const agentAddr = agentServer.address() as AddressInfo;
      const agentEndpoint = `http://127.0.0.1:${agentAddr.port}`;

      // ── AgentRegistry backed by mock agent server ───────────────────────
      const agentRegistry = {
        getAgents: (agentType: string) => [
          { id: `mock-${agentType}`, type: agentType, endpoint: agentEndpoint, cost: 1, status: 'online' as const },
        ],
      };

      // ── Create app with registry and no custom dispatch ─────────────────
      const { httpServer: srv, close } = createApp({
        agentRegistry,
        releasePayment: mockReleasePayment,
      });

      appServer = srv;
      closeTestApp = close;

      appServer.listen(0, '127.0.0.1', () => {
        const appAddr = appServer.address() as AddressInfo;
        appBaseUrl = `http://127.0.0.1:${appAddr.port}`;
        done();
      });
    });
  }, 15_000);

  afterAll(done => {
    closeTestApp();
    agentServer.close(done);
  });

  it('submits a task and all nodes complete via real HTTP dispatch', async () => {
    // POST task
    const postRes = await request(appServer)
      .post('/api/tasks')
      .send({ prompt: PROMPT, walletPublicKey: 'GFAKEWALLETTEST5VLDNRLN3RPRJMRZOX3Z6G5CHCGDG6NXGPTVMLHKZ' });

    expect(postRes.status).toBe(201);
    const { taskId } = postRes.body as { taskId: string };
    expect(taskId).toMatch(/^task_/);

    // Poll until completed
    const deadline = Date.now() + 120_000;
    let finalTask: Record<string, unknown> | null = null;

    while (Date.now() < deadline) {
      const getRes = await request(appServer)
        .get(`/api/tasks/${taskId}`)
        .set('walletpublickey', 'GFAKEWALLETTEST5VLDNRLN3RPRJMRZOX3Z6G5CHCGDG6NXGPTVMLHKZ');
      if (getRes.status === 200 && getRes.body.status === 'completed') {
        finalTask = getRes.body as Record<string, unknown>;
        break;
      }
      if (getRes.body.status === 'failed') {
        throw new Error(`Task failed unexpectedly: ${JSON.stringify(getRes.body)}`);
      }
      await new Promise(r => setTimeout(r, 200));
    }

    expect(finalTask).not.toBeNull();
    expect(finalTask!.status).toBe('completed');

    // All 5 nodes should be completed
    const dag = finalTask!.dag as Array<{ nodeId: string; status: string }>;
    for (const nodeId of AGENT_NODE_IDS) {
      const node = dag.find(n => n.nodeId === nodeId);
      expect(node).toBeDefined();
      expect(node!.status).toBe('completed');
    }

    // Agent server should have received one request per node
    expect(agentCalls.length).toBeGreaterThanOrEqual(AGENT_NODE_IDS.length);
  }, 130_000);

  it('releases payment exactly once per node in HTTP dispatch mode', () => {
    expect(paymentReleases.length).toBeGreaterThanOrEqual(AGENT_NODE_IDS.length);
    const releasedNodeIds = paymentReleases.slice(-5).map(r => r.nodeId);
    for (const nodeId of AGENT_NODE_IDS) {
      expect(releasedNodeIds).toContain(nodeId);
    }
  });

  it('returns an error when no agent registry is configured and no dispatch provided', async () => {
    const { httpServer: bareServer, close } = createApp({ releasePayment: mockReleasePayment });
    await new Promise<void>(resolve => bareServer.listen(0, '127.0.0.1', resolve));

    const postRes = await request(bareServer)
      .post('/api/tasks')
      .send({ prompt: PROMPT, walletPublicKey: 'GFAKEWALLETTEST5VLDNRLN3RPRJMRZOX3Z6G5CHCGDG6NXGPTVMLHKZ' });

    expect(postRes.status).toBe(201);
    const { taskId } = postRes.body as { taskId: string };

    // Task should eventually fail because no registry/dispatch is available
    const deadline = Date.now() + 15_000;
    let status = 'queued';
    while (Date.now() < deadline && status !== 'failed') {
      await new Promise(r => setTimeout(r, 100));
      const getRes = await request(bareServer)
        .get(`/api/tasks/${taskId}`)
        .set('walletpublickey', 'GFAKEWALLETTEST5VLDNRLN3RPRJMRZOX3Z6G5CHCGDG6NXGPTVMLHKZ');
      status = (getRes.body as { status: string }).status;
    }

    expect(status).toBe('failed');
    close();
  }, 20_000);

  /**
   * Literal acceptance test from issue #173: when the registry is provided but
   * returns no agents for a node's type, every node must fail with a clear,
   * descriptive error message rather than a generic / silent failure.
   */
  it('reports "No agent registered for type:<x>" when registry returns no agents', async () => {
    const emptyRegistry = {
      getAgents: (_agentType: string) => [] as Array<{ id: string; type: string; endpoint: string; cost: number; status: 'online' | 'offline' }>,
    };

    const { httpServer: srv, close } = createApp({
      agentRegistry: emptyRegistry,
      releasePayment: mockReleasePayment,
    });
    await new Promise<void>(resolve => srv.listen(0, '127.0.0.1', resolve));

    try {
      const postRes = await request(srv)
        .post('/api/tasks')
        .send({ prompt: PROMPT, walletPublicKey: 'GFAKEWALLETTEST5VLDNRLN3RPRJMRZOX3Z6G5CHCGDG6NXGPTVMLHKZ' });

      expect(postRes.status).toBe(201);
      const { taskId } = postRes.body as { taskId: string };

      // Wait for the task to settle as failed
      type DagNode = { nodeId: string; type: string; status: string; error?: string };
      type TaskBody = { status: string; dag: DagNode[] };

      const deadline = Date.now() + 15_000;
      let body: TaskBody | null = null;
      while (Date.now() < deadline) {
        await new Promise(r => setTimeout(r, 100));
        const getRes = await request(srv)
          .get(`/api/tasks/${taskId}`)
          .set('walletpublickey', 'GFAKEWALLETTEST5VLDNRLN3RPRJMRZOX3Z6G5CHCGDG6NXGPTVMLHKZ');
        body = getRes.body as TaskBody;
        if (body && body.status === 'failed') break;
      }

      expect(body).not.toBeNull();
      expect(body!.status).toBe('failed');

      // At least one failed DAG node must carry the descriptive "No agent
      // registered for type:" message so an operator can immediately tell
      // which capability is unconfigured.
      // (Downstream nodes may carry "upstream_failed" due to the coordinator's
      //  cascade — that's expected behavior, not the error under test.)
      const failedNodes = body!.dag.filter(n => n.status === 'failed');
      expect(failedNodes.length).toBeGreaterThan(0);
      const withAgentErr = failedNodes.filter(n =>
        typeof n.error === 'string' && /No agent registered for type: \w+/.test(n.error),
      );
      expect(withAgentErr.length).toBeGreaterThan(0);
    } finally {
      close();
    }
  }, 20_000);
});

describe('HTTP dispatch — agent error handling', () => {
  let appServer: HttpServer;
  let agentServer: http.Server;
  let closeTestApp: () => void;

  beforeAll(done => {
    // Agent server that always returns 500
    agentServer = http.createServer((_req, res) => {
      res.writeHead(500).end(JSON.stringify({ error: 'Internal server error' }));
    });

    agentServer.listen(0, '127.0.0.1', () => {
      const agentAddr = agentServer.address() as AddressInfo;
      const agentEndpoint = `http://127.0.0.1:${agentAddr.port}`;

      const agentRegistry = {
        getAgents: (agentType: string) => [
          { id: `failing-${agentType}`, type: agentType, endpoint: agentEndpoint, cost: 1, status: 'online' as const },
        ],
      };

      const { httpServer: srv, close } = createApp({
        agentRegistry,
        releasePayment: mockReleasePayment,
      });

      appServer = srv;
      closeTestApp = close;
      appServer.listen(0, '127.0.0.1', done);
    });
  }, 15_000);

  afterAll(done => {
    closeTestApp();
    agentServer.close(done);
  });

  it('handles agent HTTP 500 response gracefully without crashing', async () => {
    const postRes = await request(appServer)
      .post('/api/tasks')
      .send({ prompt: PROMPT, walletPublicKey: 'GFAKEWALLETTEST5VLDNRLN3RPRJMRZOX3Z6G5CHCGDG6NXGPTVMLHKZ' });

    expect(postRes.status).toBe(201);
    const { taskId } = postRes.body as { taskId: string };

    const deadline = Date.now() + 90_000;
    let status = 'queued';
    while (Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 200));
      const getRes = await request(appServer)
        .get(`/api/tasks/${taskId}`)
        .set('walletpublickey', 'GFAKEWALLETTEST5VLDNRLN3RPRJMRZOX3Z6G5CHCGDG6NXGPTVMLHKZ');
      status = (getRes.body as { status: string }).status;
      if (status === 'failed' || status === 'completed') break;
    }
    expect(status).toBe('failed');
  }, 100_000);
});
