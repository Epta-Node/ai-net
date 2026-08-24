import React, { useEffect, useRef } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { CheckCheck, Inbox } from 'lucide-react';
import { useNotifications } from '../../hooks/useNotifications';
import NotificationItem from './NotificationItem';
import './NotificationCenter.css';

interface NotificationCenterProps {
  isOpen: boolean;
  onClose: () => void;
  anchorRef?: React.RefObject<HTMLElement>;
}

export const NotificationCenter: React.FC<NotificationCenterProps> = ({
  isOpen,
  onClose,
  anchorRef,
}) => {
  const { notifications, unreadCount, markAsRead, markAllAsRead } = useNotifications();
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!isOpen) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
      }
    };

    const handleClickOutside = (e: MouseEvent) => {
      const target = e.target as Node;
      if (panelRef.current && !panelRef.current.contains(target)) {
        // If anchorRef (e.g. bell button) is passed and was clicked, ignore outside click
        if (anchorRef?.current && anchorRef.current.contains(target)) {
          return;
        }
        onClose();
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    document.addEventListener('mousedown', handleClickOutside);

    return () => {
      document.removeEventListener('keydown', handleKeyDown);
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, [isOpen, onClose, anchorRef]);

  return (
    <AnimatePresence>
      {isOpen && (
        <motion.div
          ref={panelRef}
          className="notification-panel"
          initial={{ opacity: 0, y: 10, scale: 0.98 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={{ opacity: 0, y: 8, scale: 0.98 }}
          transition={{ duration: 0.15 }}
          role="dialog"
          aria-label="Notification Center"
          data-testid="notification-panel"
        >
          {/* Header */}
          <div className="notification-panel-header">
            <div className="notification-panel-title-group">
              <span className="notification-panel-title">Notifications</span>
              {unreadCount > 0 && (
                <span className="notification-unread-count-pill" data-testid="panel-unread-badge">
                  {unreadCount} new
                </span>
              )}
            </div>

            {unreadCount > 0 && (
              <button
                type="button"
                className="mark-all-read-btn"
                onClick={markAllAsRead}
                aria-label="Mark all as read"
                data-testid="mark-all-read-btn"
              >
                <CheckCheck size={14} />
                <span>Mark all as read</span>
              </button>
            )}
          </div>

          {/* Body */}
          <div className="notification-panel-body">
            {notifications.length === 0 ? (
              <div className="notification-empty-state" data-testid="notification-empty-state">
                <div className="empty-state-icon-wrapper">
                  <Inbox size={28} className="empty-state-icon" />
                </div>
                <p className="empty-state-title">No notifications yet</p>
                <p className="empty-state-subtitle">We'll alert you when tasks update or payments settle.</p>
              </div>
            ) : (
              <div className="notification-list" role="feed" aria-label="Notifications list">
                <AnimatePresence initial={false}>
                  {notifications.map(notification => (
                    <NotificationItem
                      key={notification.id}
                      notification={notification}
                      onMarkAsRead={markAsRead}
                      onClose={onClose}
                    />
                  ))}
                </AnimatePresence>
              </div>
            )}
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
};

export default NotificationCenter;
