import { useTranslation } from 'react-i18next';
import './Toast.css';
import type { Toast } from '../../context/ToastContext';

interface ToastContainerProps {
  toasts: Toast[];
  onDismiss: (id: string) => void;
}

export function ToastContainer({ toasts, onDismiss }: ToastContainerProps) {
  const { t } = useTranslation();

  return (
    <div className="toast-container" aria-live="polite" aria-atomic="true">
      {toasts.map((toast) => (
        <div key={toast.id} className={`toast toast--${toast.type}`} role="alert" aria-live="polite">
          <span className="toast__message">{toast.message}</span>
          <button type="button" className="toast__dismiss" onClick={() => onDismiss(toast.id)} aria-label={t('a11y.dismissNotification')}>
            ×
          </button>
        </div>
      ))}
    </div>
  );
}
