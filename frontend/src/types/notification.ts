export type NotificationType = 'task' | 'payment' | 'agent' | 'system';

export interface AppNotification {
  id: string;
  type: NotificationType;
  title: string;
  description: string;
  timestamp: string; // ISO-8601 string or epoch string
  read: boolean;
  link?: string;
  metadata?: Record<string, unknown>;
}

export type NewNotificationInput = Omit<AppNotification, 'id' | 'timestamp' | 'read'> & 
  Partial<Pick<AppNotification, 'id' | 'timestamp' | 'read'>>;

export interface NotificationContextValue {
  notifications: AppNotification[];
  unreadCount: number;
  markAsRead: (id: string) => void;
  markAllAsRead: () => void;
  addNotification: (notification: NewNotificationInput) => void;
  removeNotification: (id: string) => void;
  clearNotifications: () => void;
  isConnected: boolean;
}
