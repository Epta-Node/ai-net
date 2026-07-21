import type { Server as HttpServer } from 'http';
import type { Socket } from 'net';
import type { IncomingMessage } from 'http';
import { WebSocketServer, WebSocket } from 'ws';

import { eventBus as defaultEventBus } from '../../coordinator/eventBus';
import { getTask as defaultGetTask } from '../../coordinator/taskStore';
import type { EventStore } from '../../coordinator/eventStore';
import type { Task } from '../../types/task';
import { WS_CLOSE } from '../../types/stream';

const STREAM_PATH = /^\/tasks\/([^/?]+)\/stream(?:\?.*)?$/;

/**
 * Parse the optional `?lastEventId=<number>` cursor from a stream URL. Returns
 * the parsed non-negative integer, or undefined when the param is absent or
 * malformed (in which case the client gets a full replay — backward compatible).
 */
function parseLastEventId(url: string): number | undefined {
  const qIndex = url.indexOf('?');
  if (qIndex === -1) return undefined;
  const raw = new URLSearchParams(url.slice(qIndex + 1)).get('lastEventId');
  if (raw === null) return undefined;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 0 ? n : undefined;
}

const DEFAULT_HEARTBEAT_INTERVAL_MS = 30_000;
const DEFAULT_PONG_TIMEOUT_MS = 10_000;
const DEFAULT_AUTH_TIMEOUT_MS = 10_000;

export interface TaskStreamOptions {
  /** Interval between server heartbeat pings. Default 30s. */
  heartbeatIntervalMs?: number;
  /** How long to wait for a pong before closing as stale. Default 10s. */
  pongTimeoutMs?: number;
  /** How long to wait for the auth handshake before closing. Default 10s. */
  authTimeoutMs?: number;
}

export interface TaskStreamDeps extends TaskStreamOptions {
  httpServer: HttpServer;
  eventStore: EventStore;
  eventBus?: typeof defaultEventBus;
  getTask?: (taskId: string) => Task | undefined;
}

/**
 * Attach the live DAG-execution stream to an HTTP server.
 *
 * Exposes ws://<host>/tasks/:id/stream. Each connection:
 *   1. must send `{ walletPublicKey }` as its first message (auth handshake);
 *   2. is validated against the task owner — non-owners get a 403 close frame;
 *   3. receives a chronological replay of past events from the store — all of
 *      them by default, or only those with seq > N when the handshake URL
 *      carries an optional `?lastEventId=N` cursor;
 *   4. then streams live events as the Coordinator emits them.
 *
 * Every event sent to the client carries a per-task monotonic `seq`, so the
 * client can persist the last seq it saw and resume from it on reconnect.
 *
 * A heartbeat ping is sent on an interval and the socket is closed if no pong
 * arrives in time. All subscriptions and timers are cleaned up on disconnect.
 *
 * @returns a detach function that stops the stream and closes open sockets.
 */
export function attachTaskStream(deps: TaskStreamDeps): () => void {
  const {
    httpServer,
    eventStore,
    eventBus = defaultEventBus,
    getTask = defaultGetTask,
    heartbeatIntervalMs = DEFAULT_HEARTBEAT_INTERVAL_MS,
    pongTimeoutMs = DEFAULT_PONG_TIMEOUT_MS,
    authTimeoutMs = DEFAULT_AUTH_TIMEOUT_MS,
  } = deps;

  const wss = new WebSocketServer({ noServer: true });

  const onUpgrade = (req: IncomingMessage, socket: Socket, head: Buffer): void => {
    const match = (req.url ?? '').match(STREAM_PATH);
    if (!match) {
      socket.destroy();
      return;
    }
    const taskId = match[1]!;
    const lastEventId = parseLastEventId(req.url ?? '');
    wss.handleUpgrade(req, socket, head, ws => {
      wss.emit('connection', ws, req, taskId, lastEventId);
    });
  };

  httpServer.on('upgrade', onUpgrade);

  wss.on('connection', (
    ws: WebSocket,
    _req: IncomingMessage,
    taskId: string,
    lastEventId?: number
  ) => {
    const task = getTask(taskId);
    if (!task) {
      ws.close(WS_CLOSE.TASK_NOT_FOUND, 'Task not found');
      return;
    }

    let authed = false;
    // Cursor for the next flush: events with seq > lastSentSeq are replayed.
    // With ?lastEventId=N we resume after seq N; without it we fall back to -1
    // so the full history (seq 0 → latest) is replayed — backward compatible.
    let lastSentSeq = lastEventId ?? -1;
    let unsubLive: (() => void) | undefined;
    let heartbeat: NodeJS.Timeout | undefined;
    let pongTimer: NodeJS.Timeout | undefined;

    // Close the socket if the client never completes the auth handshake.
    const authTimer = setTimeout(() => {
      if (!authed && ws.readyState === WebSocket.OPEN) {
        ws.close(WS_CLOSE.AUTH_TIMEOUT, 'Auth handshake timed out');
      }
    }, authTimeoutMs);

    const send = (data: unknown): void => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(data));
      }
    };

    // Stream every persisted event newer than the last one we sent. Driven by
    // both the initial replay and each live emit, so ordering is canonical
    // (store seq) and no event is ever sent twice.
    const flush = (): void => {
      const events = eventStore.listByTaskSince(taskId, lastSentSeq);
      for (const event of events) {
        // Send the full event including its seq so the client can record a
        // cursor and resume from it via ?lastEventId on a later reconnect.
        send(event);
        lastSentSeq = event.seq;
      }
    };

    const cleanup = (): void => {
      clearTimeout(authTimer);
      if (heartbeat) clearInterval(heartbeat);
      if (pongTimer) clearTimeout(pongTimer);
      if (unsubLive) unsubLive();
    };

    const startHeartbeat = (): void => {
      heartbeat = setInterval(() => {
        if (ws.readyState !== WebSocket.OPEN) return;
        send({ type: 'ping' });
        if (pongTimer) clearTimeout(pongTimer);
        pongTimer = setTimeout(() => {
          if (ws.readyState === WebSocket.OPEN) {
            ws.close(WS_CLOSE.STALE, 'Heartbeat timeout');
          }
        }, pongTimeoutMs);
      }, heartbeatIntervalMs);
    };

    const completeAuth = (walletPublicKey: string): void => {
      if (walletPublicKey !== task.walletPublicKey) {
        ws.close(WS_CLOSE.FORBIDDEN, 'Forbidden: wallet does not own task');
        return;
      }
      authed = true;
      clearTimeout(authTimer);

      // Subscribe before the initial replay so any event emitted during replay
      // is captured; flush() dedupes via lastSentSeq, so order is preserved
      // and nothing is delivered twice.
      unsubLive = eventBus.subscribe(taskId, () => flush());
      flush();
      startHeartbeat();
    };

    ws.on('message', raw => {
      let msg: unknown;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        if (!authed) ws.close(WS_CLOSE.BAD_REQUEST, 'Expected JSON auth message');
        return;
      }

      if (!authed) {
        const walletPublicKey = (msg as { walletPublicKey?: unknown })?.walletPublicKey;
        if (typeof walletPublicKey !== 'string' || walletPublicKey === '') {
          ws.close(WS_CLOSE.BAD_REQUEST, 'First message must be { walletPublicKey }');
          return;
        }
        completeAuth(walletPublicKey);
        return;
      }

      // Authenticated: the only client message we expect is a heartbeat pong.
      if ((msg as { type?: unknown })?.type === 'pong' && pongTimer) {
        clearTimeout(pongTimer);
        pongTimer = undefined;
      }
    });

    ws.on('close', cleanup);
    ws.on('error', cleanup);
  });

  return function detach(): void {
    httpServer.off('upgrade', onUpgrade);
    for (const client of wss.clients) {
      client.terminate();
    }
    wss.close();
  };
}
