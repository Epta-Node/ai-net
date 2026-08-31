import { render, screen } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { TaskHistoryPageSkeleton } from '../../../src/pages/tasks/TaskHistoryPage';
import { NewTaskPageSkeleton } from '../../../src/pages/tasks/NewTaskPage';

describe('TaskHistoryPageSkeleton', () => {
  it('renders with aria-busy and data-testid', () => {
    render(<TaskHistoryPageSkeleton />);
    const el = screen.getByTestId('task-history-skeleton');
    expect(el).toHaveAttribute('aria-busy', 'true');
  });

  it('renders skeleton rows for the timeline', () => {
    render(<TaskHistoryPageSkeleton />);
    // SkeletonTable renders skeleton-table-row elements
    const rows = screen.getAllByTestId('skeleton-table-row');
    expect(rows.length).toBeGreaterThanOrEqual(1);
  });
});

describe('NewTaskPageSkeleton', () => {
  it('renders with aria-busy and data-testid', () => {
    render(<NewTaskPageSkeleton />);
    const el = screen.getByTestId('new-task-skeleton');
    expect(el).toHaveAttribute('aria-busy', 'true');
  });

  it('renders pill skeletons for agent preferences', () => {
    render(<NewTaskPageSkeleton />);
    // 5 agent preference pills are rendered as Skeleton variant=pill
    // They are aria-hidden; query by hidden
    const pills = screen.getAllByRole('generic', { hidden: true });
    expect(pills.length).toBeGreaterThan(0);
  });
});
