/**
 * Fault injection E2E suite (issue #852).
 *
 * Eight scenarios across three failure domains, all in-process against the
 * real app (createApp) with injected dispatch/payment seams — no docker, no
 * external network. Runs standalone via `npm run test:fault` and is excluded
 * from the standard `test:e2e` run so it never slows the regular suite.
 *
 * Suite 1 — Agent failures
 *   1. Agent crashes mid-task → job retry → task completes within 60s
 *   2. Capability unavailable (all agents offline) → task fails terminally
 *   3. Malformed agent output → retry → never poisons the pipeline
 *
 * Suite 2 — Payment / Horizon faults
 *   4. Escrow release failure → distinct `payment_failed` status within 30s
 *   5. Horizon outage → clean termination, full recovery afterwards
 *
 * Suite 3 — Reconciliation
 *   6. Payment drift detected → remediation path exercised (idempotent re-run)
 *
 * Suite 4 — Streaming & idempotency
 *   7. SSE reconnect with Last-Event-ID → no duplicate events
 *   8. Idempotent task submission → same Idempotency-Key creates one task
 */
import http from 'http';
import type { AddressInfo } from 'net';
import supertest from 'supertest';
import type { Server as HttpServer } from 'http';

import { createApp } from '../../backend/src/api/app';
import type { DispatchFn, PaymentReleaseFn } from '../../backend/src/coordinator/coordinator';
import type { DAGNode } from '../../backend/src/types/task';
import type { AgentResult } from '../../backend/src/agents/research/types';
import type { ClaimableBalanceProvider } from '../../backend/src/services/reconciliation';
import type { PaymentDb, PaymentRecord } from '../../backend/src/db/index';
import {
  ReconciliationService,
  createInMemoryPendingDriftStore,
} from '../../backend/src/services/reconciliation';
import { HorizonUnavailableError } from '../../backend/src/payment/utils';
import { MOCK_CONTRACT_IDS } from './helpers';

process.env.NODE_ENV = 'test';
process.env.SKIP_STELLAR_ACCOUNT_VERIFY = 'true';
process.env.REGISTRY_CONTRACT_ID = MOCK_CONTRACT_IDS.REGISTRY;
process.env.ERROR_RESOLVER_CONTRACT_ID = MOCK_CONTRACT_IDS.ERROR_RESOLVER;

const WALLET = 'GFAKEWALLETPUBLICKEY';

const PROMPT =
  'Generate a market-entry report for solar energy in Southeast Asia, including software implementation and UI design';

// ── Shared fixtures & dispatch ────────────────────────────────────────────────

const fixtures: Record<string, AgentResult> = {
  research: {
    taskId: '',
    nodeId: 'node_research',
    summary: 'Southeast Asia solar energy market is growing rapidly.',
    keyFindings: ['Solar capacity in SEA grew 30% YoY in 2023.'],
    sources: [{ url: 'https://example.com/solar', title: 'Solar Market SEA 2024' }],
    confidence: 0.9,
  },
  risk: {
    taskId: '',
    nodeId: 'node_risk',
    summary: 'Regulatory uncertainty and currency risk are the top barriers.',
    keyFindings: ['Feed-in tariff changes create policy risk.'],
    sources: [],
    confidence: 0.6,
  },
  coding: {
    taskId: '',
    nodeId: 'node_coding',
    summary: 'Recommended tech stack: Python FastAPI backend, React dashboard.',
    keyFindings: ['FastAPI provides async support.'],
    sources: [],
    confidence: 0.3,
  },
  design: {
    taskId: '',
    nodeId: 'node_design',
    summary: 'Dashboard design uses a dark theme with green accent colours.',
    keyFindings: ['Mobile-first layout for field technicians.'],
    sources: [],
    confidence: 0.3,
  },
  report: {
    taskId: '',
    nodeId: 'node_report',
    summary: ['## Executive Summary', 'Solar energy entry via joint venture.'].join('\n'),
    keyFindings: ['Executive Summary included.'],
    sources: [],
    confidence: 0.6,
  },
};

const healthyDispatch: DispatchFn = async (taskId, node: DAGNode, _context) => {
  const fixture = fixtures[node.type];
  if (!fixture) throw new Error(`No fixture for agentType: ${node.type}`);
  await new Promise(r => setTimeout(r, 5));
  return { ...fixture, taskId, nodeId: node.nodeId };
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeReleasePayment(store: Array<{ taskId: string; nodeId: string; txHash: string }>): PaymentReleaseFn {
  return async (taskId, nodeId) => {
    const txHash = `fakehash_${nodeId}_${Date.now()}`;
    store.push({ taskId, nodeId, txHash });
    return txHash;
  };
}

async function submitTask(request: ReturnType<typeof supertest>): Promise<string> {
  const res = await request
    .post('/api/tasks')
    .set('walletpublickey', WALLET)
    .send({ prompt: PROMPT, walletPublicKey: WALLET });
  expect(res.status).toBe(201);
  expect(res.body.taskId).toMatch(/^task_/);
  return res.body.taskId as string;
}

async function getTask(
  request: ReturnType<typeof supertest>,
  taskId: string
): Promise<Record<string, unknown>> {
  const res = await request.get(`/api/tasks/${taskId}`).set('walletpublickey', WALLET);
  return res.body as Record<string, unknown>;
}

/** Poll until the task reaches `target` — intermediate failures are ignored (job retries). */
async function pollUntilStatus(
  request: ReturnType<typeof supertest>,
  taskId: string,
  target: string,
  timeoutMs = 60_000
): Promise<Record<string, unknown>> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const res = await request
      .get(`/api/tasks/${taskId}`)
      .set('walletpublickey', WALLET);
    if (res.status === 200 && res.body.status === target) {
      return res.body as Record<string, unknown>;
    }
    await new Promise(r => setTimeout(r, 250));
  }
  const last = await getTask(request, taskId);
  throw new Error(
    `Task ${taskId} did not reach status "${target}" within ${timeoutMs}ms (last status: ${String(last.status)})`
  );
}

function nodeOf(task: Record<string, unknown>, nodeId: string): { status: string; error?: string; result?: { summary?: string } } {
  const dag = task.dag as Array<{ nodeId: string }>;
  const node = dag.find(n => n.nodeId === nodeId);
  expect(node).toBeDefined();
  return node as unknown as { status: string; error?: string; result?: { summary?: string } };
}

// ── Minimal in-memory SSE client ──────────────────────────────────────────────

interface SseConnection {
  events: Array<{ id?: string; event?: string; data?: string }>;
  close: () => void;
  waitFor: (predicate: (events: Array<{ id?: string; event?: string; data?: string }>) => boolean, timeoutMs?: number) => Promise<void>;
}

function sseConnect(port: number, taskId: string, lastEventId?: string): SseConnection {
  const events: SseConnection['events'] = [];
  const headers: Record<string, string> = {
    Accept: 'text/event-stream',
    walletpublickey: WALLET,
  };
  if (lastEventId !== undefined) headers['Last-Event-ID'] = lastEventId;

  const req = http.request(
    { host: '127.0.0.1', port, path: `/api/tasks/${taskId}/events/stream`, headers },
    res => {
      res.setEncoding('utf8');
      let buffer = '';
      res.on('data', chunk => {
        buffer += chunk;
        let idx: number;
        while ((idx = buffer.indexOf('\n\n')) !== -1) {
          const frame = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);
          const ev: { id?: string; event?: string; data?: string } = {};
          for (const line of frame.split('\n')) {
            if (line.startsWith('id:')) ev.id = line.slice(3).trim();
            else if (line.startsWith('event:')) ev.event = line.slice(6).trim();
            else if (line.startsWith('data:')) ev.data = line.slice(5).trim();
          }
          if (ev.event !== undefined || ev.data !== undefined) events.push(ev);
        }
      });
    }
  );
  req.on('error', () => {
    /* close()/destroy() surfaces as a socket error — ignore */
  });
  req.end();

  return {
    events,
    close: () => req.destroy(),
    waitFor: async (predicate, timeoutMs = 20_000) => {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if (predicate(events)) return;
        await new Promise(r => setTimeout(r, 50));
      }
      throw new Error(`SSE wait timed out after ${timeoutMs}ms (received ${events.length} events)`);
    },
  };
}

// ── Suite 1: agent failures ───────────────────────────────────────────────────

describe('Fault injection — agent failures', () => {
  let server: HttpServer;
  let request: ReturnType<typeof supertest>;
  let closeApp: () => void;
  let activeDispatch: DispatchFn = healthyDispatch;
  const paymentReleases: Array<{ taskId: string; nodeId: string; txHash: string }> = [];

  beforeAll(done => {
    const routed: DispatchFn = (taskId, node, context) => activeDispatch(taskId, node, context);
    const app = createApp({ dispatch: routed, releasePayment: makeReleasePayment(paymentReleases) });
    server = app.httpServer;
    closeApp = app.close;
    request = supertest(server);
    server.listen(0, '127.0.0.1', done);
  }, 10_000);

  afterAll(done => {
    closeApp();
    done();
  });

  it('scenario 1: agent crashes mid-task, job retry completes the task within 60s', async () => {
    let researchAttempts = 0;
    activeDispatch = async (taskId, node, context) => {
      if (node.type === 'research') {
        researchAttempts += 1;
        if (researchAttempts === 1) {
          throw new Error('ECONNRESET: research agent crashed mid-task');
        }
      }
      return healthyDispatch(taskId, node, context);
    };

    const taskId = await submitTask(request);
    const started = Date.now();
    const task = await pollUntilStatus(request, taskId, 'completed', 60_000);

    expect(Date.now() - started).toBeLessThan(60_000);
    expect(task.status).toBe('completed');
    expect(researchAttempts).toBeGreaterThanOrEqual(2);
    expect(nodeOf(task, 'node_research').status).toBe('completed');
  }, 70_000);

  it('scenario 2: capability unavailable (no online agent) fails the task terminally', async () => {
    activeDispatch = async (taskId, node, context) => {
      if (node.type === 'research') {
        throw new Error('CAPABILITY_UNAVAILABLE: no online agent for capability "research"');
      }
      return healthyDispatch(taskId, node, context);
    };

    const taskId = await submitTask(request);
    const task = await pollUntilStatus(request, taskId, 'failed', 60_000);

    expect(task.status).toBe('failed');
    const research = nodeOf(task, 'node_research');
    expect(research.status).toBe('failed');
    expect(research.error).toContain('CAPABILITY_UNAVAILABLE');
  }, 70_000);

  it('scenario 3: malformed agent output never poisons the pipeline — retry produces a valid result', async () => {
    let researchAttempts = 0;
    activeDispatch = async (taskId, node, context) => {
      if (node.type === 'research') {
        researchAttempts += 1;
        if (researchAttempts === 1) {
          // What httpDispatch sees when an agent returns invalid JSON.
          throw new SyntaxError('Agent response was not valid JSON: unexpected token < in JSON at position 0');
        }
      }
      return healthyDispatch(taskId, node, context);
    };

    const taskId = await submitTask(request);
    const task = await pollUntilStatus(request, taskId, 'completed', 60_000);

    expect(task.status).toBe('completed');
    expect(researchAttempts).toBeGreaterThanOrEqual(2);

    const research = nodeOf(task, 'node_research');
    expect(research.status).toBe('completed');
    expect(research.result?.summary).toBeTruthy();
    expect(nodeOf(task, 'node_report').status).toBe('completed');
  }, 70_000);
});

// ── Suite 2: payment / Horizon faults ─────────────────────────────────────────

describe('Fault injection — payment and Horizon faults', () => {
  let server: HttpServer;
  let request: ReturnType<typeof supertest>;
  let closeApp: () => void;
  let releaseFailure: Error | null = null;
  const paymentReleases: Array<{ taskId: string; nodeId: string; txHash: string }> = [];

  beforeAll(done => {
    const releasePayment: PaymentReleaseFn = async (taskId, nodeId) => {
      if (releaseFailure) throw releaseFailure;
      const txHash = `fakehash_${nodeId}_${Date.now()}`;
      paymentReleases.push({ taskId, nodeId, txHash });
      return txHash;
    };
    const app = createApp({ dispatch: healthyDispatch, releasePayment });
    server = app.httpServer;
    closeApp = app.close;
    request = supertest(server);
    server.listen(0, '127.0.0.1', done);
  }, 10_000);

  afterAll(done => {
    closeApp();
    done();
  });

  it('scenario 4: escrow release failure surfaces payment_failed within 30s', async () => {
    releaseFailure = new Error('Horizon returned 503 Service Unavailable');
    try {
      const taskId = await submitTask(request);
      const started = Date.now();
      const task = await pollUntilStatus(request, taskId, 'payment_failed', 30_000);

      expect(Date.now() - started).toBeLessThan(30_000);
      expect(task.status).toBe('payment_failed');

      // Every node's work succeeded — only the payment leg failed, so the
      // locked escrow stays visible to reconciliation.
      const dag = task.dag as Array<{ status: string }>;
      for (const node of dag) {
        expect(node.status).toBe('completed');
      }
      expect(paymentReleases).toHaveLength(0);

      // The API stays healthy after a payment fault.
      const health = await request.get('/health/live');
      expect(health.status).toBe(200);
    } finally {
      releaseFailure = null;
    }
  }, 40_000);

  it('scenario 5: Horizon outage terminates cleanly and service recovers afterwards', async () => {
    releaseFailure = new HorizonUnavailableError(5);
    let outageTaskId: string;
    try {
      outageTaskId = await submitTask(request);
      const failedTask = await pollUntilStatus(request, outageTaskId, 'payment_failed', 30_000);
      expect(failedTask.status).toBe('payment_failed');
    } finally {
      releaseFailure = null;
    }

    // Horizon is back: a fresh task must complete end-to-end, proving the
    // outage left no wedged state behind (breaker half-open → closed).
    const recoveredTaskId = await submitTask(request);
    const recovered = await pollUntilStatus(request, recoveredTaskId, 'completed', 30_000);
    expect(recovered.status).toBe('completed');
    const dag = recovered.dag as Array<{ status: string }>;
    for (const node of dag) {
      expect(node.status).toBe('completed');
    }
  }, 70_000);
});

// ── Suite 3: reconciliation drift ─────────────────────────────────────────────

describe('Fault injection — payment drift reconciliation', () => {
  function memoryPaymentDb(records: PaymentRecord[]): PaymentDb {
    const rows = records;
    const find = (taskId: string, nodeId: string) =>
      rows.find(r => r.taskId === taskId && r.nodeId === nodeId);
    return {
      insert(record) {
        rows.push(record);
      },
      findByKey(taskId, nodeId) {
        return find(taskId, nodeId);
      },
      updateStatus(taskId, nodeId, status, txHash) {
        const row = find(taskId, nodeId);
        if (row) {
          row.status = status;
          row.txHash = txHash;
          row.updatedAt = new Date().toISOString();
        }
      },
      updateStatusIfCurrent(taskId, nodeId, expectedStatus, status, txHash) {
        const row = find(taskId, nodeId);
        if (!row || row.status !== expectedStatus) return false;
        row.status = status;
        row.txHash = txHash;
        row.updatedAt = new Date().toISOString();
        return true;
      },
      listAll() {
        return [...rows];
      },
    };
  }

  it('scenario 6: orphaned escrow drift is detected, remediated, and stays idempotent on re-run', async () => {
    const lockedRecord: PaymentRecord = {
      taskId: 'task_drift_1',
      nodeId: 'node_research',
      balanceId: '00000000abc123',
      status: 'locked',
      amountStroops: 10_000_000n,
      txHash: null,
      createdAt: new Date(Date.now() - 86_400_000).toISOString(),
      updatedAt: new Date(Date.now() - 86_400_000).toISOString(),
    };
    const paymentDb = memoryPaymentDb([lockedRecord]);

    // On-chain has no claimable balance for the locked record → orphaned_locked.
    const onChain: ClaimableBalanceProvider = {
      getBalance: async () => null,
      listBalances: async () => [],
    };

    let savedReport: { status: string } | undefined;
    const service = new ReconciliationService({
      paymentDb,
      onChainProvider: onChain,
      remediationEnabled: true,
      pendingDriftStore: createInMemoryPendingDriftStore(),
      reportStore: {
        save(report) {
          savedReport = report;
        },
        getLatest() {
          return savedReport as never;
        },
      },
    });

    // Run 1: drift detected → remediation path exercised.
    const first = await service.run('manual');
    expect(first.status).toBe('discrepancies_found');
    expect(first.discrepancies.some(d => d.driftType === 'orphaned_locked')).toBe(true);
    expect(first.summary.remediated).toBeGreaterThanOrEqual(1);
    expect(first.remediations.some(r => r.status === 'remediated')).toBe(true);

    // Remediation wrote the CAS status transition: locked → orphaned.
    expect(paymentDb.findByKey('task_drift_1', 'node_research')?.status).toBe('orphaned');

    // Run 2: same inputs → no new drift (idempotent, no double-remediation).
    const second = await service.run('manual');
    expect(second.status).toBe('consistent');
    expect(second.discrepancies).toHaveLength(0);
    expect(second.summary.remediated).toBe(0);
    expect(paymentDb.findByKey('task_drift_1', 'node_research')?.status).toBe('orphaned');
  }, 30_000);
});

// ── Suite 4: streaming & idempotency ──────────────────────────────────────────

describe('Fault injection — streaming and idempotency', () => {
  let server: HttpServer;
  let request: ReturnType<typeof supertest>;
  let closeApp: () => void;
  let port: number;
  let releaseCoding: () => void;
  const codingGate = new Promise<void>(resolve => {
    releaseCoding = resolve;
  });
  const paymentReleases: Array<{ taskId: string; nodeId: string; txHash: string }> = [];

  beforeAll(done => {
    // Hold node_coding until the test releases it, so the SSE stream has a
    // deterministic window of events to read, disconnect on, and resume.
    const gatedDispatch: DispatchFn = async (taskId, node, context) => {
      if (node.type === 'coding') {
        await codingGate;
      }
      return healthyDispatch(taskId, node, context);
    };
    const app = createApp({ dispatch: gatedDispatch, releasePayment: makeReleasePayment(paymentReleases) });
    server = app.httpServer;
    closeApp = app.close;
    request = supertest(server);
    server.listen(0, '127.0.0.1', () => {
      port = (server.address() as AddressInfo).port;
      done();
    });
  }, 10_000);

  afterAll(done => {
    releaseCoding();
    closeApp();
    done();
  });

  it('scenario 7: SSE reconnect with Last-Event-ID resumes without duplicate events', async () => {
    const taskId = await submitTask(request);

    // Connect while node_coding is blocked: plenty of events arrive, but the
    // task cannot finish — the disconnect below is deterministic.
    const conn1 = sseConnect(port, taskId);
    await conn1.waitFor(e => e.length >= 5, 20_000);

    const lastId = Number(conn1.events[conn1.events.length - 1].id);
    expect(Number.isFinite(lastId)).toBe(true);
    conn1.close();

    // Reconnect with the resume cursor, then let the task run to completion.
    const conn2 = sseConnect(port, taskId, String(lastId));
    releaseCoding();
    await conn2.waitFor(e => e.some(ev => ev.event === 'task_completed'), 30_000);

    expect(conn2.events.length).toBeGreaterThan(0);
    const seenOnFirst = new Set(conn1.events.map(e => Number(e.id)));
    for (const ev of conn2.events) {
      const id = Number(ev.id);
      // Dedup contract: nothing at or before the resume cursor is replayed,
      // and no event id observed on the first connection reappears.
      expect(id).toBeGreaterThan(lastId);
      expect(seenOnFirst.has(id)).toBe(false);
    }

    conn2.close();

    // Task itself still completes normally after the reconnect dance.
    await pollUntilStatus(request, taskId, 'completed', 30_000);
  }, 70_000);

  it('scenario 8: identical submission with the same Idempotency-Key creates exactly one task', async () => {
    const key = `fault-idem-${Date.now()}`;
    const body = { prompt: PROMPT, walletPublicKey: WALLET };

    const first = await request
      .post('/api/tasks')
      .set('walletpublickey', WALLET)
      .set('Idempotency-Key', key)
      .send(body);
    expect(first.status).toBe(201);
    expect(first.body.taskId).toMatch(/^task_/);

    const second = await request
      .post('/api/tasks')
      .set('walletpublickey', WALLET)
      .set('Idempotency-Key', key)
      .send(body);

    // Replay: the second request resolves to the first response instead of
    // creating a second task.
    expect(second.body.taskId).toBe(first.body.taskId);

    // Both ids refer to the same stored task.
    const viaFirst = await getTask(request, first.body.taskId as string);
    expect(viaFirst.id ?? viaFirst.taskId).toBeDefined();
  }, 30_000);
});
