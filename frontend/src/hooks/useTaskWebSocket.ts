import { useState, useEffect, useRef, useCallback } from 'react';
import type { DAGEvent } from '../types/api';

export interface UseTaskWebSocketOptions {
  taskId: string;
  onMessage: (event: DAGEvent) => void;
  onConnect?: () => void;
  onDisconnect?: () => void;
  /**
   * Public key of the wallet that owns the task. When provided, the client
   * waits for the server's `auth_challenge` nonce and answers with
   * `{ walletPublicKey, nonce, signature }` so the server can authenticate
   * the connection. See backend `AuthMessage` (#653).
   */
  walletPublicKey?: string;
  /**
   * Signs the server-issued auth nonce with the wallet's secret key and
   * resolves the base64 Ed25519 signature. Required together with
   * `walletPublicKey` to complete the stream handshake — without it the
   * client cannot prove ownership and the server closes the socket.
   */
  signChallenge?: (nonce: string) => string | Promise<string>;
  /**
   * When true, no socket is opened until `walletPublicKey` is present;
   * the hook reports `authentication-required` instead. Used by
   * `useTaskMonitor` for wallet-gated task streams.
   */
  requireAuthentication?: boolean;
  /** Base host for the stream. Defaults to localhost:3001 (matching the server). */
  baseUrl?: string;
  /** Maximum automatic reconnect attempts before giving up. Default 8. */
  maxReconnectAttempts?: number;
  /**
   * When true (e.g. the task reached a terminal state), a dropped socket is
   * not retried and any pending retry is cancelled.
   */
  stopReconnecting?: boolean;
  /**
   * Maximum random jitter (ms) added to each reconnect backoff to avoid a
   * thundering herd of clients reconnecting at once. Default 0 so the base
   * exponential backoff stays deterministic in tests; enable in production.
   */
  maxJitterMs?: number;
}

export type WebSocketStatus =
  'connecting' | 'connected' | 'disconnected' | 'error' | 'authentication-required';

/** Application-defined close code for a stale socket: mirros backend WS_CLOSE.STALE. */
const WS_CLOSE_STALE = 4408;

/**
 * Derives the WebSocket stream host/prefix.
 * 1. Uses VITE_WS_URL if set.
 * 2. Falls back to VITE_API_BASE_URL upgraded to ws/wss.
 * 3. Falls back to same-origin (window.location) upgraded to ws/wss.
 */
function getDefaultWsBaseUrl(): string {
  if (typeof import.meta !== 'undefined' && import.meta.env?.VITE_WS_URL) {
    return import.meta.env.VITE_WS_URL;
  }
  
  if (typeof import.meta !== 'undefined' && import.meta.env?.VITE_API_BASE_URL) {
    const apiBase = import.meta.env.VITE_API_BASE_URL;
    if (apiBase.startsWith('http')) {
      return apiBase.replace(/^http/, 'ws');
    }
  }

  if (typeof window !== 'undefined') {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${protocol}//${window.location.host}`;
  }

  return 'ws://localhost:3001';
}

const DEFAULT_BASE_URL = getDefaultWsBaseUrl();

export const MAX_RECONNECT_DELAY_MS = 30_000;

/** Backoff before reconnect attempt `attempt` (0 based): 1s, 2s, 4s … capped at 30s, plus jitter. */
export function reconnectDelayMs(attempt: number, maxJitterMs = 0): number {
  const base = Math.min(1000 * Math.pow(2, attempt), MAX_RECONNECT_DELAY_MS);
  const jitter = maxJitterMs > 0 ? Math.floor(Math.random() * maxJitterMs) : 0;
  return base + jitter;
}

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
    signChallenge,
    requireAuthentication,
    baseUrl = DEFAULT_BASE_URL,
    maxReconnectAttempts = 8,
    maxJitterMs = 0,
    stopReconnecting = false,
  } = options;

  const [isConnected, setIsConnected] = useState(false);
  const [status, setStatus] = useState<WebSocketStatus>('connecting');
  const [reconnectAttempt, setReconnectAttempt] = useState(0);
  const [reconnectIn, setReconnectIn] = useState(0);
  const stopReconnectingRef = useRef(stopReconnecting);
  stopReconnectingRef.current = stopReconnecting;

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
  // Latest signer, kept in a ref so reconnects use the current callback.
  const signChallengeRef = useRef(signChallenge);
  signChallengeRef.current = signChallenge;
  const walletPublicKeyRef = useRef(walletPublicKey);
  walletPublicKeyRef.current = walletPublicKey;
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
    if (requireAuthentication && !walletPublicKey) {
      clearReconnectTimeout();
      setIsConnected(false);
      setStatus('authentication-required');
      return;
    }
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
    const base = baseUrl.replace(/\/$/, '');
    // Using /api/tasks matches same-origin proxy rules
    const wsUrl = `${base}/api/tasks/${taskId}/stream${query}`;
    const ws = new WebSocket(wsUrl);
    wsRef.current = ws;

    ws.onopen = () => {
      setStatus('connected');
      setIsConnected(true);
      reconnectAttemptRef.current = 0; // reset reconnect attempts on a live socket
      setReconnectAttempt(0);
      setReconnectIn(0);
      gapRetriedRef.current = false;
      // Auth is challenge-response: the server sends `auth_challenge` first
      // (see onmessage below). Nothing is sent here so a stale or replayed
      // frame can never authenticate the socket.
      onConnectRef.current?.();
    };

    ws.onmessage = (event) => {
      let data: unknown;
      try {
        data = JSON.parse(event.data);
      } catch (err) {
        console.error('Failed to parse WebSocket event:', err);
        return;
      }

      // Server-issued auth challenge: sign the single-use nonce and answer
      // with the signed handshake frame. Never forwarded to onMessage.
      if ((data as { type?: unknown }).type === 'auth_challenge') {
        const nonce = (data as { nonce?: unknown }).nonce;
        const publicKey = walletPublicKeyRef.current;
        const signer = signChallengeRef.current;
        if (typeof nonce === 'string' && nonce !== '' && publicKey && signer) {
          Promise.resolve()
            .then(() => signer(nonce))
            .then((signature) => {
              if (ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({ walletPublicKey: publicKey, nonce, signature }));
              }
            })
            .catch((err) => {
              console.error('Failed to sign WebSocket auth challenge:', err);
            });
        }
        return;
      }

      // Heartbeat pong: the server sends `{ type: 'ping' }` every interval and
      // closes the socket (code 4408) unless we answer `{ type: 'pong' }`.
      if ((data as { type?: unknown }).type === 'ping') {
        ws.send(JSON.stringify({ type: 'pong' }));
        return;
      }

      const typedData = data as DAGEvent;

      const seq = seqCursor(typedData.seq);
      if (seq !== undefined) {
        const expected = lastSeqRef.current + 1;
        // A forward jump in seq means we missed events. Trigger one reconnect
        // with the resume cursor so the server replays the gap. If the gap
        // persists (e.g. the store pruned intermediate events) we accept the
        // stream rather than reconnect-loop forever.
        if (
          seq > expected &&
          expected > 0 &&
          !gapRetriedRef.current &&
          ws.readyState === WebSocket.OPEN
        ) {
          gapRetriedRef.current = true;
          lastSeqRef.current = seq;
          resumeCursorRef.current = seq;
          try {
            sessionStorage.setItem(cursorStorageKey(taskId), String(seq));
          } catch {
            /* non-fatal */
          }
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
        } catch {
          /* non-fatal */
        }
      }

      onMessageRef.current(typedData);
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
      if (manualCloseRef.current || stopReconnectingRef.current) {
        setReconnectIn(0);
        return;
      }

      // A 4408 (STALE) close means the server killed the socket because we did
      // not answer a heartbeat in time. Reset the backoff so we reconnect
      // promptly rather than waiting out an ever-growing delay.
      if (event.code === WS_CLOSE_STALE) {
        reconnectAttemptRef.current = 0;
      }

      if (reconnectAttemptRef.current < maxReconnectAttempts) {
        const delay = reconnectDelayMs(reconnectAttemptRef.current, maxJitterMs);
        reconnectAttemptRef.current += 1;
        setReconnectAttempt(reconnectAttemptRef.current);
        setReconnectIn(delay);
        clearReconnectTimeout();
        reconnectTimeoutRef.current = setTimeout(() => {
          reconnectTimeoutRef.current = null;
          setReconnectIn(0);
          connectWebSocket();
        }, delay);
      } else {
        setReconnectIn(0);
      }
    };
  }, [
    taskId,
    baseUrl,
    walletPublicKey,
    requireAuthentication,
    maxReconnectAttempts,
    maxJitterMs,
    clearReconnectTimeout,
  ]);

  // A task that has finished will never send more events, so drop any pending retry.
  useEffect(() => {
    if (stopReconnecting) {
      clearReconnectTimeout();
      setReconnectIn(0);
    }
  }, [stopReconnecting, clearReconnectTimeout]);

  const reconnect = useCallback(() => {
    reconnectAttemptRef.current = 0;
    connectWebSocket();
  }, [connectWebSocket]);

  useEffect(() => {
    if (!taskId) return;

    if (requireAuthentication && !walletPublicKey) {
      setIsConnected(false);
      setStatus('authentication-required');
      return;
    }

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
    } catch {
      /* non-fatal */
    }

    connectWebSocket();

    return () => {
      disconnect();
    };
  }, [taskId, walletPublicKey, requireAuthentication, connectWebSocket, disconnect]);

  return {
    isConnected,
    status,
    reconnectAttempt,
    reconnectIn,
    reconnect,
    disconnect,
  };
};
