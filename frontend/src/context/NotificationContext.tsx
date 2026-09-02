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
      return parsed.map((item: any) => ({
        ...item,
        message: item.message || item.description || '',
        description: item.description || item.message || '',
      }));
    }
  } catch (err) {
    console.error('Failed to parse notifications from localStorage:', err);
  }
  return [];
}

/** Helper to dispatch an application toast event */
export function triggerToastNotification(message: string, type: 'success' | 'error' | 'warning' | 'info' = 'info') {
  if (typeof window !== 'undefined') {
    window.dispatchEvent(
      new CustomEvent('app-toast', {
        detail: { message, type },
      })
    );
  }
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
    const msg = input.message || input.description || '';
    const desc = input.description || input.message || '';

    const newNotification: AppNotification = {
      ...input,
      id,
      timestamp,
      read,
      message: msg,
      description: desc,
    };

    setNotifications(prev => {
      const filtered = prev.filter(n => n.id !== id);
      return [newNotification, ...filtered].slice(0, MAX_NOTIFICATIONS);
    });
  }, []);

  const removeNotification = useCallback((id: string) => {
    setNotifications(prev => prev.filter(n => n.id !== id));
  }, []);

  const clearAll = useCallback(() => {
    setNotifications([]);
  }, []);

  // Helper to map incoming WebSocket / event data to AppNotification and trigger toasts
  const handleIncomingEvent = useCallback((eventData: any) => {
    if (!eventData || typeof eventData !== 'object') return;

    const eventType = eventData.type;
    const taskId = eventData.taskId;
    const nodeId = eventData.nodeId;
    const payload = eventData.payload;
    const timestamp = eventData.timestamp || new Date().toISOString();

    let notification: NewNotificationInput | null = null;
    let toastMessage: string | null = null;
    let toastType: 'success' | 'error' | 'warning' | 'info' = 'info';

    switch (eventType) {
      case 'task_completed':
        notification = {
          type: 'task_completed',
          title: 'Task Completed',
          message: `Task ${taskId || ''} completed successfully.`,
          description: `Task ${taskId || ''} completed successfully.`,
          link: taskId ? `/tasks/${taskId}` : '/dashboard',
          timestamp,
          metadata: payload,
        };
        toastMessage = `Task ${taskId || ''} completed successfully.`;
        toastType = 'success';
        break;

      case 'task_failed':
        notification = {
          type: 'task_failed',
          title: 'Task Failed',
          message: `Task ${taskId || ''} failed.${payload?.error ? ` Error: ${payload.error}` : ''}`,
          description: `Task ${taskId || ''} failed.${payload?.error ? ` Error: ${payload.error}` : ''}`,
          link: taskId ? `/tasks/${taskId}` : '/dashboard',
          timestamp,
          metadata: payload,
        };
        toastMessage = `Task ${taskId || ''} failed.`;
        toastType = 'error';
        break;

      case 'node_completed':
        notification = {
          type: 'task_completed',
          title: 'DAG Node Completed',
          message: `Node ${nodeId || 'task'} finished in task ${taskId || ''}.`,
          description: `Node ${nodeId || 'task'} finished in task ${taskId || ''}.`,
          link: taskId ? `/tasks/${taskId}` : '/dashboard',
          timestamp,
          metadata: payload,
        };
        break;

      case 'node_failed':
        notification = {
          type: 'task_failed',
          title: 'DAG Node Failed',
          message: `Node ${nodeId || 'task'} failed in task ${taskId || ''}.${payload?.error ? ` (${payload.error})` : ''}`,
          description: `Node ${nodeId || 'task'} failed in task ${taskId || ''}.${payload?.error ? ` (${payload.error})` : ''}`,
          link: taskId ? `/tasks/${taskId}` : '/dashboard',
          timestamp,
          metadata: payload,
        };
        break;

      case 'payment_received':
      case 'payment_released':
        notification = {
          type: 'payment_received',
          title: 'Payment Received',
          message: `Payment received for task ${taskId || ''}.${payload?.amount ? ` (${payload.amount} XLM)` : ''}${payload?.txHash ? ` Tx: ${payload.txHash.slice(0, 8)}...` : ''}`,
          description: `Payment received for task ${taskId || ''}.${payload?.amount ? ` (${payload.amount} XLM)` : ''}${payload?.txHash ? ` Tx: ${payload.txHash.slice(0, 8)}...` : ''}`,
          link: '/wallet',
          timestamp,
          metadata: payload,
        };
        toastMessage = `Payment of ${payload?.amount ? `${payload.amount} XLM` : 'funds'} received.`;
        toastType = 'success';
        break;

      case 'payment_locked':
        notification = {
          type: 'payment_received',
          title: 'Payment Escrow Locked',
          message: `Payment locked in escrow for task ${taskId || ''}.`,
          description: `Payment locked in escrow for task ${taskId || ''}.`,
          link: '/wallet',
          timestamp,
          metadata: payload,
        };
        break;

      case 'agent_status':
      case 'agent_registered':
        notification = {
          type: 'agent_registered',
          title: 'Agent Registered',
          message: payload?.message || `Agent ${payload?.agentId || payload?.name || 'status'} updated.`,
          description: payload?.message || `Agent ${payload?.agentId || payload?.name || 'status'} updated.`,
          link: '/agents',
          timestamp,
          metadata: payload,
        };
        break;

      case 'notification':
      case 'custom_notification':
        if (payload?.title && (payload?.message || payload?.description)) {
          notification = {
            type: payload.type || 'system',
            title: payload.title,
            message: payload.message || payload.description,
            description: payload.description || payload.message,
            link: payload.link,
            timestamp,
            metadata: payload,
          };
          if (payload.toast) {
            toastMessage = payload.message || payload.description;
            toastType = payload.toastType || 'info';
          }
        }
        break;

      default:
        if (eventData.title && (eventData.message || eventData.description)) {
          notification = {
            type: eventData.type || 'system',
            title: eventData.title,
            message: eventData.message || eventData.description,
            description: eventData.description || eventData.message,
            link: eventData.link,
            timestamp,
            metadata: eventData.metadata || payload,
          };
        }
        break;
    }

    if (notification) {
      addNotification(notification);
    }

    if (toastMessage) {
      triggerToastNotification(toastMessage, toastType);
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

    // Also listen for local custom events (allows testing & client-side triggers)
    const handleCustomEvent = (e: Event) => {
      const customEvent = e as CustomEvent;
      if (customEvent.detail) {
        if (customEvent.detail.title && (customEvent.detail.message || customEvent.detail.description)) {
          addNotification(customEvent.detail);
          if (customEvent.detail.type === 'task_completed' || customEvent.detail.type === 'payment_received') {
            triggerToastNotification(
              customEvent.detail.message || customEvent.detail.description || customEvent.detail.title,
              'success'
            );
          }
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
        clearAll,
        clearNotifications: clearAll,
        addNotification,
        removeNotification,
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
