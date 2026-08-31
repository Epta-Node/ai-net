import { useContext } from 'react';
import { ToastContext } from '../context/ToastContext';

export function useToast() {
  const context = useContext(ToastContext);

  if (!context) {
    // Fallback for tests / isolated renders without provider — no-op to keep
    // validation flows working. Real app always mounts inside ToastProvider.
    return {
      toasts: [],
      showToast: () => '',
      dismissToast: () => {},
    } as unknown as ReturnType<typeof useContext<typeof ToastContext>> extends infer T ? T : never
  }

  return context;
}
