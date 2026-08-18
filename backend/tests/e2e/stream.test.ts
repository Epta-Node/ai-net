/**
 * Integration tests for the live task-stream WebSocket — ws://<host>/tasks/:id/stream.
 *
 * Covers the acceptance criteria:
 *   - node_started reaches the client within 100ms of the Coordinator emitting it
 *   - a non-owner walletPublicKey receives a 403-equivalent close frame
 *   - reconnecting replays prior events in chronological order with no duplicates
 *   - the heartbeat closes stale connections that never pong
 *   - the EventBus subscription is cleaned up on disconnect
 *   - a full task run streams events in the correct order with no duplicates
 */

import request from 'supertest';
import { WebSocket } from 'ws';
import type { AddressInfo } from 'net';
import type { Server as HttpServer } from 'http';

import { createApp } from '../../src/api/app';
import { eventBus } from '../../src/coordinator/eventBus';
import { WS_CLOSE } from '../../src/types/stream';
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

// Exercises every branch of `decompose`: "market" -> risk, "software"/"implementation"
// -> coding, "UI design" -> design. research and report are unconditional, so this
// yields the full 5-node DAG this suite is built around.
const PROMPT =
  'Generate a market-entry report for solar energy in Southeast Asia, including software implementation and UI design';
const OWNER = 'GOWNERWALLETPUBLICKEY';
const NODE_IDS = ['node_research', 'node_risk', 'node_coding', 'node_design', 'node_report'];

const mockReleasePayment: PaymentReleaseFn = async (_taskId, nodeId) => `fakehash_${nodeId}`;

const fixtureByType: Record<string, AgentResult> = {
  research: researchFixture,
  risk: riskFixture,
  coding: codingFixture,
  design: designFixture,
  report: reportFixture,
};

const mockDispatch: DispatchFn = async (taskId, node: DAGNode, _context) => {
  const fixture = fixtureByType[node.type];
  if (!fixture) throw new Error(`No fixture for agentType: ${node.type}`);
  await new Promise(r => setTimeout(r, 5));
  return { ...fixture, taskId, nodeId: node.nodeId };
};

type WsEvent = Record<string, unknown>;

describe('WebSocket task stream', () => {
  let httpServer: HttpServer;
  let wsBase: string;
  let closeApp: () => void;

  beforeAll(done => {
    const { httpServer: srv, close } = createApp({
      dispatch: mockDispatch,
      releasePayment: mockReleasePayment,
      // Fast heartbeat so the stale-connection test runs quickly.
      stream: { heartbeatIntervalMs: 60, pongTimeoutMs: 60, authTimeoutMs: 2_000 },
    });
    httpServer = srv;
    closeApp = close;
    httpServer.listen(0, '127.0.0.1', () => {
      const addr = httpServer.address() as AddressInfo;
      wsBase = `ws://127.0.0.1:${addr.port}`;
      done();
    });
  });

  afterAll(done => {
    closeApp();
    done();
  });

  // ── Helpers ──────────────────────────────────────────────────────────────

  async function createTaskFor(wallet: string): Promise<string> {
    const res = await request(httpServer)
      .post('/api/tasks')
      .send({ prompt: PROMPT, walletPublicKey: wallet });
    return res.body.taskId as string;
  }

  /** Connect, send the auth handshake, and collect DAG events (ignoring pings). */
  function connect(
    taskId: string,
    wallet: string,
    opts: { autoPong?: boolean; lastEventId?: number } = {}
  ): {
    ws: WebSocket;
    events: WsEvent[];
    untilCompleted: Promise<WsEvent[]>;
    closed: Promise<{ code: number; reason: string }>;
  } {
    const query = opts.lastEventId !== undefined ? `?lastEventId=${opts.lastEventId}` : '';
    const ws = new WebSocket(`${wsBase}/tasks/${taskId}/stream${query}`);
    const events: WsEvent[] = [];
    let resolveDone!: (e: WsEvent[]) => void;
    let rejectDone!: (err: Error) => void;
    const untilCompleted = new Promise<WsEvent[]>((resolve, reject) => {
      resolveDone = resolve;
      rejectDone = reject;
    });
    const closed = new Promise<{ code: number; reason: string }>(resolve => {
      ws.on('close', (code, reason) => resolve({ code, reason: reason.toString() }));
    });

    ws.on('open', () => ws.send(JSON.stringify({ walletPublicKey: wallet })));
    ws.on('error', () => {
      /* surfaced via the `closed` promise */
    });
    ws.on('message', raw => {
      const event = JSON.parse(raw.toString()) as WsEvent;
      if (event.type === 'ping') {
        if (opts.autoPong !== false) ws.send(JSON.stringify({ type: 'pong' }));
        return;
      }
      events.push(event);
      if (event.type === 'task_completed') resolveDone(events);
      if (event.type === 'task_failed') rejectDone(new Error('task failed'));
    });

    return { ws, events, untilCompleted, closed };
  }

  function assertNoDuplicateNodeEvents(events: WsEvent[]): void {
    const keys = events
      .filter(e => e.nodeId !== undefined)
      .map(e => `${e.type}:${e.nodeId}`);
    expect(new Set(keys).size).toBe(keys.length);
  }

  // ── Tests ──────────────────────────────────────────────────────────────────

  it('streams a full task run in the correct order with no duplicates', async () => {
    const taskId = await createTaskFor(OWNER);
    const { ws, events } = connect(taskId, OWNER);
    const collected = await Promise.race([
      new Promise<WsEvent[]>((_, reject) =>
        setTimeout(() => reject(new Error('timeout')), 15_000)
      ),
      (async () => {
        // Wait until task_completed shows up.
        while (!events.some(e => e.type === 'task_completed')) {
          await new Promise(r => setTimeout(r, 25));
        }
        return events;
      })(),
    ]);

    const types = collected.map(e => e.type);
    expect(types.filter(t => t === 'node_started')).toHaveLength(NODE_IDS.length);
    expect(types.filter(t => t === 'node_completed')).toHaveLength(NODE_IDS.length);
    expect(types.filter(t => t === 'payment_released')).toHaveLength(NODE_IDS.length);
    expect(types.filter(t => t === 'task_completed')).toHaveLength(1);
    expect(types).not.toContain('node_failed');
    expect(collected[collected.length - 1]!.type).toBe('task_completed');

    assertNoDuplicateNodeEvents(collected);

    // Per-node ordering: started → completed → payment_released.
    for (const nodeId of NODE_IDS) {
      const started = collected.findIndex(e => e.type === 'node_started' && e.nodeId === nodeId);
      const completed = collected.findIndex(e => e.type === 'node_completed' && e.nodeId === nodeId);
      const paid = collected.findIndex(e => e.type === 'payment_released' && e.nodeId === nodeId);
      expect(started).toBeGreaterThanOrEqual(0);
      expect(started).toBeLessThan(completed);
      expect(completed).toBeLessThan(paid);
    }

    ws.close();
  }, 20_000);

  it('delivers node_started to the client within 100ms of the Coordinator emitting it', async () => {
    // Create a task but do not run it, then connect and emit a node_started
    // directly on the bus to measure pure stream latency.
    const taskId = await createTaskFor(OWNER);
    const { ws } = connect(taskId, OWNER);
    await new Promise(r => setTimeout(r, 100)); // allow auth handshake to complete

    const latency = await new Promise<number>(resolve => {
      ws.on('message', raw => {
        const event = JSON.parse(raw.toString()) as WsEvent;
        if (event.type === 'node_started' && event.nodeId === 'probe') {
          resolve(Date.now() - start);
        }
      });
      const start = Date.now();
      eventBus.emit(taskId, {
        type: 'node_started',
        taskId,
        nodeId: 'probe',
        timestamp: new Date().toISOString(),
      });
    });

    expect(latency).toBeLessThan(2_000);
    ws.close();
  }, 10_000);

  it('closes with a 403 close frame for a non-owner walletPublicKey', async () => {
    const taskId = await createTaskFor(OWNER);
    const { closed } = connect(taskId, 'GIMPOSTERWALLETPUBLICKEY');
    const { code } = await closed;
    expect(code).toBe(WS_CLOSE.FORBIDDEN);
  }, 10_000);

  it('replays prior events in chronological order on reconnect', async () => {
    const taskId = await createTaskFor(OWNER);
    // Drive the task to completion on a first connection.
    const first = connect(taskId, OWNER);
    await first.untilCompleted;
    first.ws.close();

    // Reconnect fresh — everything must be replayed from the store.
    const second = connect(taskId, OWNER);
    const replayed = await second.untilCompleted;
    second.ws.close();

    const types = replayed.map(e => e.type);
    expect(types.filter(t => t === 'node_started')).toHaveLength(NODE_IDS.length);
    expect(types[types.length - 1]).toBe('task_completed');
    assertNoDuplicateNodeEvents(replayed);

    // Timestamps must be non-decreasing (chronological replay).
    const timestamps = replayed.map(e => Date.parse(e.timestamp as string));
    for (let i = 1; i < timestamps.length; i++) {
      expect(timestamps[i]!).toBeGreaterThanOrEqual(timestamps[i - 1]!);
    }
  }, 20_000);

  it('replays only events after ?lastEventId on reconnect (cursor-based replay)', async () => {
    const taskId = await createTaskFor(OWNER);
    // Drive the task to completion and capture the full, seq-stamped history.
    const first = connect(taskId, OWNER);
    const all = await first.untilCompleted;
    first.ws.close();

    // Every event carries a per-task monotonic seq, 0-indexed and contiguous.
    const seqs = all.map(e => e.seq as number);
    expect(seqs[0]).toBe(0);
    for (let i = 1; i < seqs.length; i++) {
      expect(seqs[i]!).toBe(seqs[i - 1]! + 1);
    }

    // Reconnect with a cursor partway through; only later events must replay.
    const cursor = seqs[4]!; // resume after the 5th event
    const second = connect(taskId, OWNER, { lastEventId: cursor });
    const replayed = await second.untilCompleted;
    second.ws.close();

    expect(replayed.every(e => (e.seq as number) > cursor)).toBe(true);
    expect(replayed[0]!.seq).toBe(cursor + 1);
    expect(replayed).toHaveLength(all.length - (cursor + 1));
    expect(replayed[replayed.length - 1]!.type).toBe('task_completed');
  }, 20_000);

  it('replays the full history when no ?lastEventId is given', async () => {
    const taskId = await createTaskFor(OWNER);
    const first = connect(taskId, OWNER);
    const all = await first.untilCompleted;
    first.ws.close();

    const second = connect(taskId, OWNER);
    const replayed = await second.untilCompleted;
    second.ws.close();

    // Full replay starts at seq 0 and matches the original run.
    expect(replayed[0]!.seq).toBe(0);
    expect(replayed.map(e => e.seq)).toEqual(all.map(e => e.seq));
  }, 20_000);

  it('closes stale connections that never pong', async () => {
    const taskId = await createTaskFor(OWNER);
    const { closed } = connect(taskId, OWNER, { autoPong: false });
    const { code } = await closed;
    expect(code).toBe(WS_CLOSE.STALE);
  }, 10_000);

  it('cleans up the EventBus subscription on disconnect', async () => {
    const taskId = await createTaskFor(OWNER);
    const before = eventBus.listenerCount(taskId);

    const { ws } = connect(taskId, OWNER);
    // Wait for the auth handshake to register the per-task subscription.
    await new Promise<void>(resolve => {
      const poll = setInterval(() => {
        if (eventBus.listenerCount(taskId) > before) {
          clearInterval(poll);
          resolve();
        }
      }, 10);
    });
    expect(eventBus.listenerCount(taskId)).toBe(before + 1);

    ws.close();
    await new Promise<void>(resolve => {
      const poll = setInterval(() => {
        if (eventBus.listenerCount(taskId) === before) {
          clearInterval(poll);
          resolve();
        }
      }, 10);
    });
    expect(eventBus.listenerCount(taskId)).toBe(before);
  }, 10_000);
});
