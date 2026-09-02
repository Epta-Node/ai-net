import React, { useState, useRef } from 'react';
import { Bell } from 'lucide-react';
import { useNotifications } from '../../hooks/useNotifications';
import NotificationPanel from './NotificationPanel';
import './NotificationCenter.css';

interface NotificationBellProps {
  className?: string;
}

export const NotificationBell: React.FC<NotificationBellProps> = ({ className = '' }) => {
  const { unreadCount } = useNotifications();
  const [isOpen, setIsOpen] = useState(false);
  const bellButtonRef = useRef<HTMLButtonElement>(null);

  return (
    <div className={`notification-wrapper ${className}`}>
      <button
        ref={bellButtonRef}
        type="button"
        className={`notification-bell-btn ${isOpen ? 'active' : ''}`}
        onClick={() => setIsOpen(prev => !prev)}
        aria-label="Notifications"
        aria-expanded={isOpen}
        id="btn-notifications"
        data-testid="notification-bell-btn"
      >
        <Bell size={20} />
        {unreadCount > 0 && (
          <span className="notification-badge" data-testid="notification-badge">
            {unreadCount > 99 ? '99+' : unreadCount}
          </span>
        )}
      </button>

      <NotificationPanel
        isOpen={isOpen}
        onClose={() => setIsOpen(false)}
        anchorRef={bellButtonRef}
      />
    </div>
  );
};

export default NotificationBell;
