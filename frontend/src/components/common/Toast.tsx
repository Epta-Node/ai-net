import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { CheckCircle, XCircle, AlertTriangle, Info } from 'lucide-react';
import './Toast.css';
import type { Toast } from '../../context/ToastContext';

interface ToastContainerProps {
  toasts: Toast[]
  onDismiss: (id: string) => void
}

const icons: Record<Toast['type'], ReactNode> = {
  success: <CheckCircle size={18} aria-hidden />,
  error: <XCircle size={18} aria-hidden />,
  warning: <AlertTriangle size={18} aria-hidden />,
  info: <Info size={18} aria-hidden />,
}

export function ToastContainer({ toasts, onDismiss }: ToastContainerProps) {
  const { t } = useTranslation();

  return (
    <div className="toast-container" role="status" aria-live="polite">
      {toasts.map((toast) => (
        <div key={toast.id} className={`toast toast--${toast.type}`}>
          <span className="toast__content">
            <span className={`toast__icon toast__icon--${toast.type}`} data-testid={`toast-icon-${toast.type}`}>
              {icons[toast.type]}
            </span>
            <span className="toast__message">{toast.message}</span>
          </span>
          <button type="button" className="toast__dismiss" onClick={() => onDismiss(toast.id)} aria-label={t('a11y.dismissNotification')}>
            ×
          </button>
        </div>
      ))}
    </div>
  )
}
