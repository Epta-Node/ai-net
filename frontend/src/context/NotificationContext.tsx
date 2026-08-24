import { createContext, useContext, useState, useEffect, useCallback, type ReactNode, useRef } from 'react';
import type { AppNotification, NewNotificationInput, NotificationContextValue } from '../types/notification';

export const NOTIFICATIONS_STORAGE_KEY = 'ai_net_notifications';
const MAX_NOTIFICATIONS = 50;

export const NotificationContext = createContext<NotificationContextValue | null>(null);

function loadInitialNotifications(): AppNotification[] {
  try {
    const raw = localStorage.getItem(NOTIFICATIONS_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      return parsed;
    }
  } catch (err) {
    console.error('Failed to parse notifications from localStorage:', err);
  }
  return [];
}

export function NotificationProvider({ children }: { children: ReactNode }) {
  const [notifications, setNotifications] = useState<AppNotification[]>(loadInitialNotifications);
  const [isConnected, setIsConnected] = useState<boolean>(false);
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reconnectAttemptsRef = useRef<number>(0);

  // Sync to localStorage
  useEffect(() => {
    try {
      localStorage.setItem(NOTIFICATIONS_STORAGE_KEY, JSON.stringify(notifications));
    } catch (err) {
      console.error('Failed to persist notifications to localStorage:', err);
    }
  }, [notifications]);

  const unreadCount = notifications.filter(n => !n.read).length;

  const markAsRead = useCallback((id: string) => {
    setNotifications(prev =>
      prev.map(n => (n.id === id ? { ...n, read: true } : n))
    );
  }, []);

  const markAllAsRead = useCallback(() => {
    setNotifications(prev =>
      prev.map(n => ({ ...n, read: true }))
    );
  }, []);

  const addNotification = useCallback((input: NewNotificationInput) => {
    const id = input.id || `notif_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const timestamp = input.timestamp || new Date().toISOString();
    const read = input.read ?? false;

    const newNotification: AppNotification = {
      ...input,
      id,
      timestamp,
      read,
    };

    setNotifications(prev => {
      const filtered = prev.filter(n => n.id !== id);
      return [newNotification, ...filtered].slice(0, MAX_NOTIFICATIONS);
    });
  }, []);

  const removeNotification = useCallback((id: string) => {
    setNotifications(prev => prev.filter(n => n.id !== id));
  }, []);

  const clearNotifications = useCallback(() => {
    setNotifications([]);
  }, []);

  // Helper to map incoming WebSocket / event data to AppNotification
  const handleIncomingEvent = useCallback((eventData: any) => {
    if (!eventData || typeof eventData !== 'object') return;

    const eventType = eventData.type;
    const taskId = eventData.taskId;
    const nodeId = eventData.nodeId;
    const payload = eventData.payload;
    const timestamp = eventData.timestamp || new Date().toISOString();

    let notification: NewNotificationInput | null = null;

    switch (eventType) {
      case 'task_completed':
        notification = {
          type: 'task',
          title: 'Task Completed',
          description: `Task ${taskId || ''} completed successfully.`,
          link: taskId ? `/tasks/${taskId}` : '/dashboard',
          timestamp,
        };
        break;

      case 'task_failed':
        notification = {
          type: 'task',
          title: 'Task Failed',
          description: `Task ${taskId || ''} failed.${payload?.error ? ` Error: ${payload.error}` : ''}`,
          link: taskId ? `/tasks/${taskId}` : '/dashboard',
          timestamp,
        };
        break;

      case 'node_completed':
        notification = {
          type: 'task',
          title: 'DAG Node Completed',
          description: `Node ${nodeId || 'task'} finished in task ${taskId || ''}.`,
          link: taskId ? `/tasks/${taskId}` : '/dashboard',
          timestamp,
        };
        break;

      case 'node_failed':
        notification = {
          type: 'task',
          title: 'DAG Node Failed',
          description: `Node ${nodeId || 'task'} failed in task ${taskId || ''}.${payload?.error ? ` (${payload.error})` : ''}`,
          link: taskId ? `/tasks/${taskId}` : '/dashboard',
          timestamp,
        };
        break;

      case 'payment_released':
        notification = {
          type: 'payment',
          title: 'Payment Confirmed',
          description: `Payment released for task ${taskId || ''}.${payload?.txHash ? ` Tx: ${payload.txHash.slice(0, 8)}...` : ''}`,
          link: '/wallet',
          timestamp,
        };
        break;

      case 'payment_locked':
        notification = {
          type: 'payment',
          title: 'Payment Escrow Locked',
          description: `Payment locked in escrow for task ${taskId || ''}.`,
          link: '/wallet',
          timestamp,
        };
        break;

      case 'agent_status':
      case 'agent_registered':
        notification = {
          type: 'agent',
          title: 'Agent Status Changed',
          description: payload?.message || `Agent ${payload?.agentId || 'status'} updated.`,
          link: '/agents',
          timestamp,
        };
        break;

      case 'notification':
      case 'custom_notification':
        if (payload?.title && payload?.description) {
          notification = {
            type: payload.type || 'system',
            title: payload.title,
            description: payload.description,
            link: payload.link,
            timestamp,
          };
        }
        break;

      default:
        // If direct notification shape was sent
        if (eventData.title && eventData.description) {
          notification = {
            type: eventData.type || 'system',
            title: eventData.title,
            description: eventData.description,
            link: eventData.link,
            timestamp,
          };
        }
        break;
    }

    if (notification) {
      addNotification(notification);
    }
  }, [addNotification]);

  // WebSocket connection management
  useEffect(() => {
    let isUnmounted = false;

    const connect = () => {
      if (typeof window === 'undefined' || typeof WebSocket === 'undefined') return;

      try {
        const wsUrl = `ws://${window.location.hostname || 'localhost'}:3001/events`;
        const ws = new WebSocket(wsUrl);
        wsRef.current = ws;

        ws.onopen = () => {
          if (isUnmounted) return;
          setIsConnected(true);
          reconnectAttemptsRef.current = 0;
        };

        ws.onmessage = (event) => {
          try {
            const data = JSON.parse(event.data);
            handleIncomingEvent(data);
          } catch (e) {
            console.error('Failed to parse incoming WebSocket message:', e);
          }
        };

        ws.onerror = () => {
          if (isUnmounted) return;
          setIsConnected(false);
        };

        ws.onclose = () => {
          if (isUnmounted) return;
          setIsConnected(false);
          // Exponential backoff reconnect up to 5 attempts
          if (reconnectAttemptsRef.current < 5) {
            const delay = 1000 * Math.pow(2, reconnectAttemptsRef.current);
            reconnectAttemptsRef.current += 1;
            reconnectTimeoutRef.current = setTimeout(connect, delay);
          }
        };
      } catch (err) {
        setIsConnected(false);
      }
    };

    connect();

    // Also listen for local custom events
    const handleCustomEvent = (e: Event) => {
      const customEvent = e as CustomEvent;
      if (customEvent.detail) {
        if (customEvent.detail.title) {
          addNotification(customEvent.detail);
        } else {
          handleIncomingEvent(customEvent.detail);
        }
      }
    };

    window.addEventListener('ai-net-notification', handleCustomEvent);

    return () => {
      isUnmounted = true;
      if (reconnectTimeoutRef.current) {
        clearTimeout(reconnectTimeoutRef.current);
      }
      if (wsRef.current) {
        wsRef.current.close();
      }
      window.removeEventListener('ai-net-notification', handleCustomEvent);
    };
  }, [handleIncomingEvent, addNotification]);

  return (
    <NotificationContext.Provider
      value={{
        notifications,
        unreadCount,
        markAsRead,
        markAllAsRead,
        addNotification,
        removeNotification,
        clearNotifications,
        isConnected,
      }}
    >
      {children}
    </NotificationContext.Provider>
  );
}

export function useNotificationContext() {
  const context = useContext(NotificationContext);
  return context;
}
