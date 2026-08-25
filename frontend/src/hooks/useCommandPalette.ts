import { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import type { CommandPaletteResult } from '../components/common/CommandPalette';
import { useAgentRegistry } from './useAgentRegistry';
import { apiClient } from '../services/api';

const RECENT_SEARCHES_KEY = 'command_palette_recent_searches';
const MAX_RECENT = 5;

export function useCommandPalette() {
  const navigate = useNavigate();
  const { agents } = useAgentRegistry();
  const [isOpen, setIsOpen] = useState(false);
  const [recentSearches, setRecentSearches] = useState<string[]>([]);

  useEffect(() => {
    try {
      const stored = localStorage.getItem(RECENT_SEARCHES_KEY);
      if (stored) {
        setRecentSearches(JSON.parse(stored));
      }
    } catch {
    }
  }, []);

  const addRecentSearch = useCallback((query: string) => {
    if (!query.trim()) return;
    setRecentSearches((prev) => {
      const filtered = prev.filter((s) => s !== query);
      const updated = [query, ...filtered].slice(0, MAX_RECENT);
      try {
        localStorage.setItem(RECENT_SEARCHES_KEY, JSON.stringify(updated));
      } catch {
      }
      return updated;
    });
  }, []);

  const togglePalette = useCallback(() => {
    setIsOpen((prev) => !prev);
  }, []);

  const closePalette = useCallback(() => {
    setIsOpen(false);
  }, []);

  const search = useCallback(
    async (query: string): Promise<CommandPaletteResult[]> => {
      if (!query.trim()) return [];

      const results: CommandPaletteResult[] = [];
      const q = query.toLowerCase();

      const pages = [
        { path: '/dashboard', title: 'Dashboard', subtitle: 'Overview and network stats' },
        { path: '/tasks/new', title: 'New Task', subtitle: 'Create and submit a new task' },
        { path: '/agents', title: 'Agents', subtitle: 'Browse registered agents' },
        { path: '/wallet', title: 'Wallet', subtitle: 'Manage your Stellar wallet' },
      ];

      pages.forEach((page) => {
        if (page.title.toLowerCase().includes(q) || page.subtitle.toLowerCase().includes(q)) {
          results.push({
            id: 'page-' + page.path,
            title: page.title,
            subtitle: page.subtitle,
            category: 'page',
            action: () => navigate(page.path),
          });
        }
      });

      agents.forEach((agent) => {
        const nameMatch = agent.name.toLowerCase().includes(q);
        const capMatch = agent.capabilities.some((cap: string) => cap.toLowerCase().includes(q));
        if (nameMatch || capMatch) {
          results.push({
            id: 'agent-' + agent.id,
            title: agent.name,
            subtitle: agent.capabilities.slice(0, 3).join(', '),
            category: 'agent',
            metadata: agent.price.toFixed(2) + ' XLM',
            action: () => navigate('/agents?q=' + encodeURIComponent(agent.name)),
          });
        }
      });

      try {
        const walletPubKey = localStorage.getItem('wallet_pubkey');
        if (walletPubKey) {
          const tasks = await apiClient.get<any[]>('/api/wallets/' + walletPubKey + '/tasks?limit=5');
          tasks.forEach((task) => {
            const taskId = task.id || task.taskId;
            if (taskId?.toLowerCase().includes(q) || task.prompt?.toLowerCase().includes(q)) {
              results.push({
                id: 'task-' + taskId,
                title: taskId?.slice(0, 12) || 'Task',
                subtitle: task.prompt?.slice(0, 60) || 'No prompt',
                category: 'task',
                metadata: task.status || 'unknown',
                action: () => navigate('/tasks/' + taskId),
              });
            }
          });
        }
      } catch {
      }

      if (results.length > 0) {
        addRecentSearch(query);
      }

      return results;
    },
    [agents, navigate, addRecentSearch]
  );

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault();
        togglePalette();
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
    togglePalette,
    closePalette,
    search,
    recentSearches,
    addRecentSearch,
  };
}
