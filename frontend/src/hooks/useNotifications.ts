import { useContext } from 'react';
import { NotificationContext } from '../context/NotificationContext';
import type { NotificationContextValue } from '../types/notification';

export const useNotifications = (): NotificationContextValue => {
  const context = useContext(NotificationContext);
  if (!context) {
    throw new Error('useNotifications must be used inside <NotificationProvider>');
  }
  return context;
};

export default useNotifications;
