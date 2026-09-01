import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Bot,
  FilePlus2,
  LayoutDashboard,
  LogOut,
  SunMoon,
  Wallet as WalletIcon,
} from 'lucide-react';
import type { Command } from '../components/common/CommandPalette';
import { useTheme } from './useTheme';
import { useWallet } from './useWallet';

/**
 * Global command palette state plus the default command registry.
 *
 * The registry is built here because the default commands need router
 * (`useNavigate`), theme (`useTheme`) and wallet (`useWallet`) context to
 * build their actions. The `CommandPalette` component stays presentational:
 * it receives the registry as a prop and only deals with filtering and
 * keyboard interaction.
 */
export function useCommandPalette() {
  const navigate = useNavigate();
  const { effectiveTheme, setMode } = useTheme();
  const { disconnect } = useWallet();

  const [isOpen, setIsOpen] = useState(false);

  const openPalette = useCallback(() => setIsOpen(true), []);
  const closePalette = useCallback(() => setIsOpen(false), []);
  const togglePalette = useCallback(() => setIsOpen((prev) => !prev), []);

  const commands = useMemo<Command[]>(() => {
    const navigateTo = (path: string) => () => navigate(path);

    return [
      {
        id: 'dashboard',
        label: 'Go to Dashboard',
        icon: LayoutDashboard,
        category: 'navigation',
        action: navigateTo('/dashboard'),
      },
      {
        id: 'new-task',
        label: 'New Task',
        icon: FilePlus2,
        category: 'navigation',
        action: navigateTo('/tasks/new'),
      },
      {
        id: 'agents',
        label: 'Browse Agents',
        icon: Bot,
        category: 'navigation',
        action: navigateTo('/agents'),
      },
      {
        id: 'wallet',
        label: 'Open Wallet',
        icon: WalletIcon,
        category: 'navigation',
        action: navigateTo('/wallet'),
      },
      {
        id: 'toggle-theme',
        label: 'Toggle Theme',
        icon: SunMoon,
        category: 'settings',
        action: () => setMode(effectiveTheme === 'dark' ? 'light' : 'dark'),
      },
      {
        id: 'disconnect-wallet',
        label: 'Disconnect Wallet',
        icon: LogOut,
        category: 'settings',
        action: () => disconnect(),
      },
    ];
  }, [navigate, effectiveTheme, setMode, disconnect]);

  // Global shortcut: Cmd+K (macOS) / Ctrl+K (other) toggles the palette.
  // Escape closes it from anywhere while open.
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        togglePalette();
        return;
      }

      if (e.key === 'Escape' && isOpen) {
        e.preventDefault();
        closePalette();
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [togglePalette, closePalette, isOpen]);

  return {
    isOpen,
    openPalette,
    closePalette,
    togglePalette,
    commands,
  };
}
