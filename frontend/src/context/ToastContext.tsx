import { createContext, useContext, ReactNode, useEffect } from 'react';
import { useToastManager } from '../hooks/useToast';
import { ToastContainer } from '../components/common/Toast';

export type ToastType = 'success' | 'error' | 'warning' | 'info';

export interface ToastAction {
  label: string;
  onClick: () => void;
}

export interface Toast {
  id: string;
  message: string;
  type: ToastType;
  duration?: number;
  action?: ToastAction;
}

interface ToastContextValue {
  toasts: Toast[];
  showToast: (message: string, type?: ToastType, action?: ToastAction, duration?: number) => void;
  dismissToast: (id: string) => void;
}

export const ToastContext = createContext<ToastContextValue | null>(null);

export function ToastProvider({ children }: { children: ReactNode }) {
  const { activeToasts, showToast, dismissToast } = useToastManager();

  useEffect(() => {
    const handleGlobalToast = (e: Event) => {
      const customEvent = e as CustomEvent;
      const { message, type, action, duration } = customEvent.detail;
      showToast(message, type, action, duration);
    };
    window.addEventListener('global_toast', handleGlobalToast);
    return () => window.removeEventListener('global_toast', handleGlobalToast);
  }, [showToast]);

  return (
    <ToastContext.Provider value={{ toasts: activeToasts, showToast, dismissToast }}>
      {children}
      <ToastContainer toasts={activeToasts} onDismiss={dismissToast} />
    </ToastContext.Provider>
  );
}

export function useToast() {
  const context = useContext(ToastContext);
  if (!context) throw new Error('useToast must be used within ToastProvider');
  return context;
}