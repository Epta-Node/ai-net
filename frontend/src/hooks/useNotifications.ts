import { useContext } from 'react';
import { NotificationContext } from '../context/NotificationContext';
import type { NotificationContextValue } from '../types/notification';

const fallbackValue: NotificationContextValue = {
  notifications: [],
  unreadCount: 0,
  markAsRead: () => {},
  markAllAsRead: () => {},
  clearAll: () => {},
  clearNotifications: () => {},
  addNotification: () => {},
  removeNotification: () => {},
  isConnected: false,
};

export const useNotifications = (): NotificationContextValue => {
  const context = useContext(NotificationContext);
  if (!context) {
    return fallbackValue;
  }
  return context;
};

export default useNotifications;
