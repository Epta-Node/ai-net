import { useState, useCallback } from 'react';
import { Toast, ToastType, ToastAction } from '../context/ToastContext';

export function useToastManager() {
  const [activeToasts, setActiveToasts] = useState<Toast[]>([]);
  const [queue, setQueue] = useState<Toast[]>([]);
  const MAX_VISIBLE = 3;

  const dismissToast = useCallback((id: string) => {
    setActiveToasts((prev) => prev.filter((t) => t.id !== id));
    // When a toast is dismissed, we check if there are queued toasts
    setQueue((prevQueue) => {
      if (prevQueue.length > 0) {
        const [nextToast, ...rest] = prevQueue;
        setActiveToasts((prevActive) => {
          if (prevActive.length < MAX_VISIBLE && !prevActive.some(t => t.id === nextToast.id)) {
            return [...prevActive, nextToast];
          }
          return prevActive;
        });
        return rest;
      }
      return prevQueue;
    });
  }, []);

  const showToast = useCallback(
    (message: string, type: ToastType = 'info', action?: ToastAction, duration?: number) => {
      const id = Math.random().toString(36).slice(2);
      
      let defaultDuration = 5000; // success
      if (type === 'info') defaultDuration = 8000;
      if (type === 'warning') defaultDuration = 5000;
      if (type === 'error') defaultDuration = 0; // no auto-dismiss
      
      const toastDuration = duration !== undefined ? duration : defaultDuration;

      const newToast: Toast = { id, message, type, duration: toastDuration, action };

      setActiveToasts((prevActive) => {
        if (prevActive.length >= MAX_VISIBLE) {
          // Dismiss the oldest active toast to make room
          const oldestToast = prevActive[0];
          setTimeout(() => dismissToast(oldestToast.id), 0);
          
          setQueue((prevQueue) => [...prevQueue, newToast]);
          return prevActive;
        }
        return [...prevActive, newToast];
      });
    },
    [dismissToast]
  );

  return {
    activeToasts,
    showToast,
    dismissToast,
  };
}
