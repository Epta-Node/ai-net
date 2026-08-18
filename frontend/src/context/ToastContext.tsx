import { createContext, useCallback, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { ToastContainer } from '../components/common/Toast';
import { createContext, useContext, useState, useCallback, type ReactNode } from 'react';

export type ToastType = 'success' | 'error' | 'warning' | 'info';

export interface Toast {
  id: string;
  message: string;
  type: ToastType;
  duration: number;
  duration?: number;
}

interface ToastContextValue {
  toasts: Toast[];
  showToast: (message: string, type?: ToastType, duration?: number) => void;
  dismissToast: (id: string) => void;
}

const defaultDurations: Record<ToastType, number> = {
  success: 5000,
  info: 5000,
  warning: 10000,
  error: 10000,
};

export const ToastContext = createContext<ToastContextValue | undefined>(undefined);
const ToastContext = createContext<ToastContextValue | null>(null);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);

  const dismissToast = useCallback((id: string) => {
    setToasts((prev) => prev.filter((toast) => toast.id !== id));
  }, []);

  const showToast = useCallback(
    (message: string, type: ToastType = 'info', duration = defaultDurations[type]) => {
      const id = typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : Math.random().toString(36).slice(2);

      setToasts((prev) => [...prev, { id, message, type, duration }]);

      if (duration > 0) {
        window.setTimeout(() => dismissToast(id), duration);
      }
    },
    [dismissToast],
  );

  useEffect(() => {
    const handleExternalToast = (event: Event) => {
      const customEvent = event as CustomEvent<{ message?: string; type?: ToastType; duration?: number }>;
      const message = customEvent.detail?.message;
      if (!message) return;

      showToast(message, customEvent.detail?.type ?? 'info', customEvent.detail?.duration ?? defaultDurations[customEvent.detail?.type ?? 'info']);
    };

    window.addEventListener('app-toast', handleExternalToast as EventListener);
    return () => window.removeEventListener('app-toast', handleExternalToast as EventListener);
  }, [showToast]);

  const value = useMemo<ToastContextValue>(() => ({ toasts, showToast, dismissToast }), [toasts, showToast, dismissToast]);

  return (
    <ToastContext.Provider value={value}>
    setToasts(prev => prev.filter(t => t.id !== id));
  }, []);

  const showToast = useCallback((message: string, type: ToastType = 'info', duration = 5000) => {
    const id = Math.random().toString(36).slice(2);
    setToasts(prev => [...prev, { id, message, type, duration }]);

    if (duration > 0) {
      setTimeout(() => dismissToast(id), duration);
    }
  }, [dismissToast]);

  return (
    <ToastContext.Provider value={{ toasts, showToast, dismissToast }}>
      {children}
      <ToastContainer toasts={toasts} onDismiss={dismissToast} />
    </ToastContext.Provider>
  );
}

export function useToast() {
  const context = useContext(ToastContext);
  if (!context) throw new Error('useToast must be used within ToastProvider');
  return context;
}

function ToastContainer({ toasts, onDismiss }: { toasts: Toast[]; onDismiss: (id: string) => void }) {
  if (toasts.length === 0) return null;
  return (
    <div className="toast-container" role="alert" aria-live="polite">
      {toasts.map(toast => (
        <div key={toast.id} className={`toast toast-${toast.type}`}>
          <span>{toast.message}</span>
          <button onClick={() => onDismiss(toast.id)} aria-label="Dismiss">&times;</button>
        </div>
      ))}
    </div>
  );
}
