import { useContext } from 'react';
import { ToastContext, type ToastContextValue } from '../context/ToastContext';

export function useToast(): ToastContextValue {
  const context = useContext(ToastContext);

  if (!context) {
    // Fallback for tests / isolated renders without provider — no-op to keep
    // validation flows working. Real app always mounts inside ToastProvider.
    return {
      toasts: [],
      showToast: () => '',
      dismissToast: () => {},
    };
  }

  return context;
}
