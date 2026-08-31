import type { Server as HttpServer } from 'http';
import type { Socket } from 'net';
import type { IncomingMessage } from 'http';
import { WebSocketServer, WebSocket } from 'ws';

import { eventBus as defaultEventBus } from '../../coordinator/eventBus';
import { getTask as defaultGetTask } from '../../coordinator/taskStore';
import type { EventStore, StoredEvent } from '../../events/eventStore';
import type { Task } from '../../types/task';
import { WS_CLOSE } from '../../types/stream';
import { createLogger } from '../../utils/logger';

const STREAM_PATH = /^\/tasks\/([^/?]+)\/stream(?:\?.*)?$/;

const logger = createLogger({ module: 'ws-stream' });

// ---------------------------------------------------------------------------
// Wire-format normalisation
// ---------------------------------------------------------------------------

/**
 * Convert a stored event to the wire shape expected by WebSocket clients:
 *  • `type` is in snake_case  (the coordinator's original DAGEventType)
 *  • `seq`  is the per-task cursor (mapped from `taskSeq`)
 *
 * Clients use `event.type === 'task_completed'` / `event.seq` as a resume
 * cursor, so this mapping must be stable.
 */
function toWireEvent(event: StoredEvent): Record<string, unknown> {
  const snakeType = event.type
    // PascalCase → snake_case: "NodeStarted" → "node_started"
    .replace(/([A-Z])/g, (_match, _p1, offset: number) =>
      offset === 0 ? _match.toLowerCase() : `_${_match.toLowerCase()}`
    );

  const { taskSeq, globalSeq, occurredAt, version, ...rest } = event as StoredEvent & {
    taskSeq: number;
    globalSeq: number;
    occurredAt: string;
    version: number;
  };

  return {
    ...rest,
    type: snakeType,
    seq: taskSeq,
    timestamp: occurredAt,
  };
}

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

// ---------------------------------------------------------------------------
// Connection rate limiting (per client IP)
// ---------------------------------------------------------------------------

interface ClientConnectionTracker {
  count: number;
  resetTimer: NodeJS.Timeout | null;
}

const clientConnections = new Map<string, ClientConnectionTracker>();
const activeStreamServers = new Set<WebSocketServer>();

export function getStreamConnectionCount(): number {
  let total = 0;
  for (const server of activeStreamServers) {
    total += server.clients.size;
  }
  return total;
}

function getClientIp(req: IncomingMessage): string {
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string') return forwarded.split(',')[0].trim();
  return req.socket.remoteAddress ?? 'unknown';
}

function trackConnection(ip: string): boolean {
  const maxConnections = Number(process.env.WS_MAX_CONNECTIONS_PER_CLIENT ?? 5);
  let tracker = clientConnections.get(ip);
  if (!tracker) {
    tracker = { count: 0, resetTimer: null };
    clientConnections.set(ip, tracker);
  }
  if (tracker.count >= maxConnections) {
    return false;
  }
  tracker.count += 1;
  return true;
}

function releaseConnection(ip: string): void {
  const tracker = clientConnections.get(ip);
  if (!tracker) return;
  tracker.count -= 1;
  if (tracker.count <= 0) {
    if (tracker.resetTimer) clearTimeout(tracker.resetTimer);
    clientConnections.delete(ip);
  }
}

// ---------------------------------------------------------------------------
// Message rate limiting (per connection)
// ---------------------------------------------------------------------------

interface MessageRateTracker {
  count: number;
  windowStart: number;
}

// ---------------------------------------------------------------------------
// Defaults & options
// ---------------------------------------------------------------------------

const DEFAULT_HEARTBEAT_INTERVAL_MS = 30_000;
const DEFAULT_PONG_TIMEOUT_MS = 10_000;
const DEFAULT_AUTH_TIMEOUT_MS = 10_000;
const DEFAULT_INACTIVITY_TIMEOUT_MS = 1_800_000; // 30 minutes

export interface TaskStreamOptions {
  /** Interval between server heartbeat pings. Default 30s. */
  heartbeatIntervalMs?: number;
  /** How long to wait for a pong before closing as stale. Default 10s. */
  pongTimeoutMs?: number;
  /** How long to wait for the auth handshake before closing. Default 10s. */
  authTimeoutMs?: number;
  /** Auto-disconnect after N ms of inactivity. Default 30 min. */
  inactivityTimeoutMs?: number;
}

export interface TaskStreamDeps extends TaskStreamOptions {
  httpServer: HttpServer;
  eventStore: EventStore;
  eventBus?: typeof defaultEventBus;
  getTask?: (taskId: string) => Task | undefined;
}

/**
 * @openapi
 * /tasks/{id}/stream:
 *   get:
 *     summary: WebSocket Live Task Execution Stream (ws://)
 *     description: >
 *       **WebSocket Endpoint:** `ws://<host>/tasks/:id/stream`
 *
 *       Streams real-time DAG execution events, node state transitions, and Stellar payment release hashes.
 *
 *       ### Handshake & Authentication:
 *       1. Connect to `ws://<host>/tasks/:id/stream` (optionally appending `?lastEventId=<seq>` for cursor resumption).
 *       2. Send JSON auth payload within 10 seconds: `{"walletPublicKey": "G..."}`.
 *       3. Server verifies ownership. If wallet does not own task, connection closes with close code `4003` (Forbidden).
 *
 *       ### Events Received:
 *       - `node_started`: Node execution began with assigned agent.
 *       - `node_completed`: Node successfully finished.
 *       - `payment_released`: Stellar escrow payment released with txHash.
 *       - `task_completed` / `task_failed`: Task lifecycle finished.
 *
 *       ### Heartbeat:
 *       - Server sends periodic ping every 30s.
 *       - Client must reply with `{"type": "pong"}` within 10s.
 *     tags: [WebSocket Stream]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *         description: Task ID to stream
 *         example: "task_ab12cd34ef56"
 *       - in: query
 *         name: lastEventId
 *         required: false
 *         schema: { type: integer, minimum: 0 }
 *         description: Monotonic sequence number cursor to resume replay from
 *         example: 4
 *     responses:
 *       101:
 *         description: Switching Protocols to WebSocket
 *       400:
 *         description: Invalid request or malformed auth handshake payload
 *       403:
 *         description: Forbidden - wallet does not own task (WS close code 4003)
 *       404:
 *         description: Task not found (WS close code 4004)
 */

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
 * Rate limiting:
 *   - Max concurrent connections per client IP (default: 5)
 *   - Max messages per minute per connection (default: 100)
 *   - Auto-disconnect after inactivity (default: 30 min)
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
    inactivityTimeoutMs = DEFAULT_INACTIVITY_TIMEOUT_MS,
  } = deps;

  const maxMessagesPerMinute = Number(process.env.WS_MAX_MESSAGES_PER_MINUTE ?? 100);

  const wss = new WebSocketServer({ noServer: true });
  activeStreamServers.add(wss);

  const onUpgrade = (req: IncomingMessage, socket: Socket, head: Buffer): void => {
    const match = (req.url ?? '').match(STREAM_PATH);
    if (!match) {
      socket.destroy();
      return;
    }

    // ── Connection rate limit ────────────────────────────────────────────
    const clientIp = getClientIp(req);
    if (!trackConnection(clientIp)) {
      logger.warn({ clientIp }, 'connection rate limit exceeded');
      socket.write(
        'HTTP/1.1 429 Too Many Requests\r\n' +
        'Content-Type: text/plain\r\n' +
        'Connection: close\r\n\r\n' +
        'Too many concurrent WebSocket connections'
      );
      socket.destroy();
      return;
    }

    const taskId = match[1]!;
    const lastEventId = parseLastEventId(req.url ?? '');
    wss.handleUpgrade(req, socket, head, ws => {
      wss.emit('connection', ws, req, taskId, lastEventId, clientIp);
    });
  };

  httpServer.on('upgrade', onUpgrade);

  wss.on('connection', (
    ws: WebSocket,
    _req: IncomingMessage,
    taskId: string,
    lastEventId?: number,
    clientIp?: string
  ) => {
    const task = getTask(taskId);
    if (!task) {
      ws.close(WS_CLOSE.TASK_NOT_FOUND, 'Task not found');
      if (clientIp) releaseConnection(clientIp);
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
    let inactivityTimer: NodeJS.Timeout | undefined;

    // ── Message rate tracking ────────────────────────────────────────────
    const rateTracker: MessageRateTracker = { count: 0, windowStart: Date.now() };

    const checkMessageRate = (): boolean => {
      const now = Date.now();
      const windowMs = 60_000;
      if (now - rateTracker.windowStart > windowMs) {
        rateTracker.count = 0;
        rateTracker.windowStart = now;
      }
      rateTracker.count += 1;
      return rateTracker.count <= maxMessagesPerMinute;
    };

    // ── Inactivity timeout ───────────────────────────────────────────────
    const resetInactivityTimer = (): void => {
      if (inactivityTimer) clearTimeout(inactivityTimer);
      inactivityTimer = setTimeout(() => {
        if (ws.readyState === WebSocket.OPEN) {
          logger.info({ taskId, clientIp }, 'closing inactive WebSocket connection');
          ws.close(WS_CLOSE.STALE, 'Inactivity timeout');
        }
      }, inactivityTimeoutMs);
    };

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
        // Normalise to the wire format (snake_case type, seq cursor) before
        // sending so clients see the same shape regardless of internal storage.
        send(toWireEvent(event));
        lastSentSeq = event.taskSeq;
      }
    };

    const cleanup = (): void => {
      clearTimeout(authTimer);
      if (heartbeat) clearInterval(heartbeat);
      if (pongTimer) clearTimeout(pongTimer);
      if (inactivityTimer) clearTimeout(inactivityTimer);
      if (unsubLive) unsubLive();
      if (clientIp) releaseConnection(clientIp);
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
      resetInactivityTimer();

      // Subscribe before the initial replay so any event emitted during replay
      // is captured; flush() dedupes via lastSentSeq, so order is preserved
      // and nothing is delivered twice.
      unsubLive = eventBus.subscribe(taskId, () => flush());
      flush();
      startHeartbeat();

      logger.info({ taskId, clientIp }, 'WebSocket client authenticated');
    };

    ws.on('message', raw => {
      // Reset inactivity timer on every message
      if (authed) resetInactivityTimer();

      // ── Message rate limit ───────────────────────────────────────────
      if (authed && !checkMessageRate()) {
        logger.warn({ taskId, clientIp }, 'message rate limit exceeded');
        ws.close(WS_CLOSE.BAD_REQUEST, 'Message rate limit exceeded');
        return;
      }

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
    activeStreamServers.delete(wss);
    for (const client of wss.clients) {
      client.terminate();
    }
    wss.close();
    // Clear all connection trackers
    for (const tracker of clientConnections.values()) {
      if (tracker.resetTimer) clearTimeout(tracker.resetTimer);
    }
    clientConnections.clear();
  };
}
