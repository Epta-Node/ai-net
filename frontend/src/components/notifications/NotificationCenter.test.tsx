import React from 'react';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import { NotificationProvider, NOTIFICATIONS_STORAGE_KEY } from '../../context/NotificationContext';
import TopNav from '../layout/TopNav';
import { WalletProvider } from '../../context/WalletContext';
import type { AppNotification } from '../../types/notification';

// Mock framer-motion to simplify DOM testing in jsdom
vi.mock('framer-motion', async () => {
  const actual = await vi.importActual<typeof import('framer-motion')>('framer-motion');
  return {
    ...actual,
    AnimatePresence: ({ children }: { children: React.ReactNode }) => <>{children}</>,
    motion: {
      div: React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
        ({ children, ...props }, ref) => <div ref={ref} {...props}>{children}</div>
      ),
      li: React.forwardRef<HTMLLIElement, React.LiHTMLAttributes<HTMLLIElement>>(
        ({ children, ...props }, ref) => <li ref={ref} {...props}>{children}</li>
      ),
    },
  };
});

const mockNavigate = vi.fn();
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>('react-router-dom');
  return {
    ...actual,
    useNavigate: () => mockNavigate,
  };
});

const sampleNotifications: AppNotification[] = [
  {
    id: 'notif-1',
    type: 'task',
    title: 'Task Completed',
    description: 'Task #101 execution has completed.',
    timestamp: new Date(Date.now() - 60000).toISOString(), // 1 min ago
    read: false,
    link: '/tasks/101',
  },
  {
    id: 'notif-2',
    type: 'payment',
    title: 'Payment Released',
    description: 'Payment of 5 XLM released.',
    timestamp: new Date(Date.now() - 3600000).toISOString(), // 1 hour ago
    read: false,
    link: '/wallet',
  },
  {
    id: 'notif-3',
    type: 'agent',
    title: 'Agent Status Changed',
    description: 'Research agent is now online.',
    timestamp: new Date(Date.now() - 86400000).toISOString(), // 1 day ago
    read: true,
    link: '/agents',
  },
];

const renderTopNavWithProvider = (initialNotifications?: AppNotification[]) => {
  if (initialNotifications) {
    localStorage.setItem(NOTIFICATIONS_STORAGE_KEY, JSON.stringify(initialNotifications));
  } else {
    localStorage.removeItem(NOTIFICATIONS_STORAGE_KEY);
  }

  return render(
    <MemoryRouter>
      <WalletProvider>
        <NotificationProvider>
          <TopNav
            onMenuClick={vi.fn()}
            onToggleSidebar={vi.fn()}
            sidebarCollapsed={false}
            isMobile={false}
          />
        </NotificationProvider>
      </WalletProvider>
    </MemoryRouter>
  );
};

describe('NotificationCenter Component', () => {
  beforeEach(() => {
    localStorage.clear();
    mockNavigate.mockClear();
    vi.clearAllTimers();
  });

  afterEach(() => {
    localStorage.clear();
  });

  test('renders bell icon in TopNav with correct unread count badge', () => {
    renderTopNavWithProvider(sampleNotifications);

    const bellBtn = screen.getByTestId('notification-bell-btn');
    expect(bellBtn).toBeInTheDocument();

    // 2 unread out of 3 sample notifications
    const badge = screen.getByTestId('notification-badge');
    expect(badge).toBeInTheDocument();
    expect(badge).toHaveTextContent('2');
  });

  test('does not show unread badge when there are no unread notifications', () => {
    const allRead = sampleNotifications.map(n => ({ ...n, read: true }));
    renderTopNavWithProvider(allRead);

    expect(screen.queryByTestId('notification-badge')).not.toBeInTheDocument();
  });

  test('clicking bell opens dropdown panel and clicking again closes it', async () => {
    renderTopNavWithProvider(sampleNotifications);

    const bellBtn = screen.getByTestId('notification-bell-btn');
    expect(screen.queryByTestId('notification-panel')).not.toBeInTheDocument();

    // Open
    await act(async () => {
      fireEvent.click(bellBtn);
    });
    expect(screen.getByTestId('notification-panel')).toBeInTheDocument();

    // Close
    await act(async () => {
      fireEvent.click(bellBtn);
    });
    expect(screen.queryByTestId('notification-panel')).not.toBeInTheDocument();
  });

  test('displays empty state when there are no notifications', async () => {
    renderTopNavWithProvider([]);

    const bellBtn = screen.getByTestId('notification-bell-btn');
    await act(async () => {
      fireEvent.click(bellBtn);
    });

    expect(screen.getByTestId('notification-empty-state')).toBeInTheDocument();
    expect(screen.getByText('No notifications yet')).toBeInTheDocument();
  });

  test('renders notification items with title, description, and relative time', async () => {
    renderTopNavWithProvider(sampleNotifications);

    const bellBtn = screen.getByTestId('notification-bell-btn');
    await act(async () => {
      fireEvent.click(bellBtn);
    });

    expect(screen.getByText('Task Completed')).toBeInTheDocument();
    expect(screen.getByText('Task #101 execution has completed.')).toBeInTheDocument();
    expect(screen.getByText('Payment Released')).toBeInTheDocument();
    expect(screen.getByText('Payment of 5 XLM released.')).toBeInTheDocument();
    expect(screen.getByText('Agent Status Changed')).toBeInTheDocument();
  });

  test('clicking a notification marks it as read and navigates to the target route', async () => {
    renderTopNavWithProvider(sampleNotifications);

    const bellBtn = screen.getByTestId('notification-bell-btn');
    await act(async () => {
      fireEvent.click(bellBtn);
    });

    const notifItem = screen.getByTestId('notification-item-notif-1');
    expect(notifItem).toHaveClass('unread');

    await act(async () => {
      fireEvent.click(notifItem);
    });

    // Should navigate to /tasks/101
    expect(mockNavigate).toHaveBeenCalledWith('/tasks/101');

    // Unread count should now decrease to 1
    const badge = screen.getByTestId('notification-badge');
    expect(badge).toHaveTextContent('1');
  });

  test('"Mark all as read" button marks all notifications as read and updates badge', async () => {
    renderTopNavWithProvider(sampleNotifications);

    const bellBtn = screen.getByTestId('notification-bell-btn');
    await act(async () => {
      fireEvent.click(bellBtn);
    });

    const markAllBtn = screen.getByTestId('mark-all-read-btn');
    expect(markAllBtn).toBeInTheDocument();

    await act(async () => {
      fireEvent.click(markAllBtn);
    });

    // Unread badge should disappear
    expect(screen.queryByTestId('notification-badge')).not.toBeInTheDocument();
    expect(screen.queryByTestId('mark-all-read-btn')).not.toBeInTheDocument();

    // Verify localStorage has all read
    const stored = JSON.parse(localStorage.getItem(NOTIFICATIONS_STORAGE_KEY) || '[]');
    expect(stored.every((n: AppNotification) => n.read)).toBe(true);
  });

  test('closes panel when pressing Escape key', async () => {
    renderTopNavWithProvider(sampleNotifications);

    const bellBtn = screen.getByTestId('notification-bell-btn');
    await act(async () => {
      fireEvent.click(bellBtn);
    });
    expect(screen.getByTestId('notification-panel')).toBeInTheDocument();

    await act(async () => {
      fireEvent.keyDown(document, { key: 'Escape' });
    });
    expect(screen.queryByTestId('notification-panel')).not.toBeInTheDocument();
  });

  test('closes panel when clicking outside', async () => {
    renderTopNavWithProvider(sampleNotifications);

    const bellBtn = screen.getByTestId('notification-bell-btn');
    await act(async () => {
      fireEvent.click(bellBtn);
    });
    expect(screen.getByTestId('notification-panel')).toBeInTheDocument();

    await act(async () => {
      fireEvent.mouseDown(document.body);
    });
    expect(screen.queryByTestId('notification-panel')).not.toBeInTheDocument();
  });

  test('persists notifications and read/unread state in localStorage', async () => {
    renderTopNavWithProvider(sampleNotifications);

    const bellBtn = screen.getByTestId('notification-bell-btn');
    await act(async () => {
      fireEvent.click(bellBtn);
    });

    // Mark notif-2 as read
    const notif2 = screen.getByTestId('notification-item-notif-2');
    await act(async () => {
      fireEvent.click(notif2);
    });

    const stored = JSON.parse(localStorage.getItem(NOTIFICATIONS_STORAGE_KEY) || '[]');
    const found2 = stored.find((n: AppNotification) => n.id === 'notif-2');
    expect(found2.read).toBe(true);
  });

  test('real-time events add new notifications to the top of the list', async () => {
    renderTopNavWithProvider([]);

    // Trigger a simulated real-time event via window custom event
    await act(async () => {
      window.dispatchEvent(
        new CustomEvent('ai-net-notification', {
          detail: {
            type: 'task_completed',
            taskId: 'task-live-999',
            payload: {},
            timestamp: new Date().toISOString(),
          },
        })
      );
    });

    // Badge should show 1 unread
    const badge = screen.getByTestId('notification-badge');
    expect(badge).toHaveTextContent('1');

    // Open panel
    const bellBtn = screen.getByTestId('notification-bell-btn');
    await act(async () => {
      fireEvent.click(bellBtn);
    });

    expect(screen.getByText('Task Completed')).toBeInTheDocument();
    expect(screen.getByText('Task task-live-999 completed successfully.')).toBeInTheDocument();
  });
});
