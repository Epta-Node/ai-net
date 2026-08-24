import { createContext, useContext, useState, useEffect, useCallback, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

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

function ToastContainer({ toasts, onDismiss }: { toasts: Toast[]; onDismiss: (id: string) => void }) {
  const { t } = useTranslation();

  if (toasts.length === 0) return null;
  return (
    <div className="toast-container" role="alert" aria-live="polite">
      {toasts.map(toast => (
        <div key={toast.id} className={`toast toast-${toast.type}`}>
          <span>{toast.message}</span>
          <button onClick={() => onDismiss(toast.id)} aria-label={t('a11y.dismiss')}>&times;</button>
        </div>
      ))}
    </div>
  );
}

function useToastManager() {
  const [activeToasts, setActiveToasts] = useState<Toast[]>([]);
  const dismissToast = useCallback((id: string) => {
    setActiveToasts(prev => prev.filter(toast => toast.id !== id));
  }, []);
  const showToast = useCallback((message: string, type: ToastType = 'info', action?: ToastAction, duration: number = 3000) => {
    const id = Date.now().toString();
    const newToast: Toast = { id, message, type, action, duration };
    setActiveToasts(prev => {
      if (prev.length >= 3) {
        return [...prev.slice(1), newToast];
      }
      return [...prev, newToast];
    });
    if (duration > 0) {
      setTimeout(() => dismissToast(id), duration);
    }
  }, [dismissToast]);
  return { activeToasts, showToast, dismissToast };
}