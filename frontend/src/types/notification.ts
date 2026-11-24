export type NotificationType =
  | 'task_completed'
  | 'task_failed'
  | 'payment_received'
  | 'agent_registered'
  | 'task'
  | 'payment'
  | 'agent'
  | 'system';

export interface AppNotification {
  id: string;
  type: NotificationType;
  title: string;
  message: string;
  description?: string; // backward compatibility
  timestamp: string; // ISO-8601 string
  read: boolean;
  link?: string;
  metadata?: Record<string, unknown>;
}

export type NewNotificationInput = {
  id?: string;
  type: NotificationType;
  title: string;
  message?: string;
  description?: string;
  timestamp?: string;
  read?: boolean;
  link?: string;
  metadata?: Record<string, unknown>;
};

export interface NotificationContextValue {
  notifications: AppNotification[];
  unreadCount: number;
  markAsRead: (id: string) => void;
  markAllAsRead: () => void;
  clearAll: () => void;
  clearNotifications: () => void; // alias for backward compatibility
  addNotification: (notification: NewNotificationInput) => void;
  removeNotification: (id: string) => void;
  isConnected: boolean;
}
