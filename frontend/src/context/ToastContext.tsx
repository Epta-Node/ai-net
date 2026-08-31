import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { ToastContainer } from '../components/common/Toast';

export type ToastType = 'success' | 'error' | 'warning' | 'info';

export interface Toast {
  id: string;
  message: string;
  type: ToastType;
  duration: number;
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

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);

  const dismissToast = useCallback((id: string) => {
    setToasts((prev) => prev.filter((toast) => toast.id !== id));
  }, []);

  const showToast = useCallback(
    (message: string, type: ToastType = 'info', duration = defaultDurations[type]) => {
      const id =
        typeof crypto !== 'undefined' && 'randomUUID' in crypto
          ? crypto.randomUUID()
          : Math.random().toString(36).slice(2);

      setToasts((prev) => [...prev, { id, message, type, duration }]);

      if (duration > 0) {
        window.setTimeout(() => dismissToast(id), duration);
      }
    },
    [dismissToast],
  );

  useEffect(() => {
    const handleExternalToast = (event: Event) => {
      const customEvent = event as CustomEvent<{
        message?: string;
        type?: ToastType;
        duration?: number;
      }>;
      const message = customEvent.detail?.message;
      if (!message) return;

      const type = customEvent.detail?.type ?? 'info';
      showToast(message, type, customEvent.detail?.duration ?? defaultDurations[type]);
    };

    window.addEventListener('app-toast', handleExternalToast as EventListener);
    return () => window.removeEventListener('app-toast', handleExternalToast as EventListener);
  }, [showToast]);

  const value = useMemo<ToastContextValue>(
    () => ({ toasts, showToast, dismissToast }),
    [toasts, showToast, dismissToast],
  );

  return (
    <ToastContext.Provider value={value}>
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
