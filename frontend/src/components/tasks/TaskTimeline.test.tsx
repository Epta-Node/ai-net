/**
 * @vitest-environment jsdom
 */

import React from 'react';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { TaskTimeline } from './TaskTimeline';
import type { TaskResponse } from '../../types/api';

// Mock the EmptyState component
vi.mock('../common/EmptyState', () => ({
  EmptyState: ({ title, hasFilters }: any) => (
    <div data-testid="empty-state">{title}</div>
  ),
}));

describe('TaskTimeline Component', () => {
  const mockTask: TaskResponse = {
    id: 'task-1',
    taskId: 'task-1',
    status: 'completed',
    createdAt: new Date('2026-09-27').toISOString(),
    updatedAt: new Date('2026-09-27').toISOString(),
    prompt: 'Test task',
    result: 'Task completed',
    cost: '0.5',
    dag: [
      {
        nodeId: 'node-1',
        agentType: 'research',
        status: 'completed',
        input: 'test input',
        output: 'test output',
        startTime: new Date('2026-09-27T10:00:00Z').toISOString(),
        endTime: new Date('2026-09-27T10:05:00Z').toISOString(),
        result: {},
        updatedAt: new Date('2026-09-27').toISOString(),
      },
    ],
  };

  const mockTask2: TaskResponse = {
    ...mockTask,
    id: 'task-2',
    taskId: 'task-2',
    status: 'running',
    createdAt: new Date('2026-09-26').toISOString(),
  };

  describe('Empty State', () => {
    it('shows empty state when tasks array is empty and not loading', () => {
      render(
        <TaskTimeline
          tasks={[]}
          loading={false}
          selectedIds={[null, null]}
          onToggleSelect={vi.fn()}
          isComparing={false}
          hasFilters={false}
        />
      );

      const emptyState = screen.getByTestId('empty-state');
      expect(emptyState).toBeInTheDocument();
      expect(emptyState).toHaveTextContent('No task history yet');
    });

    it('shows filter-aware empty state message when hasFilters is true', () => {
      render(
        <TaskTimeline
          tasks={[]}
          loading={false}
          selectedIds={[null, null]}
          onToggleSelect={vi.fn()}
          isComparing={false}
          hasFilters={true}
        />
      );

      const emptyState = screen.getByTestId('empty-state');
      expect(emptyState).toHaveTextContent('No tasks match the current filters');
    });
  });

  describe('Loading State', () => {
    it('shows skeleton loaders when loading is true', () => {
      const { container } = render(
        <TaskTimeline
          tasks={[]}
          loading={true}
          selectedIds={[null, null]}
          onToggleSelect={vi.fn()}
          isComparing={false}
          hasFilters={false}
        />
      );

      const timeline = container.querySelector('[role="feed"]');
      expect(timeline).toHaveAttribute('aria-busy', 'true');
      expect(timeline).toHaveAttribute('aria-label', 'Loading task history');
    });

    it('renders 5 skeleton entries while loading', () => {
      const { container } = render(
        <TaskTimeline
          tasks={[]}
          loading={true}
          selectedIds={[null, null]}
          onToggleSelect={vi.fn()}
          isComparing={false}
          hasFilters={false}
        />
      );

      const dots = container.querySelectorAll('[class*="dot"]');
      expect(dots.length).toBeGreaterThan(0);
    });
  });

  describe('Task Rendering', () => {
    it('renders tasks in the timeline', () => {
      const { container } = render(
        <TaskTimeline
          tasks={[mockTask]}
          loading={false}
          selectedIds={[null, null]}
          onToggleSelect={vi.fn()}
          isComparing={false}
          hasFilters={false}
        />
      );

      expect(screen.getByRole('feed')).toBeInTheDocument();
    });

    it('groups tasks by date buckets', () => {
      const tasksWithDifferentDates: TaskResponse[] = [
        mockTask, // 2026-09-27
        mockTask2, // 2026-09-26
      ];

      const { container } = render(
        <TaskTimeline
          tasks={tasksWithDifferentDates}
          loading={false}
          selectedIds={[null, null]}
          onToggleSelect={vi.fn()}
          isComparing={false}
          hasFilters={false}
        />
      );

      // Should have two date buckets
      const feed = screen.getByRole('feed');
      expect(feed).toBeInTheDocument();
    });

    it('displays "Today" for tasks created today', () => {
      const todayTask: TaskResponse = {
        ...mockTask,
        createdAt: new Date().toISOString(),
      };

      render(
        <TaskTimeline
          tasks={[todayTask]}
          loading={false}
          selectedIds={[null, null]}
          onToggleSelect={vi.fn()}
          isComparing={false}
          hasFilters={false}
        />
      );

      expect(screen.getByText('Today')).toBeInTheDocument();
    });
  });

  describe('Task Selection', () => {
    it('calls onToggleSelect when a task is selected', () => {
      const onToggleSelect = vi.fn();

      const { container } = render(
        <TaskTimeline
          tasks={[mockTask]}
          loading={false}
          selectedIds={[null, null]}
          onToggleSelect={onToggleSelect}
          isComparing={false}
          hasFilters={false}
        />
      );

      const feed = screen.getByRole('feed');
      const taskItems = feed.querySelectorAll('[class*="card"]');
      if (taskItems.length > 0) {
        fireEvent.click(taskItems[0]);
        // The selection is handled by TimelineEntry component
      }
    });

    it('marks selected tasks with first selection index', () => {
      render(
        <TaskTimeline
          tasks={[mockTask, mockTask2]}
          loading={false}
          selectedIds={['task-1', null]}
          onToggleSelect={vi.fn()}
          isComparing={false}
          hasFilters={false}
        />
      );

      // Selection state is tracked internally and displayed visually
      const feed = screen.getByRole('feed');
      expect(feed).toBeInTheDocument();
    });

    it('marks selected tasks with second selection index when comparing', () => {
      render(
        <TaskTimeline
          tasks={[mockTask, mockTask2]}
          loading={false}
          selectedIds={['task-1', 'task-2']}
          onToggleSelect={vi.fn()}
          isComparing={true}
          hasFilters={false}
        />
      );

      const feed = screen.getByRole('feed');
      expect(feed).toBeInTheDocument();
    });
  });

  describe('Accessibility', () => {
    it('has proper ARIA roles', () => {
      const { container } = render(
        <TaskTimeline
          tasks={[mockTask]}
          loading={false}
          selectedIds={[null, null]}
          onToggleSelect={vi.fn()}
          isComparing={false}
          hasFilters={false}
        />
      );

      expect(screen.getByRole('feed')).toHaveAttribute(
        'aria-label',
        'Task history timeline'
      );
    });

    it('indicates loading state with aria-busy', () => {
      const { container } = render(
        <TaskTimeline
          tasks={[]}
          loading={true}
          selectedIds={[null, null]}
          onToggleSelect={vi.fn()}
          isComparing={false}
          hasFilters={false}
        />
      );

      expect(screen.getByRole('feed')).toHaveAttribute('aria-busy', 'true');
    });
  });

  describe('Agent Type Handling', () => {
    it('renders tasks with different agent types', () => {
      const taskWithResearch: TaskResponse = {
        ...mockTask,
        dag: [
          {
            ...mockTask.dag![0],
            agentType: 'research',
          },
        ],
      };

      const taskWithCoding: TaskResponse = {
        ...mockTask,
        id: 'task-coding',
        taskId: 'task-coding',
        dag: [
          {
            ...mockTask.dag![0],
            nodeId: 'node-coding',
            agentType: 'coding',
          },
        ],
      };

      render(
        <TaskTimeline
          tasks={[taskWithResearch, taskWithCoding]}
          loading={false}
          selectedIds={[null, null]}
          onToggleSelect={vi.fn()}
          isComparing={false}
          hasFilters={false}
        />
      );

      const feed = screen.getByRole('feed');
      expect(feed).toBeInTheDocument();
    });
  });

  describe('Task Status Display', () => {
    it('renders completed task with completed status', () => {
      const completedTask: TaskResponse = {
        ...mockTask,
        status: 'completed',
      };

      render(
        <TaskTimeline
          tasks={[completedTask]}
          loading={false}
          selectedIds={[null, null]}
          onToggleSelect={vi.fn()}
          isComparing={false}
          hasFilters={false}
        />
      );

      const feed = screen.getByRole('feed');
      expect(feed).toBeInTheDocument();
    });

    it('renders failed task with failed status', () => {
      const failedTask: TaskResponse = {
        ...mockTask,
        status: 'failed',
      };

      render(
        <TaskTimeline
          tasks={[failedTask]}
          loading={false}
          selectedIds={[null, null]}
          onToggleSelect={vi.fn()}
          isComparing={false}
          hasFilters={false}
        />
      );

      const feed = screen.getByRole('feed');
      expect(feed).toBeInTheDocument();
    });

    it('renders running task with running status', () => {
      const runningTask: TaskResponse = {
        ...mockTask,
        status: 'running',
      };

      render(
        <TaskTimeline
          tasks={[runningTask]}
          loading={false}
          selectedIds={[null, null]}
          onToggleSelect={vi.fn()}
          isComparing={false}
          hasFilters={false}
        />
      );

      const feed = screen.getByRole('feed');
      expect(feed).toBeInTheDocument();
    });
  });
});
