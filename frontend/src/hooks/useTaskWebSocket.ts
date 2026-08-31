import { useState, useEffect, useRef, useCallback } from 'react';
import type { DAGEvent } from '../types/api';

export interface UseTaskWebSocketOptions {
  taskId: string;
  onMessage: (event: DAGEvent) => void;
  onConnect?: () => void;
  onDisconnect?: () => void;
  /**
   * Public key of the wallet that owns the task. When provided it is sent as
   * the first frame after the socket opens (`{ walletPublicKey }`) so the
   * server can authenticate the connection. See backend `AuthMessage`.
   */
  walletPublicKey?: string;
  /** Base host for the stream. Defaults to localhost:3001 (matching the server). */
  baseUrl?: string;
  /** Maximum automatic reconnect attempts before giving up. Default 5. */
  maxReconnectAttempts?: number;
  /**
   * Maximum random jitter (ms) added to each reconnect backoff to avoid a
   * thundering herd of clients reconnecting at once. Default 0 so the base
   * exponential backoff stays deterministic in tests; enable in production.
   */
  maxJitterMs?: number;
}

export type WebSocketStatus = 'connecting' | 'connected' | 'disconnected' | 'error';

/** Application-defined close code for a stale socket: mirros backend WS_CLOSE.STALE. */
const WS_CLOSE_STALE = 4408;
const DEFAULT_BASE_URL = 'ws://localhost:3001';

/** Build the event cursor only to be truthy for positive sequences. */
const seqCursor = (seq: number | undefined): number | undefined =>
  typeof seq === 'number' && Number.isInteger(seq) && seq >= 0 ? seq : undefined;

function cursorStorageKey(taskId: string): string {
  return `ai-net:ws-cursor:${taskId}`;
}

export const useTaskWebSocket = (options: UseTaskWebSocketOptions) => {
  const {
    taskId,
    onMessage,
    onConnect,
    onDisconnect,
    walletPublicKey,
    baseUrl = DEFAULT_BASE_URL,
    maxReconnectAttempts = 5,
    maxJitterMs = 0,
  } = options;

  const [isConnected, setIsConnected] = useState(false);
  const [status, setStatus] = useState<WebSocketStatus>('connecting');

  const wsRef = useRef<WebSocket | null>(null);
  const reconnectAttemptRef = useRef<number>(0);
  const reconnectTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Guards against scheduling a reconnect after an intentional shutdown.
  const manualCloseRef = useRef<boolean>(false);

  // Latest event sequence seen for this task — used both to persist a resume
  // cursor and to detect mid-stream gaps.
  const lastSeqRef = useRef<number>(-1);
  const resumeCursorRef = useRef<number>(-1);
  const gapRetriedRef = useRef<boolean>(false);

  // Handlers must see the latest onMessage/etc. across reconnects.
  const onMessageRef = useRef(onMessage);
  onMessageRef.current = onMessage;
  const onConnectRef = useRef(onConnect);
  onConnectRef.current = onConnect;
  const onDisconnectRef = useRef(onDisconnect);
  onDisconnectRef.current = onDisconnect;

  const clearReconnectTimeout = useCallback(() => {
    if (reconnectTimeoutRef.current) {
      clearTimeout(reconnectTimeoutRef.current);
      reconnectTimeoutRef.current = null;
    }
  }, []);

  const disconnect = useCallback(() => {
    clearReconnectTimeout();
    if (wsRef.current) {
      manualCloseRef.current = true;
      wsRef.current.close();
      wsRef.current = null;
    }
    setIsConnected(false);
    setStatus('disconnected');
  }, [clearReconnectTimeout]);

  const connectWebSocket = useCallback(() => {
    if (wsRef.current) {
      // Neutralise the previous socket so its own close/error handlers cannot
      // schedule a reconnect while we're opening a fresh one.
      const prev = wsRef.current;
      prev.onopen = null;
      prev.onmessage = null;
      prev.onerror = null;
      prev.onclose = null;
      prev.close();
    }

    setStatus('connecting');
    setIsConnected(false);
    manualCloseRef.current = false;

    // Resume from the last known cursor (persisted across reconnects & pages)
    // by asking the server to replay events with seq > cursor.
    const cursor = resumeCursorRef.current >= 0 ? resumeCursorRef.current : undefined;
    const query = cursor !== undefined ? `?lastEventId=${cursor}` : '';
    const wsUrl = `${baseUrl}/tasks/${taskId}/stream${query}`;
    const ws = new WebSocket(wsUrl);
    wsRef.current = ws;

    ws.onopen = () => {
      setStatus('connected');
      setIsConnected(true);
      reconnectAttemptRef.current = 0; // reset reconnect attempts on a live socket
      gapRetriedRef.current = false;
      if (walletPublicKey) {
        ws.send(JSON.stringify({ walletPublicKey }));
      }
      onConnectRef.current?.();
    };

    ws.onmessage = (event) => {
      let data: DAGEvent;
      try {
        data = JSON.parse(event.data);
      } catch (err) {
        console.error('Failed to parse WebSocket event:', err);
        return;
      }

      // Heartbeat pong: the server sends `{ type: 'ping' }` every interval and
      // closes the socket (code 4408) unless we answer `{ type: 'pong' }`.
      if ((data as { type?: unknown }).type === 'ping') {
        ws.send(JSON.stringify({ type: 'pong' }));
        return;
      }

      const seq = seqCursor(data.seq);
      if (seq !== undefined) {
        const expected = lastSeqRef.current + 1;
        // A forward jump in seq means we missed events. Trigger one reconnect
        // with the resume cursor so the server replays the gap. If the gap
        // persists (e.g. the store pruned intermediate events) we accept the
        // stream rather than reconnect-loop forever.
        if (seq > expected && expected > 0 && !gapRetriedRef.current && ws.readyState === WebSocket.OPEN) {
          gapRetriedRef.current = true;
          lastSeqRef.current = seq;
          resumeCursorRef.current = seq;
          try {
            sessionStorage.setItem(cursorStorageKey(taskId), String(seq));
          } catch { /* non-fatal */ }
          // Neutralise the current socket's handlers so its own close does not
          // schedule an extra reconnect — we re-sync via the cursor below.
          ws.onopen = null;
          ws.onmessage = null;
          ws.onerror = null;
          ws.onclose = null;
          connectWebSocket();
          return;
        }
        lastSeqRef.current = seq;
        resumeCursorRef.current = seq;
        try {
          sessionStorage.setItem(cursorStorageKey(taskId), String(seq));
        } catch { /* non-fatal */ }
      }

      onMessageRef.current(data);
    };

    ws.onerror = () => {
      setStatus('error');
      setIsConnected(false);
    };

    ws.onclose = (event) => {
      setStatus('disconnected');
      setIsConnected(false);
      onDisconnectRef.current?.();

      // Never auto-reconnect after an intentional shutdown (component unmount
      // or explicit disconnect()).
      if (manualCloseRef.current) {
        return;
      }

      // A 4408 (STALE) close means the server killed the socket because we did
      // not answer a heartbeat in time. Reset the backoff so we reconnect
      // promptly rather than waiting out an ever-growing delay.
      if (event.code === WS_CLOSE_STALE) {
        reconnectAttemptRef.current = 0;
      }

      if (reconnectAttemptRef.current < maxReconnectAttempts) {
        const baseDelay = 1000 * Math.pow(2, reconnectAttemptRef.current);
        const jitter = maxJitterMs > 0 ? Math.floor(Math.random() * maxJitterMs) : 0;
        const delay = Math.max(0, baseDelay + jitter);
        reconnectAttemptRef.current += 1;
        clearReconnectTimeout();
        reconnectTimeoutRef.current = setTimeout(() => {
          reconnectTimeoutRef.current = null;
          connectWebSocket();
        }, delay);
      }
    };
  }, [taskId, baseUrl, walletPublicKey, maxReconnectAttempts, maxJitterMs, clearReconnectTimeout]);

  const reconnect = useCallback(() => {
    reconnectAttemptRef.current = 0;
    connectWebSocket();
  }, [connectWebSocket]);

  useEffect(() => {
    if (!taskId) return;

    // Restore the persisted cursor for this task so a page reload resumes.
    try {
      const saved = sessionStorage.getItem(cursorStorageKey(taskId));
      if (saved !== null) {
        const n = Number(saved);
        if (Number.isInteger(n) && n >= 0) {
          lastSeqRef.current = n;
          resumeCursorRef.current = n;
        }
      }
    } catch { /* non-fatal */ }

    connectWebSocket();

    return () => {
      disconnect();
    };
  }, [taskId, connectWebSocket, disconnect]);

  return {
    isConnected,
    status,
    reconnect,
    disconnect,
  };
};
