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
      onConnect?.();
    };

    ws.onmessage = (event) => {
      try {
        const data: DAGEvent = JSON.parse(event.data);
        onMessage(data);
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
      onDisconnect?.();
      
      // Reconnect with exponential backoff (max 5 attempts)
      if (reconnectAttemptRef.current < 5) {
        const delay = 1000 * Math.pow(2, reconnectAttemptRef.current);
        reconnectAttemptRef.current += 1;
        reconnectTimeoutRef.current = setTimeout(() => {
          connectWebSocket();
        }, delay);
      }
    };
  }, [taskId, onMessage, onConnect, onDisconnect]);

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
