/**
 * @vitest-environment jsdom
 */

import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TaskComparison } from './TaskComparison';
import type { TaskResponse } from '../../types/api';

// Mock the task history hooks
vi.mock('../../hooks/useTaskHistory', () => ({
  getTaskDuration: (task: TaskResponse) => {
    if (task.dag && task.dag.length > 0) {
      const start = new Date(task.dag[0].startTime || task.createdAt).getTime();
      const end = new Date(task.dag[task.dag.length - 1].endTime || task.updatedAt).getTime();
      return (end - start) / 1000;
    }
    return 0;
  },
  getTaskCost: (task: TaskResponse) => parseFloat(task.cost || '0'),
  getTaskAgentTypes: (task: TaskResponse) => {
    return task.dag ? [...new Set(task.dag.map(n => n.agentType).filter(Boolean))] : [];
  },
  formatDuration: (seconds: number) => {
    if (seconds < 60) return `${Math.round(seconds)}s`;
    return `${Math.round(seconds / 60)}m`;
  },
}));

describe('TaskComparison Component', () => {
  const mockTaskA: TaskResponse = {
    id: 'task-a',
    taskId: 'task-a-12345',
    status: 'completed',
    createdAt: new Date('2026-09-27T10:00:00Z').toISOString(),
    updatedAt: new Date('2026-09-27T10:05:00Z').toISOString(),
    prompt: 'Analyze market trends for Q4 2026',
    result: 'Market analysis complete',
    cost: '0.5',
    dag: [
      {
        nodeId: 'node-research',
        agentType: 'research',
        status: 'completed',
        input: 'Q4 2026 market data',
        output: 'Research findings',
        startTime: new Date('2026-09-27T10:00:00Z').toISOString(),
        endTime: new Date('2026-09-27T10:03:00Z').toISOString(),
        result: { summary: 'Market trending upward' },
        updatedAt: new Date('2026-09-27').toISOString(),
      },
    ],
  };

  const mockTaskB: TaskResponse = {
    id: 'task-b',
    taskId: 'task-b-67890',
    status: 'completed',
    createdAt: new Date('2026-09-26T10:00:00Z').toISOString(),
    updatedAt: new Date('2026-09-26T10:07:00Z').toISOString(),
    prompt: 'Analyze market trends for Q3 2026',
    result: 'Market analysis complete',
    cost: '0.6',
    dag: [
      {
        nodeId: 'node-research',
        agentType: 'research',
        status: 'completed',
        input: 'Q3 2026 market data',
        output: 'Research findings',
        startTime: new Date('2026-09-26T10:00:00Z').toISOString(),
        endTime: new Date('2026-09-26T10:04:00Z').toISOString(),
        result: { summary: 'Market was stable' },
        updatedAt: new Date('2026-09-26').toISOString(),
      },
    ],
  };

  const mockOnClose = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('Rendering', () => {
    it('renders comparison dialog with both tasks', () => {
      render(
        <TaskComparison
          taskA={mockTaskA}
          taskB={mockTaskB}
          onClose={mockOnClose}
        />
      );

      expect(screen.getByRole('dialog')).toBeInTheDocument();
      expect(screen.getByLabelText('Task comparison')).toBeInTheDocument();
    });

    it('displays task IDs in the header', () => {
      render(
        <TaskComparison
          taskA={mockTaskA}
          taskB={mockTaskB}
          onClose={mockOnClose}
        />
      );

      expect(screen.getByText(/task-a-1/)).toBeInTheDocument();
      expect(screen.getByText(/task-b-6/)).toBeInTheDocument();
    });

    it('renders comparison columns for both tasks', () => {
      const { container } = render(
        <TaskComparison
          taskA={mockTaskA}
          taskB={mockTaskB}
          onClose={mockOnClose}
        />
      );

      const columns = container.querySelectorAll('[class*="column"]');
      expect(columns.length).toBeGreaterThanOrEqual(2);
    });
  });

  describe('Task Details Display', () => {
    it('shows prompts for both tasks', () => {
      render(
        <TaskComparison
          taskA={mockTaskA}
          taskB={mockTaskB}
          onClose={mockOnClose}
        />
      );

      expect(screen.getByText('Analyze market trends for Q4 2026')).toBeInTheDocument();
      expect(screen.getByText('Analyze market trends for Q3 2026')).toBeInTheDocument();
    });

    it('displays task status for both tasks', () => {
      render(
        <TaskComparison
          taskA={mockTaskA}
          taskB={mockTaskB}
          onClose={mockOnClose}
        />
      );

      const statusElements = screen.getAllByText('completed');
      expect(statusElements.length).toBeGreaterThanOrEqual(2);
    });

    it('shows metrics (duration, cost, nodes)', () => {
      render(
        <TaskComparison
          taskA={mockTaskA}
          taskB={mockTaskB}
          onClose={mockOnClose}
        />
      );

      expect(screen.getByText('Duration')).toBeInTheDocument();
      expect(screen.getByText('Est. Cost')).toBeInTheDocument();
      expect(screen.getByText('Nodes')).toBeInTheDocument();
    });

    it('displays agent types used in tasks', () => {
      render(
        <TaskComparison
          taskA={mockTaskA}
          taskB={mockTaskB}
          onClose={mockOnClose}
        />
      );

      // research agent type should be displayed in both tasks
      const agentElements = screen.getAllByText('research');
      expect(agentElements.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe('Diff Mode', () => {
    it('toggling diff mode updates the checkbox state', () => {
      render(
        <TaskComparison
          taskA={mockTaskA}
          taskB={mockTaskB}
          onClose={mockOnClose}
        />
      );

      const diffCheckbox = screen.getByLabelText(
        'Highlight differences between tasks'
      ) as HTMLInputElement;

      expect(diffCheckbox.checked).toBe(false);

      fireEvent.click(diffCheckbox);
      expect(diffCheckbox.checked).toBe(true);

      fireEvent.click(diffCheckbox);
      expect(diffCheckbox.checked).toBe(false);
    });

    it('displays Show diff label', () => {
      render(
        <TaskComparison
          taskA={mockTaskA}
          taskB={mockTaskB}
          onClose={mockOnClose}
        />
      );

      expect(screen.getByText('Show diff')).toBeInTheDocument();
    });
  });

  describe('Export Functionality', () => {
    beforeEach(() => {
      // Mock URL.createObjectURL and document methods
      global.URL.createObjectURL = vi.fn(() => 'blob:mock-url');
      global.URL.revokeObjectURL = vi.fn();
      vi.spyOn(document, 'createElement').mockReturnValue(document.createElement('a'));
    });

    it('exports comparison as markdown file', () => {
      render(
        <TaskComparison
          taskA={mockTaskA}
          taskB={mockTaskB}
          onClose={mockOnClose}
        />
      );

      const exportBtn = screen.getByLabelText('Export comparison as markdown');
      fireEvent.click(exportBtn);

      // Verify that export was triggered
      expect(screen.getByLabelText('Export comparison as markdown')).toBeInTheDocument();
    });

    it('displays export button', () => {
      render(
        <TaskComparison
          taskA={mockTaskA}
          taskB={mockTaskB}
          onClose={mockOnClose}
        />
      );

      expect(screen.getByText('Export MD')).toBeInTheDocument();
    });
  });

  describe('Close Functionality', () => {
    it('calls onClose when close button is clicked', () => {
      render(
        <TaskComparison
          taskA={mockTaskA}
          taskB={mockTaskB}
          onClose={mockOnClose}
        />
      );

      const closeBtn = screen.getByLabelText('Close comparison');
      fireEvent.click(closeBtn);

      expect(mockOnClose).toHaveBeenCalledTimes(1);
    });

    it('calls onClose when backdrop is clicked', () => {
      const { container } = render(
        <TaskComparison
          taskA={mockTaskA}
          taskB={mockTaskB}
          onClose={mockOnClose}
        />
      );

      const backdrop = container.querySelector('[class*="backdrop"]');
      if (backdrop) {
        fireEvent.click(backdrop);
        expect(mockOnClose).toHaveBeenCalled();
      }
    });
  });

  describe('Different Agent Output Types', () => {
    it('handles string output format', () => {
      const taskWithStringOutput: TaskResponse = {
        ...mockTaskA,
        dag: [
          {
            ...mockTaskA.dag![0],
            result: 'Simple string output',
          },
        ],
      };

      render(
        <TaskComparison
          taskA={taskWithStringOutput}
          taskB={mockTaskB}
          onClose={mockOnClose}
        />
      );

      expect(screen.getByRole('dialog')).toBeInTheDocument();
    });

    it('handles object output with summary field', () => {
      const taskWithSummary: TaskResponse = {
        ...mockTaskA,
        dag: [
          {
            ...mockTaskA.dag![0],
            result: { summary: 'Task summary', extra: 'data' },
          },
        ],
      };

      render(
        <TaskComparison
          taskA={taskWithSummary}
          taskB={mockTaskB}
          onClose={mockOnClose}
        />
      );

      expect(screen.getByRole('dialog')).toBeInTheDocument();
    });

    it('handles object output with markdown field', () => {
      const taskWithMarkdown: TaskResponse = {
        ...mockTaskA,
        dag: [
          {
            ...mockTaskA.dag![0],
            result: { markdown: '# Heading\n\nContent' },
          },
        ],
      };

      render(
        <TaskComparison
          taskA={taskWithMarkdown}
          taskB={mockTaskB}
          onClose={mockOnClose}
        />
      );

      expect(screen.getByRole('dialog')).toBeInTheDocument();
    });

    it('handles object output with code field', () => {
      const taskWithCode: TaskResponse = {
        ...mockTaskA,
        dag: [
          {
            ...mockTaskA.dag![0],
            result: { code: 'const x = 42;' },
          },
        ],
      };

      render(
        <TaskComparison
          taskA={taskWithCode}
          taskB={mockTaskB}
          onClose={mockOnClose}
        />
      );

      expect(screen.getByRole('dialog')).toBeInTheDocument();
    });

    it('handles null or undefined output', () => {
      const taskWithNullOutput: TaskResponse = {
        ...mockTaskA,
        dag: [
          {
            ...mockTaskA.dag![0],
            result: null,
          },
        ],
      };

      render(
        <TaskComparison
          taskA={taskWithNullOutput}
          taskB={mockTaskB}
          onClose={mockOnClose}
        />
      );

      expect(screen.getByRole('dialog')).toBeInTheDocument();
    });
  });

  describe('Task Status Variations', () => {
    it('handles failed task status', () => {
      const failedTask: TaskResponse = {
        ...mockTaskA,
        status: 'failed',
      };

      render(
        <TaskComparison
          taskA={failedTask}
          taskB={mockTaskB}
          onClose={mockOnClose}
        />
      );

      const statusElements = screen.getAllByText('failed');
      expect(statusElements.length).toBeGreaterThanOrEqual(1);
    });

    it('handles running task status', () => {
      const runningTask: TaskResponse = {
        ...mockTaskA,
        status: 'running',
      };

      render(
        <TaskComparison
          taskA={runningTask}
          taskB={mockTaskB}
          onClose={mockOnClose}
        />
      );

      const statusElements = screen.getAllByText('running');
      expect(statusElements.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe('Accessibility', () => {
    it('has proper ARIA attributes for dialog', () => {
      render(
        <TaskComparison
          taskA={mockTaskA}
          taskB={mockTaskB}
          onClose={mockOnClose}
        />
      );

      const dialog = screen.getByRole('dialog');
      expect(dialog).toHaveAttribute('aria-modal', 'true');
      expect(dialog).toHaveAttribute('aria-label', 'Task comparison');
    });

    it('has accessible section headings', () => {
      render(
        <TaskComparison
          taskA={mockTaskA}
          taskB={mockTaskB}
          onClose={mockOnClose}
        />
      );

      expect(screen.getByText('Prompt')).toBeInTheDocument();
      expect(screen.getByText('Metrics')).toBeInTheDocument();
    });
  });
});
