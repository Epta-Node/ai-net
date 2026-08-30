import { AnimatePresence, motion } from 'framer-motion'
import { CheckCircle, AlertTriangle, XCircle, Info, X } from 'lucide-react'
import type { Toast } from '../../context/ToastContext'
import './Toast.css'

interface ToastContainerProps {
  toasts: Toast[]
  onDismiss: (id: string) => void
}

const icons: Record<Toast['type'], React.ReactNode> = {
  success: <CheckCircle size={18} aria-hidden />,
  error: <XCircle size={18} aria-hidden />,
  warning: <AlertTriangle size={18} aria-hidden />,
  info: <Info size={18} aria-hidden />,
}

export function ToastContainer({ toasts, onDismiss }: ToastContainerProps) {
  if (toasts.length === 0) return null

  return (
    <div className="toast-container" aria-live="polite" aria-atomic="true" data-testid="toast-container">
      <AnimatePresence initial={false}>
        {toasts.map((toast) => (
          <motion.div
            key={toast.id}
            layout
            initial={{ opacity: 0, y: -12, scale: 0.96, x: 20 }}
            animate={{ opacity: 1, y: 0, scale: 1, x: 0 }}
            exit={{ opacity: 0, y: -8, scale: 0.96, x: 20, transition: { duration: 0.18 } }}
            transition={{ type: 'spring', stiffness: 420, damping: 30, mass: 0.8 }}
            className={`toast toast--${toast.type}`}
            role="alert"
            aria-live="polite"
            data-testid={`toast-${toast.type}`}
          >
            <span className="toast__icon">{icons[toast.type]}</span>

            <div className="toast__content">
              <span className="toast__message">{toast.message}</span>
              {(toast.count ?? 1) > 1 && (
                <span className="toast__count" aria-label={`${toast.count} times`}>
                  ×{toast.count}
                </span>
              )}
            </div>

            <div className="toast__actions">
              {toast.action && (
                <button
                  type="button"
                  className="toast__action"
                  onClick={() => {
                    try {
                      toast.action!.onClick()
                    } finally {
                      onDismiss(toast.id)
                    }
                  }}
                  data-testid="toast-action"
                >
                  {toast.action.label}
                </button>
              )}
              <button
                type="button"
                className="toast__dismiss"
                onClick={() => onDismiss(toast.id)}
                aria-label="Dismiss"
                data-testid="toast-dismiss"
              >
                <X size={14} aria-hidden />
              </button>
            </div>

            {toast.duration > 0 && (
              <div
                className="toast__progress"
                style={{ animationDuration: `${toast.duration}ms` } as React.CSSProperties}
                aria-hidden
              />
            )}
          </motion.div>
        ))}
      </AnimatePresence>
    </div>
  )
}
