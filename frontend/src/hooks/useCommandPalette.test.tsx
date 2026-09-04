import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, test, expect, beforeEach } from 'vitest';
import { WalletProvider } from '../context/WalletContext';
import { ThemeProvider } from '../context/ThemeContext';
import { useCommandPalette } from './useCommandPalette';

const Harness: React.FC = () => {
  const { isOpen, commands } = useCommandPalette();

  return (
    <div>
      <span data-testid="palette-state">{isOpen ? 'open' : 'closed'}</span>
      <span data-testid="command-count">{commands.length}</span>
      <span data-testid="command-labels">{commands.map((c) => c.label).join(',')}</span>
      <span data-testid="command-categories">{commands.map((c) => c.category).join(',')}</span>
    </div>
  );
};

const renderHook = () =>
  render(
    <MemoryRouter>
      <WalletProvider>
        <ThemeProvider>
          <Harness />
        </ThemeProvider>
      </WalletProvider>
    </MemoryRouter>
  );

describe('useCommandPalette', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  test('starts closed', () => {
    renderHook();
    expect(screen.getByTestId('palette-state')).toHaveTextContent('closed');
  });

  test('Cmd+K opens the palette (macOS shortcut)', () => {
    renderHook();
    fireEvent.keyDown(document, { key: 'k', metaKey: true });
    expect(screen.getByTestId('palette-state')).toHaveTextContent('open');
  });

  test('Ctrl+K opens the palette (other platforms)', () => {
    renderHook();
    fireEvent.keyDown(document, { key: 'K', ctrlKey: true });
    expect(screen.getByTestId('palette-state')).toHaveTextContent('open');
  });

  test('Escape closes the palette', () => {
    renderHook();
    fireEvent.keyDown(document, { key: 'k', metaKey: true });
    expect(screen.getByTestId('palette-state')).toHaveTextContent('open');

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.getByTestId('palette-state')).toHaveTextContent('closed');
  });

  test('registers the six default commands', () => {
    renderHook();

    expect(screen.getByTestId('command-count')).toHaveTextContent('6');
    expect(screen.getByTestId('command-labels')).toHaveTextContent(
      'Go to Dashboard,New Task,Browse Agents,Open Wallet,Toggle Theme,Disconnect Wallet'
    );
    expect(screen.getByTestId('command-categories')).toHaveTextContent(
      'navigation,navigation,navigation,navigation,settings,settings'
    );
  });
});
