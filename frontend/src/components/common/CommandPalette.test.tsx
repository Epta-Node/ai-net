import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, test, expect, vi, beforeEach } from 'vitest';
import { CommandPalette, type Command } from './CommandPalette';

describe('CommandPalette', () => {
  const makeCommands = (): Command[] => [
    {
      id: 'dashboard',
      label: 'Go to Dashboard',
      category: 'navigation',
      action: vi.fn(),
    },
    {
      id: 'new-task',
      label: 'New Task',
      category: 'navigation',
      action: vi.fn(),
    },
    {
      id: 'agents',
      label: 'Browse Agents',
      category: 'navigation',
      action: vi.fn(),
    },
    {
      id: 'wallet',
      label: 'Open Wallet',
      category: 'navigation',
      action: vi.fn(),
    },
    {
      id: 'toggle-theme',
      label: 'Toggle Theme',
      category: 'settings',
      action: vi.fn(),
    },
    {
      id: 'disconnect-wallet',
      label: 'Disconnect Wallet',
      category: 'settings',
      action: vi.fn(),
    },
  ];

  let commands: Command[];
  const mockOnClose = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    commands = makeCommands();
  });

  test('renders nothing when isOpen is false', () => {
    render(<CommandPalette isOpen={false} onClose={mockOnClose} commands={commands} />);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  test('renders a dialog with correct accessibility attributes when open', () => {
    render(<CommandPalette isOpen={true} onClose={mockOnClose} commands={commands} />);

    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(dialog).toHaveAttribute('aria-label', 'Command palette');

    const input = screen.getByRole('combobox');
    expect(input).toHaveAttribute('role', 'combobox');
    expect(input).toHaveAttribute('aria-controls', 'command-palette-listbox');
    expect(input).toHaveAttribute('aria-activedescendant', 'command-palette-option-0');
  });

  test('focuses the search input when opened', async () => {
    render(<CommandPalette isOpen={true} onClose={mockOnClose} commands={commands} />);
    const input = screen.getByRole('combobox');
    await waitFor(() => {
      expect(document.activeElement).toBe(input);
    });
  });

  test('shows all commands grouped by category when there is no query', () => {
    render(<CommandPalette isOpen={true} onClose={mockOnClose} commands={commands} />);

    expect(screen.getByText('Navigate')).toBeInTheDocument();
    expect(screen.getByText('Settings')).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'Go to Dashboard' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'New Task' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'Toggle Theme' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'Disconnect Wallet' })).toBeInTheDocument();
  });

  test('filters commands by fuzzy match on label', () => {
    render(<CommandPalette isOpen={true} onClose={mockOnClose} commands={commands} />);
    const input = screen.getByRole('combobox');

    fireEvent.change(input, { target: { value: 'dsh' } });

    expect(screen.getByRole('option', { name: 'Go to Dashboard' })).toBeInTheDocument();
    expect(screen.queryByRole('option', { name: 'New Task' })).not.toBeInTheDocument();
    expect(screen.queryByRole('option', { name: 'Disconnect Wallet' })).not.toBeInTheDocument();
  });

  test('filters commands by fuzzy match on category', () => {
    render(<CommandPalette isOpen={true} onClose={mockOnClose} commands={commands} />);
    const input = screen.getByRole('combobox');

    fireEvent.change(input, { target: { value: 'setting' } });

    expect(screen.getByRole('option', { name: 'Toggle Theme' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'Disconnect Wallet' })).toBeInTheDocument();
    expect(screen.queryByRole('option', { name: 'Go to Dashboard' })).not.toBeInTheDocument();
  });

  test('arrow keys move the highlighted selection', () => {
    render(<CommandPalette isOpen={true} onClose={mockOnClose} commands={commands} />);
    const input = screen.getByRole('combobox');

    expect(input).toHaveAttribute('aria-activedescendant', 'command-palette-option-0');

    fireEvent.keyDown(input, { key: 'ArrowDown' });
    expect(input).toHaveAttribute('aria-activedescendant', 'command-palette-option-1');

    fireEvent.keyDown(input, { key: 'ArrowDown' });
    expect(input).toHaveAttribute('aria-activedescendant', 'command-palette-option-2');

    fireEvent.keyDown(input, { key: 'ArrowUp' });
    expect(input).toHaveAttribute('aria-activedescendant', 'command-palette-option-1');
  });

  test('arrow keys wrap around the result list', () => {
    render(<CommandPalette isOpen={true} onClose={mockOnClose} commands={commands} />);
    const input = screen.getByRole('combobox');

    // Jump to the end, then wrap to the first.
    for (let i = 0; i < commands.length; i++) {
      fireEvent.keyDown(input, { key: 'ArrowDown' });
    }
    expect(input).toHaveAttribute('aria-activedescendant', 'command-palette-option-0');

    fireEvent.keyDown(input, { key: 'ArrowUp' });
    expect(input).toHaveAttribute(
      'aria-activedescendant',
      `command-palette-option-${commands.length - 1}`
    );
  });

  test('Enter executes the selected command and closes the palette', () => {
    const dashboardAction = commands[0].action;
    render(<CommandPalette isOpen={true} onClose={mockOnClose} commands={commands} />);
    const input = screen.getByRole('combobox');

    fireEvent.keyDown(input, { key: 'Enter' });

    expect(dashboardAction).toHaveBeenCalledTimes(1);
    expect(mockOnClose).toHaveBeenCalledTimes(1);
  });

  test('Enter executes the command highlighted after arrow navigation', () => {
    const themeAction = commands[4].action;
    render(<CommandPalette isOpen={true} onClose={mockOnClose} commands={commands} />);
    const input = screen.getByRole('combobox');

    fireEvent.keyDown(input, { key: 'ArrowDown' });
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    fireEvent.keyDown(input, { key: 'Enter' });

    expect(themeAction).toHaveBeenCalledTimes(1);
    expect(mockOnClose).toHaveBeenCalledTimes(1);
  });

  test('Escape closes the palette without executing', () => {
    const dashboardAction = commands[0].action;
    render(<CommandPalette isOpen={true} onClose={mockOnClose} commands={commands} />);

    fireEvent.keyDown(document, { key: 'Escape' });

    expect(mockOnClose).toHaveBeenCalledTimes(1);
    expect(dashboardAction).not.toHaveBeenCalled();
  });

  test('closes when clicking the overlay backdrop', () => {
    render(<CommandPalette isOpen={true} onClose={mockOnClose} commands={commands} />);

    // The dialog element is the overlay backdrop itself.
    fireEvent.click(screen.getByRole('dialog'));
    expect(mockOnClose).toHaveBeenCalledTimes(1);
  });

  test('clicking a result executes it and closes the palette', () => {
    const walletAction = commands[3].action;
    render(<CommandPalette isOpen={true} onClose={mockOnClose} commands={commands} />);

    fireEvent.click(screen.getByRole('option', { name: 'Open Wallet' }));

    expect(walletAction).toHaveBeenCalledTimes(1);
    expect(mockOnClose).toHaveBeenCalledTimes(1);
  });

  test('shows an empty state when no command matches', () => {
    render(<CommandPalette isOpen={true} onClose={mockOnClose} commands={commands} />);
    const input = screen.getByRole('combobox');

    fireEvent.change(input, { target: { value: 'zzz-no-match' } });

    expect(screen.getByText('No commands found')).toBeInTheDocument();
    expect(screen.queryByRole('option')).not.toBeInTheDocument();
  });

  test('Escape closes from the search input when no commands match', () => {
    render(<CommandPalette isOpen={true} onClose={mockOnClose} commands={commands} />);
    const input = screen.getByRole('combobox');

    fireEvent.change(input, { target: { value: 'zzz-no-match' } });
    fireEvent.keyDown(input, { key: 'Escape' });

    expect(mockOnClose).toHaveBeenCalledTimes(1);
  });

  test('shows keyboard shortcut hints', () => {
    render(<CommandPalette isOpen={true} onClose={mockOnClose} commands={commands} />);

    expect(screen.getByText('navigate')).toBeInTheDocument();
    expect(screen.getByText('select')).toBeInTheDocument();
    expect(screen.getByText('close')).toBeInTheDocument();
  });

  test('returns focus to the previously focused element after closing', async () => {
    const { rerender } = render(
      <div>
        <button>Trigger</button>
        <CommandPalette isOpen={false} onClose={mockOnClose} commands={commands} />
      </div>
    );

    const trigger = screen.getByText('Trigger');
    trigger.focus();
    expect(document.activeElement).toBe(trigger);

    rerender(
      <div>
        <button>Trigger</button>
        <CommandPalette isOpen={true} onClose={mockOnClose} commands={commands} />
      </div>
    );

    const input = screen.getByRole('combobox');
    await waitFor(() => {
      expect(document.activeElement).toBe(input);
    });

    rerender(
      <div>
        <button>Trigger</button>
        <CommandPalette isOpen={false} onClose={mockOnClose} commands={commands} />
      </div>
    );

    await waitFor(() => {
      expect(document.activeElement).toBe(trigger);
    });
  });
});
