import React, { useEffect, useRef, useState, useMemo } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { CheckCheck, Inbox, Filter } from 'lucide-react';
import { useNotifications } from '../../hooks/useNotifications';
import NotificationItem from './NotificationItem';
import { EmptyState } from '../common/EmptyState';
import './NotificationCenter.css';

interface NotificationCenterProps {
  isOpen: boolean;
  onClose: () => void;
  anchorRef?: React.RefObject<HTMLElement>;
}

type NotificationFilter = 'all' | 'task' | 'payment' | 'agent' | 'system';

export const NotificationCenter: React.FC<NotificationCenterProps> = ({
  isOpen,
  onClose,
  anchorRef,
}) => {
  const { notifications, unreadCount, markAsRead, markAllAsRead } = useNotifications();
  const panelRef = useRef<HTMLDivElement>(null);
  const [filter, setFilter] = useState<NotificationFilter>('all');
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set(['unread']));

  const filteredNotifications = useMemo(() => {
    return filter === 'all'
      ? notifications
      : notifications.filter(n => n.type === filter);
  }, [notifications, filter]);

  const groupedNotifications = useMemo(() => {
    const groups: Record<string, typeof notifications> = {
      unread: [],
      read: [],
    };

    filteredNotifications.forEach(notif => {
      if (notif.read) {
        groups.read.push(notif);
      } else {
        groups.unread.push(notif);
      }
    });

    return groups;
  }, [filteredNotifications]);

  const toggleGroup = (groupKey: string) => {
    setExpandedGroups(prev => {
      const next = new Set(prev);
      if (next.has(groupKey)) {
        next.delete(groupKey);
      } else {
        next.add(groupKey);
      }
      return next;
    });
  };

  const markGroupAsRead = (groupKey: string) => {
    const group = groupedNotifications[groupKey as keyof typeof groupedNotifications];
    group?.forEach(notif => {
      if (!notif.read) {
        markAsRead(notif.id);
      }
    });
  };

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
              <span className="notification-panel-title">Inbox</span>
              {unreadCount > 0 && (
                <span className="notification-unread-count-pill" data-testid="panel-unread-badge">
                  {unreadCount}
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
              </button>
            )}
          </div>

          {/* Filters */}
          <div className="notification-panel-filters">
            {(['all', 'task', 'payment', 'agent', 'system'] as NotificationFilter[]).map(f => (
              <button
                key={f}
                type="button"
                className={`filter-btn ${filter === f ? 'active' : ''}`}
                onClick={() => setFilter(f)}
                aria-pressed={filter === f}
              >
                {f === 'all' ? 'All' : f.charAt(0).toUpperCase() + f.slice(1)}
              </button>
            ))}
          </div>

          {/* Body */}
          <div className="notification-panel-body">
            {filteredNotifications.length === 0 ? (
              <div className="notification-empty-state" data-testid="notification-empty-state">
                <div className="empty-state-icon-wrapper">
                  <Inbox size={28} className="empty-state-icon" />
                </div>
                <p className="empty-state-title">No notifications</p>
                <p className="empty-state-subtitle">Stay tuned for updates on your tasks and payments.</p>
              </div>
            ) : (
              <div className="notification-groups" role="feed">
                {Object.entries(groupedNotifications).map(([groupKey, group]) => (
                  group.length > 0 && (
                    <div key={groupKey} className="notification-group">
                      <button
                        type="button"
                        className="group-header"
                        onClick={() => toggleGroup(groupKey)}
                        aria-expanded={expandedGroups.has(groupKey)}
                      >
                        <span className="group-title">
                          {groupKey === 'unread' ? 'Unread' : 'Read'}
                          <span className="group-count">({group.length})</span>
                        </span>
                        {group.some(n => !n.read) && groupKey === 'unread' && (
                          <button
                            type="button"
                            className="group-mark-read"
                            onClick={(e) => {
                              e.stopPropagation();
                              markGroupAsRead(groupKey);
                            }}
                            aria-label="Mark group as read"
                          >
                            <CheckCheck size={14} />
                          </button>
                        )}
                      </button>
                      <AnimatePresence>
                        {expandedGroups.has(groupKey) && (
                          <motion.div
                            initial={{ opacity: 0, height: 0 }}
                            animate={{ opacity: 1, height: 'auto' }}
                            exit={{ opacity: 0, height: 0 }}
                            className="group-items"
                          >
                            {group.map(notification => (
                              <NotificationItem
                                key={notification.id}
                                notification={notification}
                                onMarkAsRead={markAsRead}
                                onClose={onClose}
                              />
                            ))}
                          </motion.div>
                        )}
                      </AnimatePresence>
                    </div>
                  )
                ))}
              </div>
            )}
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
};

export default NotificationCenter;
