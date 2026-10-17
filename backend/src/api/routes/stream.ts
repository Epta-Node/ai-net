import type { Server as HttpServer } from 'http';
import type { Socket } from 'net';
import type { IncomingMessage } from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import { randomUUID } from 'crypto';

import { eventBus as defaultEventBus } from '../../coordinator/eventBus';
import { getTask as defaultGetTask } from '../../coordinator/taskStore';
import type { EventStore, StoredEvent } from '../../events/eventStore';
import type { Task } from '../../types/task';
import { WS_CLOSE } from '../../types/stream';
import { createLogger } from '../../utils/logger';
import { runWithTraceContext } from '../../services/traceContext';
import { getConfig } from '../../config';
import {
  NonceStore,
  verifyWalletSignature,
  WALLET_NONCE_TTL_MS,
} from '../../services/auth/walletChallenge';
import { TaskStreamHub } from './taskStreamHub';

type TrustProxyFn = (address: string, hop: number) => boolean;
type ProxyAddr = (req: IncomingMessage, trust: TrustProxyFn) => string;

// Express depends on proxy-addr but does not expose its request resolver.
// eslint-disable-next-line @typescript-eslint/no-var-requires, @typescript-eslint/no-require-imports
const proxyaddr = require('proxy-addr') as ProxyAddr;

const STREAM_PATH = /^\/(?:api\/)?tasks\/([^/?]+)\/stream(?:\?.*)?$/;

/**
 * Build the canonical advertised WebSocket stream URL for a task.
 * Both `/tasks/:id/stream` and `/api/tasks/:id/stream` are accepted by the
 * upgrade handler (see STREAM_PATH above), but the API always advertises the
 * `/api/tasks/:id/stream` form so it is consistent with every other REST link.
 */
export function taskStreamUrl(taskId: string): string {
  return `/api/tasks/${taskId}/stream`;
}

const logger = createLogger({ module: 'ws-stream' });

// ---------------------------------------------------------------------------
// Wire-format normalisation
// ---------------------------------------------------------------------------

/**
 * Convert a stored event to the wire shape expected by WebSocket clients:
 *  • `type` is in snake_case  (the coordinator's original DAGEventType)
 *  • `seq`  is the per-task cursor (mapped from `taskSeq`)
 *  • `traceId` is included for trace correlation
 *
 * Clients use `event.type === 'task_completed'` / `event.seq` as a resume
 * cursor, so this mapping must be stable.
 */
export function toWireEvent(event: StoredEvent, traceId?: string): Record<string, unknown> {
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
    ...(traceId ? { traceId } : {}),
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

/**
 * Parse the optional `?traceId=<id>` query param or `X-Correlation-ID` /
 * `traceparent` header from a stream upgrade request. Returns the traceId or
 * undefined when absent.
 */
function extractTraceId(req: IncomingMessage): string | undefined {
  const url = req.url ?? '';
  const qIndex = url.indexOf('?');
  if (qIndex !== -1) {
    const queryTraceId = new URLSearchParams(url.slice(qIndex + 1)).get('traceId');
    if (queryTraceId && queryTraceId.length > 0) return queryTraceId;
  }
  const header = req.headers['x-correlation-id'];
  if (typeof header === 'string' && header.length > 0) return header;
  return undefined;
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

export function getClientIp(req: IncomingMessage, trustProxy?: TrustProxyFn): string {
  const remoteAddress = req.socket.remoteAddress ?? 'unknown';
  if (!trustProxy || !req.headers['x-forwarded-for']) return remoteAddress;
  return proxyaddr(req, trustProxy) || remoteAddress;
}

function trackConnection(ip: string): boolean {
  const maxConnections = getConfig().WS_MAX_CONNECTIONS_PER_CLIENT;
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
  trustProxy?: TrustProxyFn;
  eventBus?: typeof defaultEventBus;
  getTask?: (taskId: string) => Task | undefined;
  /** Shared nonce store (defaults to a per-server store with the standard TTL). */
  nonceStore?: NonceStore;
  /** Nonce TTL override, mainly for tests. */
  nonceTtlMs?: number;
  /**
   * Fan-out hub to read through. Pass the one the SSE endpoint uses so both
   * transports share a single bus subscription and bounded read per task.
   */
  streamHub?: TaskStreamHub;
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
 *       2. Server immediately sends `{ "type": "auth_challenge", "nonce": "<uuid>" }` — a single-use, expiring nonce.
 *       3. Within 10 seconds send JSON auth payload: `{ "walletPublicKey": "G...", "nonce": "<server nonce>", "signature": "<base64 Ed25519 signature of nonce>" }`.
 *       4. Server verifies the signature with the same challenge/verify flow as the agents endpoints. A correct public key without a valid signature is rejected. If wallet does not own task, connection closes with close code `4003` (Forbidden). Replayed or expired nonces are rejected.
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
 *   1. receives a server-issued, single-use, expiring `auth_challenge` nonce;
 *   2. must send `{ walletPublicKey, nonce, signature }` as its first message
 *      (auth handshake), where `signature` is the base64 Ed25519 signature of
 *      `nonce` made with the wallet's Stellar secret key;
 *   3. is validated against the task owner AND the signature via the shared
 *      `verifyWalletSignature` challenge flow — non-owners, invalid
 *      signatures, and replayed/expired nonces get a 403 close frame;
 *   4. receives a chronological replay of past events from the store — all of
 *      them by default, or only those with seq > N when the handshake URL
 *      carries an optional `?lastEventId=N` cursor;
 *   5. then streams live events as the Coordinator emits them.
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
    trustProxy,
    heartbeatIntervalMs = DEFAULT_HEARTBEAT_INTERVAL_MS,
    pongTimeoutMs = DEFAULT_PONG_TIMEOUT_MS,
    authTimeoutMs = DEFAULT_AUTH_TIMEOUT_MS,
    inactivityTimeoutMs = DEFAULT_INACTIVITY_TIMEOUT_MS,
    nonceStore = new NonceStore(deps.nonceTtlMs ?? WALLET_NONCE_TTL_MS),
  } = deps;

  const maxMessagesPerMinute = getConfig().WS_MAX_MESSAGES_PER_MINUTE;

  // One EventBus subscription and one bounded read per task, shared by every
  // client watching that task (#655). Clients used to each subscribe and each
  // re-query the store per tick, which made reads scale with the subscriber
  // count and tripped MaxListenersExceededWarning past 100 clients.
  const streamHub = deps.streamHub ?? new TaskStreamHub({ store: eventStore, bus: eventBus });

  const wss = new WebSocketServer({ noServer: true });
  activeStreamServers.add(wss);

  const onUpgrade = (req: IncomingMessage, socket: Socket, head: Buffer): void => {
    const match = (req.url ?? '').match(STREAM_PATH);
    if (!match) {
      socket.destroy();
      return;
    }

    // ── Connection rate limit ────────────────────────────────────────────
    const clientIp = getClientIp(req, trustProxy);
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

    // Resolve traceId from upgrade request query param or generate fresh
    const traceId = extractTraceId(_req) || randomUUID();

    let authed = false;
    // Resume cursor for this connection. With ?lastEventId=N we resume after seq
    // N; without it we fall back to -1 so the full history (seq 0 → latest) is
    // replayed — backward compatible. The hub advances its own per-subscriber
    // cursor from here on, so this value is only the starting point.
    const initialCursor = lastEventId ?? -1;
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

    // Single-use challenge for THIS connection. The client must sign it
    // within `authTimeoutMs`; consume() burns it so replays are rejected.
    const expectedNonce = nonceStore.issue();

    // Events are delivered by the shared hub, which reads the store once per
    // tick for all clients on this task. This callback only normalises to the
    // wire format (snake_case type, seq cursor) — each connection has its own
    // traceId, so formatting stays per-connection even though the read does not.
    const deliver = (event: StoredEvent): void => {
      send(toWireEvent(event, traceId));
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

    const completeAuth = (walletPublicKey: string, nonce: string, signature: string): void => {
      // The nonce must be the single-use challenge issued for THIS connection.
      // consume() burns it, so a replayed signature is rejected even when the
      // public key is correct.
      if (nonce !== expectedNonce) {
        ws.close(WS_CLOSE.FORBIDDEN, 'Forbidden: nonce does not match this connection');
        return;
      }
      const outcome = nonceStore.consume(nonce);
      if (outcome !== 'valid') {
        ws.close(WS_CLOSE.FORBIDDEN, `Forbidden: nonce ${outcome}`);
        return;
      }
      // Same challenge/verify flow as the agents endpoints: possession of the
      // public key proves nothing — only a valid Ed25519 signature does.
      if (!verifyWalletSignature(walletPublicKey, nonce, signature)) {
        ws.close(WS_CLOSE.FORBIDDEN, 'Forbidden: invalid signature');
        return;
      }
      if (walletPublicKey !== task.walletPublicKey) {
        ws.close(WS_CLOSE.FORBIDDEN, 'Forbidden: wallet does not own task');
        return;
      }
      authed = true;
      clearTimeout(authTimer);
      resetInactivityTimer();

      // Subscribe before the initial replay so any event emitted during replay
      // is captured; the hub tracks this client's cursor independently, so order
      // is preserved and nothing is delivered twice.
      // The subscribe/replay run inside the WS trace context so any logging
      // during delivery carries the same traceId.
      unsubLive = streamHub.subscribe(taskId, { lastEventId: initialCursor }, deliver);
      streamHub.flush(taskId);
      startHeartbeat();

      runWithTraceContext(
        { traceId, spanId: randomUUID(), taskId },
        () => logger.info({ taskId, clientIp }, 'WebSocket client authenticated'),
      );
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
        const frame = msg as { walletPublicKey?: unknown; nonce?: unknown; signature?: unknown };
        const walletPublicKey = frame?.walletPublicKey;
        const nonce = frame?.nonce;
        const signature = frame?.signature;
        if (
          typeof walletPublicKey !== 'string' || walletPublicKey === '' ||
          typeof nonce !== 'string' || nonce === '' ||
          typeof signature !== 'string' || signature === ''
        ) {
          ws.close(WS_CLOSE.BAD_REQUEST, 'First message must be { walletPublicKey, nonce, signature }');
          return;
        }
        completeAuth(walletPublicKey, nonce, signature);
        return;
      }

      // Authenticated: the only client message we expect is a heartbeat pong.
      if ((msg as { type?: unknown })?.type === 'pong' && pongTimer) {
        clearTimeout(pongTimer);
        pongTimer = undefined;
      }
    });

    // Issue the single-use auth challenge AFTER handlers are attached so the
    // client cannot race the server. The client must sign `expectedNonce`
    // within `authTimeoutMs`.
    send({ type: 'auth_challenge', nonce: expectedNonce });

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
