import React from 'react';
import { useNavigate } from 'react-router-dom';
import { motion } from 'framer-motion';
import { CheckCircle2, Coins, Bot, Bell, ChevronRight } from 'lucide-react';
import type { AppNotification, NotificationType } from '../../types/notification';
import { formatRelativeTime } from '../../utils/time';

interface NotificationItemProps {
  notification: AppNotification;
  onMarkAsRead: (id: string) => void;
  onClose?: () => void;
}

const getNotificationIcon = (type: NotificationType) => {
  switch (type) {
    case 'task':
      return <CheckCircle2 className="notification-icon-task" size={18} />;
    case 'payment':
      return <Coins className="notification-icon-payment" size={18} />;
    case 'agent':
      return <Bot className="notification-icon-agent" size={18} />;
    case 'system':
    default:
      return <Bell className="notification-icon-system" size={18} />;
  }
};

export const NotificationItem: React.FC<NotificationItemProps> = ({
  notification,
  onMarkAsRead,
  onClose,
}) => {
  const navigate = useNavigate();

  const handleClick = () => {
    if (!notification.read) {
      onMarkAsRead(notification.id);
    }
    if (notification.link) {
      navigate(notification.link);
      onClose?.();
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      handleClick();
    }
  };

  return (
    <motion.div
      layout
      initial={{ opacity: 0, y: -8 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, height: 0, marginBottom: 0 }}
      transition={{ duration: 0.2 }}
      className={`notification-item ${notification.read ? 'read' : 'unread'}`}
      onClick={handleClick}
      onKeyDown={handleKeyDown}
      tabIndex={0}
      role="button"
      aria-label={`${notification.title}: ${notification.description}`}
      data-testid={`notification-item-${notification.id}`}
    >
      <div className={`notification-icon-wrapper ${notification.type}`}>
        {getNotificationIcon(notification.type)}
      </div>

      <div className="notification-content">
        <div className="notification-header-row">
          <span className="notification-title">{notification.title}</span>
          <span className="notification-time">
            {formatRelativeTime(notification.timestamp)}
          </span>
        </div>

        <p className="notification-description">{notification.description}</p>

        {notification.link && (
          <div className="notification-link-hint">
            <span>View details</span>
            <ChevronRight size={12} />
          </div>
        )}
      </div>

      {!notification.read && (
        <span className="notification-unread-dot" title="Unread" />
      )}
    </motion.div>
  );
};

export default NotificationItem;
