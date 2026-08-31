import { useState, useEffect, useRef, useCallback } from 'react';
import type { DAGEvent } from '../types/api';

export interface UseTaskWebSocketOptions {
  taskId: string;
  onMessage: (event: DAGEvent) => void;
  onConnect?: () => void;
  onDisconnect?: () => void;
}

export type WebSocketStatus = 'connecting' | 'connected' | 'disconnected' | 'error';

export const useTaskWebSocket = (options: UseTaskWebSocketOptions) => {
  const { taskId, onMessage, onConnect, onDisconnect } = options;
  const [isConnected, setIsConnected] = useState(false);
  const [status, setStatus] = useState<WebSocketStatus>('connecting');
  
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectAttemptRef = useRef<number>(0);
  const reconnectTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // `onMessage`/`onConnect`/`onDisconnect` are typically inline/useCallback
  // results from the caller that change identity on every render (they close
  // over other per-render state). Reading them via refs instead of depending
  // on them directly keeps `connectWebSocket` stable across renders, so the
  // effect below doesn't tear down and reopen the socket every time the
  // component re-renders — which otherwise makes `status` flicker between
  // "connecting"/"disconnected" indefinitely and the connection never settles.
  const onMessageRef = useRef(onMessage);
  const onConnectRef = useRef(onConnect);
  const onDisconnectRef = useRef(onDisconnect);
  useEffect(() => {
    onMessageRef.current = onMessage;
    onConnectRef.current = onConnect;
    onDisconnectRef.current = onDisconnect;
  }, [onMessage, onConnect, onDisconnect]);

  const disconnect = useCallback(() => {
    if (wsRef.current) {
      wsRef.current.close();
      wsRef.current = null;
    }
    if (reconnectTimeoutRef.current) {
      clearTimeout(reconnectTimeoutRef.current);
      reconnectTimeoutRef.current = null;
    }
    setIsConnected(false);
    setStatus('disconnected');
  }, []);

  const connectWebSocket = useCallback(() => {
    if (wsRef.current) {
      wsRef.current.close();
    }

    setStatus('connecting');
    setIsConnected(false);
    
    const wsUrl = `ws://localhost:3001/tasks/${taskId}/stream`;
    const ws = new WebSocket(wsUrl);
    wsRef.current = ws;

    ws.onopen = () => {
      setStatus('connected');
      setIsConnected(true);
      reconnectAttemptRef.current = 0; // reset reconnect attempts
      onConnectRef.current?.();
    };

    ws.onmessage = (event) => {
      try {
        const data: DAGEvent = JSON.parse(event.data);
        onMessageRef.current(data);
      } catch (err) {
        console.error('Failed to parse WebSocket event:', err);
      }
    };

    ws.onerror = () => {
      setStatus('error');
      setIsConnected(false);
    };

    ws.onclose = () => {
      setStatus('disconnected');
      setIsConnected(false);
      onDisconnectRef.current?.();

      // Reconnect with exponential backoff (max 5 attempts)
      if (reconnectAttemptRef.current < 5) {
        const delay = 1000 * Math.pow(2, reconnectAttemptRef.current);
        reconnectAttemptRef.current += 1;
        reconnectTimeoutRef.current = setTimeout(() => {
          connectWebSocket();
        }, delay);
      }
    };
  }, [taskId]);

  const reconnect = useCallback(() => {
    reconnectAttemptRef.current = 0;
    connectWebSocket();
  }, [connectWebSocket]);

  useEffect(() => {
    if (!taskId) return;

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
