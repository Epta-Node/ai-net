import { useState, useEffect, useCallback, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import type { CommandPaletteResult } from '../components/common/CommandPalette';
import { useAgentRegistry } from './useAgentRegistry';
import { useWallet } from '../context/WalletContext';
import { useToast } from '../context/ToastContext';
import useTheme from './useTheme';
import type { ThemeMode } from '../context/ThemeContext';
import { apiClient } from '../services/api';
import { fuzzyMatchFields } from '../utils/fuzzy';
import { NAV_ITEMS } from '../components/layout/navigation';

const RECENT_SEARCHES_KEY = 'command_palette_recent_searches';
const MAX_RECENT = 5;
/** Cap on task records pulled per search — the palette is a jump list, not a table. */
const TASK_FETCH_LIMIT = 20;

/** Field weights: a hit on the title outranks the same hit in a subtitle. */
const TITLE_WEIGHT = 1;
const SUBTITLE_WEIGHT = 0.6;
const METADATA_WEIGHT = 0.4;

/**
 * Category weights, applied after field weighting.
 *
 * Actions are what a command palette is *for*, so an equally good textual match
 * on "Open Wallet" should beat one on some agent that happens to be named
 * similarly. Recent searches rank last: they are a convenience, not an answer.
 */
const CATEGORY_WEIGHT: Record<string, number> = {
  action: 1.25,
  page: 1.15,
  agent: 1,
  task: 1,
  recent: 0.7,
};

/** Anything scoring below this is noise — a couple of scattered letters. */
const MIN_SCORE = 1;

interface RankedResult extends CommandPaletteResult {
  score: number;
}

interface TaskRecord {
  id?: string;
  taskId?: string;
  prompt?: string;
  status?: string;
}

const THEME_CYCLE: Record<ThemeMode, ThemeMode> = {
  light: 'dark',
  dark: 'system',
  system: 'light',
};

export function useCommandPalette() {
  const navigate = useNavigate();
  const { t } = useTranslation();
  const { agents } = useAgentRegistry();
  const { publicKey } = useWallet();
  const { showToast } = useToast();
  const { mode, setMode } = useTheme();
  const [isOpen, setIsOpen] = useState(false);
  const [recentSearches, setRecentSearches] = useState<string[]>([]);

  useEffect(() => {
    try {
      const stored = localStorage.getItem(RECENT_SEARCHES_KEY);
      if (stored) {
        const parsed: unknown = JSON.parse(stored);
        if (Array.isArray(parsed)) {
          setRecentSearches(parsed.filter((item): item is string => typeof item === 'string'));
        }
      }
    } catch {
      // A corrupt or unreadable entry just means no history.
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
        // History is a nicety; failing to persist must not break search.
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

  const copyWalletAddress = useCallback(async () => {
    if (!publicKey) return;
    try {
      await navigator.clipboard.writeText(publicKey);
      showToast(t('palette.action.copyAddressDone'), 'success');
    } catch {
      showToast(t('palette.action.copyAddressFailed'), 'error');
    }
  }, [publicKey, showToast, t]);

  /**
   * Commands that *do* something, as opposed to navigating somewhere.
   *
   * Kept separate from pages so they can be weighted differently and so a
   * command with no page of its own (copy address, toggle theme) still has a
   * home in the palette.
   */
  const actions = useMemo(() => {
    const entries: { id: string; title: string; subtitle: string; run: () => void }[] = [
      {
        id: 'run-new-task',
        title: t('palette.action.newTask'),
        subtitle: t('palette.action.newTaskHint'),
        run: () => navigate('/tasks/new'),
      },
      {
        id: 'jump-to-agent',
        title: t('palette.action.jumpToAgent'),
        subtitle: t('palette.action.jumpToAgentHint'),
        run: () => navigate('/agents'),
      },
      {
        id: 'open-wallet',
        title: t('palette.action.openWallet'),
        subtitle: t('palette.action.openWalletHint'),
        run: () => navigate('/wallet'),
      },
      {
        id: 'toggle-theme',
        title: t('palette.action.toggleTheme'),
        subtitle: t('palette.action.toggleThemeHint', { mode }),
        run: () => setMode(THEME_CYCLE[mode]),
      },
    ];

    // Offering "copy address" with no wallet connected would be a dead entry.
    if (publicKey) {
      entries.push({
        id: 'copy-address',
        title: t('palette.action.copyAddress'),
        subtitle: `${publicKey.slice(0, 4)}…${publicKey.slice(-4)}`,
        run: () => {
          void copyWalletAddress();
        },
      });
    }

    return entries;
  }, [t, navigate, mode, setMode, publicKey, copyWalletAddress]);

  const search = useCallback(
    async (query: string): Promise<CommandPaletteResult[]> => {
      const trimmed = query.trim();
      if (!trimmed) return [];

      const ranked: RankedResult[] = [];

      const push = (
        result: Omit<CommandPaletteResult, 'titleMatches'>,
        fields: { text: string | undefined; weight: number }[],
      ) => {
        const match = fuzzyMatchFields(trimmed, fields);
        if (!match) return;

        const score = match.score * (CATEGORY_WEIGHT[result.category] ?? 1);
        if (score < MIN_SCORE) return;

        ranked.push({
          ...result,
          score,
          // Highlight only when the title itself is what matched; highlighting
          // title characters because the *subtitle* matched would be a lie.
          titleMatches: match.fieldIndex === 0 ? match.indices : undefined,
        });
      };

      actions.forEach((action) => {
        push(
          {
            id: `action-${action.id}`,
            title: action.title,
            subtitle: action.subtitle,
            category: 'action',
            action: action.run,
          },
          [
            { text: action.title, weight: TITLE_WEIGHT },
            { text: action.subtitle, weight: SUBTITLE_WEIGHT },
          ],
        );
      });

      // Pages come from the shared nav config, so the palette can never drift
      // out of sync with the sidebar.
      NAV_ITEMS.forEach((item) => {
        const title = t(item.labelKey);
        push(
          {
            id: `page-${item.path}`,
            title,
            subtitle: item.path,
            category: 'page',
            action: () => navigate(item.path),
          },
          [
            { text: title, weight: TITLE_WEIGHT },
            { text: item.path, weight: SUBTITLE_WEIGHT },
          ],
        );
      });

      agents.forEach((agent) => {
        const capabilities = agent.capabilities.join(', ');
        push(
          {
            id: `agent-${agent.id}`,
            title: agent.name,
            subtitle: agent.capabilities.slice(0, 3).join(', '),
            category: 'agent',
            metadata: `${agent.price.toFixed(2)} XLM`,
            action: () => navigate(`/agents?q=${encodeURIComponent(agent.name)}`),
          },
          [
            { text: agent.name, weight: TITLE_WEIGHT },
            { text: capabilities, weight: SUBTITLE_WEIGHT },
          ],
        );
      });

      // Recent searches are searchable too, so re-running an earlier query
      // needs only a few of its characters.
      recentSearches.forEach((term) => {
        push(
          {
            id: `recent-${term}`,
            title: term,
            category: 'recent',
            action: () => navigate(`/agents?q=${encodeURIComponent(term)}`),
          },
          [{ text: term, weight: TITLE_WEIGHT }],
        );
      });

      if (publicKey) {
        try {
          const tasks = await apiClient.get<TaskRecord[]>(
            `/api/wallets/${publicKey}/tasks?limit=${TASK_FETCH_LIMIT}`,
          );
          tasks.forEach((task) => {
            const taskId = task.id || task.taskId;
            if (!taskId) return;
            const title = taskId.slice(0, 12);
            push(
              {
                id: `task-${taskId}`,
                title,
                subtitle: task.prompt?.slice(0, 60) || t('palette.task.noPrompt'),
                category: 'task',
                metadata: task.status || t('common.notAvailable'),
                action: () => navigate(`/tasks/${taskId}`),
              },
              [
                { text: title, weight: TITLE_WEIGHT },
                { text: task.prompt, weight: SUBTITLE_WEIGHT },
                { text: task.status, weight: METADATA_WEIGHT },
              ],
            );
          });
        } catch {
          // The palette stays useful for local results when the API is down.
        }
      }

      ranked.sort((a, b) => b.score - a.score);

      if (ranked.length > 0) {
        addRecentSearch(trimmed);
      }

      // `score` is ranking scaffolding, not part of the render contract.
      return ranked.map(({ score: _score, ...result }) => result);
    },
    [actions, agents, recentSearches, publicKey, navigate, addRecentSearch, t],
  );

  /** Re-running a stored query bumps it back to the top of the history. */
  const runRecentSearch = useCallback(
    (query: string) => {
      addRecentSearch(query);
    },
    [addRecentSearch],
  );

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
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
    runRecentSearch,
  };
}
