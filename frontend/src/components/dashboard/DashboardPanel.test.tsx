import { MemoryRouter } from 'react-router-dom';
import type React from 'react';
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { DashboardPanel } from './DashboardPanel';
import dashboardPanelCss from './DashboardPanel.module.css?raw';
import dashboardCss from '../../pages/dashboard.module.css?raw';

const renderPanel = (props: Partial<React.ComponentProps<typeof DashboardPanel>> = {}) =>
  render(
    <MemoryRouter>
      <DashboardPanel
        loading={false}
        emptyTitle="No dashboard data"
        emptyDescription="Data will appear here."
        {...props}
      >
        <div>Panel content</div>
      </DashboardPanel>
    </MemoryRouter>
  );

describe('DashboardPanel', () => {
  it('renders a retryable normalized error state', () => {
    const onRetry = vi.fn();
    renderPanel({ error: new Error('Request failed'), onRetry });
    expect(screen.getByRole('alert')).toHaveTextContent('Request failed');
    screen.getByRole('button', { name: /retry/i }).click();
    expect(onRetry).toHaveBeenCalledOnce();
  });

  it('renders an explanatory empty state', () => {
    renderPanel({ empty: true });
    expect(screen.getByText('No dashboard data')).toBeInTheDocument();
    expect(screen.getByText('Data will appear here.')).toBeInTheDocument();
  });

  it('renders a bounded dashboard panel at 768px', () => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 768 });
    renderPanel();

    const panel = screen.getByTestId('dashboard-panel');
    expect(panel).toBeInTheDocument();
    expect(dashboardPanelCss).toContain('overflow-x: hidden');
    expect(dashboardCss).toContain('@media (max-width: 768px)');
    expect(dashboardCss).toContain('grid-template-columns: repeat(2, minmax(0, 1fr))');
  });
});
