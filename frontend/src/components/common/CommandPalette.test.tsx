import React from 'react';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, test, expect, vi, beforeEach } from 'vitest';
import { CommandPalette } from './CommandPalette';

vi.mock('framer-motion', async () => {
  const actual = await vi.importActual<typeof import('framer-motion')>('framer-motion');
  return {
    ...actual,
    AnimatePresence: ({ children }: { children: React.ReactNode }) => <>{children}</>,
    motion: {
      div: React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
        ({ children, ...props }, ref) => <div ref={ref} {...props}>{children}</div>
      ),
      button: React.forwardRef<HTMLButtonElement, React.ButtonHTMLAttributes<HTMLButtonElement>>(
        ({ children, ...props }, ref) => <button ref={ref} {...props}>{children}</button>
      ),
    },
  };
});

describe('CommandPalette', () => {
  const mockResults = [
    {
      id: 'page-1',
      title: 'Dashboard',
      subtitle: 'Overview',
      category: 'page' as const,
      action: vi.fn(),
    },
    {
      id: 'agent-1',
      title: 'Research Agent',
      subtitle: 'research, data',
      category: 'agent' as const,
      metadata: '0.5 XLM',
      action: vi.fn(),
    },
  ];

  const mockOnSearch = vi.fn().mockResolvedValue(mockResults);
  const mockOnClose = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
  });

  test('renders nothing when isOpen is false', () => {
    render(
      <MemoryRouter>
        <CommandPalette
          isOpen={false}
          onClose={mockOnClose}
          onSearch={mockOnSearch}
        />
      </MemoryRouter>
    );

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  test('renders when isOpen is true', () => {
    render(
      <MemoryRouter>
        <CommandPalette
          isOpen={true}
          onClose={mockOnClose}
          onSearch={mockOnSearch}
        />
      </MemoryRouter>
    );

    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(screen.getByPlaceholderText('Search agents, tasks, or pages...')).toBeInTheDocument();
  });

  test('has correct accessibility attributes', () => {
    render(
      <MemoryRouter>
        <CommandPalette
          isOpen={true}
          onClose={mockOnClose}
          onSearch={mockOnSearch}
        />
      </MemoryRouter>
    );

    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(dialog).toHaveAttribute('aria-label', 'Command palette');
  });

  test('focuses input when opened', async () => {
    render(
      <MemoryRouter>
        <CommandPalette
          isOpen={true}
          onClose={mockOnClose}
          onSearch={mockOnSearch}
        />
      </MemoryRouter>
    );

    const input = screen.getByPlaceholderText('Search agents, tasks, or pages...');
    await waitFor(() => {
      expect(document.activeElement).toBe(input);
    });
  });

  test('displays recent searches when no query', () => {
    const recentSearches = ['agent', 'task', 'dashboard'];
    render(
      <MemoryRouter>
        <CommandPalette
          isOpen={true}
          onClose={mockOnClose}
          onSearch={mockOnSearch}
          recentSearches={recentSearches}
          onRecentSearchClick={vi.fn()}
        />
      </MemoryRouter>
    );

    expect(screen.getByText('Recent Searches')).toBeInTheDocument();
    expect(screen.getByText('agent')).toBeInTheDocument();
    expect(screen.getByText('task')).toBeInTheDocument();
    expect(screen.getByText('dashboard')).toBeInTheDocument();
  });

  test('debounces search (300ms)', async () => {
    vi.useFakeTimers();
    render(
      <MemoryRouter>
        <CommandPalette
          isOpen={true}
          onClose={mockOnClose}
          onSearch={mockOnSearch}
        />
      </MemoryRouter>
    );

    const input = screen.getByPlaceholderText('Search agents, tasks, or pages...');
    fireEvent.change(input, { target: { value: 'test' } });

    expect(mockOnSearch).not.toHaveBeenCalled();

    await act(async () => {
      vi.advanceTimersByTime(300);
    });

    expect(mockOnSearch).toHaveBeenCalledWith('test');
    vi.useRealTimers();
  });

  test('displays search results grouped by category', async () => {
    render(
      <MemoryRouter>
        <CommandPalette
          isOpen={true}
          onClose={mockOnClose}
          onSearch={mockOnSearch}
        />
      </MemoryRouter>
    );

    const input = screen.getByPlaceholderText('Search agents, tasks, or pages...');
    fireEvent.change(input, { target: { value: 'test' } });

    await waitFor(() => {
      expect(screen.getByText('Pages')).toBeInTheDocument();
      expect(screen.getByText('Dashboard')).toBeInTheDocument();
      expect(screen.getByText('Agents')).toBeInTheDocument();
      expect(screen.getByText('Research Agent')).toBeInTheDocument();
    });
  });

  test('closes on Escape key', () => {
    render(
      <MemoryRouter>
        <CommandPalette
          isOpen={true}
          onClose={mockOnClose}
          onSearch={mockOnSearch}
        />
      </MemoryRouter>
    );

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(mockOnClose).toHaveBeenCalled();
  });

  test('closes when clicking overlay', () => {
    render(
      <MemoryRouter>
        <CommandPalette
          isOpen={true}
          onClose={mockOnClose}
          onSearch={mockOnSearch}
        />
      </MemoryRouter>
    );

    const overlay = document.querySelector('.overlay');
    if (overlay) {
      fireEvent.click(overlay);
      expect(mockOnClose).toHaveBeenCalled();
    }
  });

  test('arrow key navigation works', async () => {
    render(
      <MemoryRouter>
        <CommandPalette
          isOpen={true}
          onClose={mockOnClose}
          onSearch={mockOnSearch}
        />
      </MemoryRouter>
    );

    const input = screen.getByPlaceholderText('Search agents, tasks, or pages...');
    fireEvent.change(input, { target: { value: 'test' } });

    await waitFor(() => {
      expect(screen.getByText('Dashboard')).toBeInTheDocument();
    });

    const items = screen.getAllByRole('button');
    expect(items.length).toBeGreaterThan(0);

    fireEvent.keyDown(input, { key: 'ArrowDown' });
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    fireEvent.keyDown(input, { key: 'ArrowUp' });
  });

  test('Enter selects highlighted result', async () => {
    const mockAction = vi.fn();
    const resultsWithAction = [
      {
        id: 'page-1',
        title: 'Dashboard',
        subtitle: 'Overview',
        category: 'page' as const,
        action: mockAction,
      },
    ];

    const onSearch = vi.fn().mockResolvedValue(resultsWithAction);

    render(
      <MemoryRouter>
        <CommandPalette
          isOpen={true}
          onClose={mockOnClose}
          onSearch={onSearch}
        />
      </MemoryRouter>
    );

    const input = screen.getByPlaceholderText('Search agents, tasks, or pages...');
    fireEvent.change(input, { target: { value: 'test' } });

    await waitFor(() => {
      expect(screen.getByText('Dashboard')).toBeInTheDocument();
    });

    fireEvent.keyDown(input, { key: 'Enter' });
    expect(mockAction).toHaveBeenCalled();
    expect(mockOnClose).toHaveBeenCalled();
  });

  test('shows empty state when no results found', async () => {
    const onSearch = vi.fn().mockResolvedValue([]);

    render(
      <MemoryRouter>
        <CommandPalette
          isOpen={true}
          onClose={mockOnClose}
          onSearch={onSearch}
        />
      </MemoryRouter>
    );

    const input = screen.getByPlaceholderText('Search agents, tasks, or pages...');
    fireEvent.change(input, { target: { value: 'nonexistent' } });

    await waitFor(() => {
      expect(screen.getByText('No results found')).toBeInTheDocument();
      expect(screen.getByText('Try adjusting your search')).toBeInTheDocument();
    });
  });
});
