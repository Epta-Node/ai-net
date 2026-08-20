import { useEffect, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Toast as ToastType } from '../../context/ToastContext';
import { CheckCircle, AlertCircle, AlertTriangle, Info, X } from 'lucide-react';
import './Toast.css';

const icons = {
  success: <CheckCircle className="toast-icon" size={20} />,
  error: <AlertCircle className="toast-icon" size={20} />,
  warning: <AlertTriangle className="toast-icon" size={20} />,
  info: <Info className="toast-icon" size={20} />,
};

export function ToastItem({ toast, onDismiss }: { toast: ToastType; onDismiss: (id: string) => void }) {
  const [isHovered, setIsHovered] = useState(false);

  useEffect(() => {
    if (toast.duration && toast.duration > 0 && !isHovered) {
      const timer = setTimeout(() => {
        onDismiss(toast.id);
      }, toast.duration);
      return () => clearTimeout(timer);
    }
  }, [toast, isHovered, onDismiss]);

  return (
    <motion.div
      layout
      initial={{ opacity: 0, y: 20, scale: 0.95 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, scale: 0.95, transition: { duration: 0.2 } }}
      transition={{ type: 'spring', stiffness: 350, damping: 30 }}
      drag="x"
      dragConstraints={{ left: 0, right: 0 }}
      dragElastic={{ left: 0, right: 1 }}
      onDragEnd={(e, { offset, velocity }) => {
        if (offset.x > 100 || velocity.x > 500) {
          onDismiss(toast.id);
        }
      }}
      className={`toast toast-${toast.type}`}
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
    >
      <div className="toast-content-wrapper">
        <div className="toast-icon-wrapper">
          {icons[toast.type]}
        </div>
        <div className="toast-message-container">
          <span className="toast-message">{toast.message}</span>
          {toast.action && (
            <button
              className="toast-action-btn"
              onClick={() => {
                toast.action?.onClick();
                onDismiss(toast.id);
              }}
            >
              {toast.action.label}
            </button>
          )}
        </div>
      </div>
      <button className="toast-close-btn" onClick={() => onDismiss(toast.id)} aria-label="Dismiss">
        <X size={16} />
      </button>
    </motion.div>
  );
}

export function ToastContainer({ toasts, onDismiss }: { toasts: ToastType[]; onDismiss: (id: string) => void }) {
  return (
    <div className="toast-container" role="alert" aria-live="polite">
      <AnimatePresence mode="popLayout">
        {toasts.map((toast) => (
          <ToastItem key={toast.id} toast={toast} onDismiss={onDismiss} />
        ))}
      </AnimatePresence>
    </div>
  );
}
