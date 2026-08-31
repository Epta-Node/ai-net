import React from 'react';
import { renderHook, act } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { AgentRecord } from '../types/api';
import type { CommandPaletteResult } from '../components/common/CommandPalette';

const mockNavigate = vi.fn();
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>('react-router-dom');
  return { ...actual, useNavigate: () => mockNavigate };
});

const mockAgents: AgentRecord[] = [
  {
    id: 'agent-research',
    name: 'Research Agent',
    capabilities: ['research', 'summarize'],
    price: 0.5,
  } as AgentRecord,
  {
    id: 'agent-risk',
    name: 'Risk Analyzer',
    capabilities: ['risk', 'compliance'],
    price: 1.25,
  } as AgentRecord,
];

vi.mock('./useAgentRegistry', () => ({
  useAgentRegistry: () => ({ agents: mockAgents, loading: false, error: null, refetch: vi.fn() }),
}));

const mockApiGet = vi.fn();
vi.mock('../services/api', () => ({
  apiClient: { get: (...args: unknown[]) => mockApiGet(...args) },
}));

const mockSetMode = vi.fn();
vi.mock('./useTheme', () => ({
  default: () => ({ mode: 'dark', setMode: mockSetMode, effectiveTheme: 'dark' }),
}));

const mockShowToast = vi.fn();
let mockPublicKey: string | null = null;
vi.mock('../context/ToastContext', () => ({
  useToast: () => ({ toasts: [], showToast: mockShowToast, dismissToast: vi.fn() }),
}));
vi.mock('../context/WalletContext', () => ({
  useWallet: () => ({ publicKey: mockPublicKey, connected: Boolean(mockPublicKey) }),
}));

// Imported after the mocks so the hook picks them up.
const { useCommandPalette } = await import('./useCommandPalette');

const wrapper = ({ children }: { children: React.ReactNode }) => (
  <MemoryRouter>{children}</MemoryRouter>
);

const renderPalette = () => renderHook(() => useCommandPalette(), { wrapper });

/** Run a search and return the results, awaiting the hook's async work. */
async function runSearch(
  result: { current: ReturnType<typeof useCommandPalette> },
  query: string,
): Promise<CommandPaletteResult[]> {
  let results: CommandPaletteResult[] = [];
  await act(async () => {
    results = await result.current.search(query);
  });
  return results;
}

const titles = (results: CommandPaletteResult[]) => results.map((r) => r.title);

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  mockPublicKey = null;
  mockApiGet.mockResolvedValue([]);
});

// ─── Opening and closing ────────────────────────────────────────────────────

describe('useCommandPalette open state', () => {
  it('starts closed', () => {
    const { result } = renderPalette();
    expect(result.current.isOpen).toBe(false);
  });

  it('opens on Ctrl+K and closes on a second press', () => {
    const { result } = renderPalette();

    act(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true }));
    });
    expect(result.current.isOpen).toBe(true);

    act(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true }));
    });
    expect(result.current.isOpen).toBe(false);
  });

  it('opens on Cmd+K for macOS', () => {
    const { result } = renderPalette();
    act(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', metaKey: true }));
    });
    expect(result.current.isOpen).toBe(true);
  });

  it('opens on Ctrl+K when the shift key makes the event report "K"', () => {
    const { result } = renderPalette();
    act(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'K', ctrlKey: true }));
    });
    expect(result.current.isOpen).toBe(true);
  });

  it('closes on Escape while open', () => {
    const { result } = renderPalette();
    act(() => {
      result.current.togglePalette();
    });
    act(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    });
    expect(result.current.isOpen).toBe(false);
  });
});

// ─── Fuzzy search across sources ────────────────────────────────────────────

describe('useCommandPalette search', () => {
  it('returns nothing for an empty query', async () => {
    const { result } = renderPalette();
    expect(await runSearch(result, '   ')).toEqual([]);
  });

  it('matches a page by an exact name', async () => {
    const { result } = renderPalette();
    const results = await runSearch(result, 'wallet');
    expect(titles(results)).toContain('Wallet');
  });

  it('matches a page by a non-contiguous subset of its name', async () => {
    const { result } = renderPalette();
    const results = await runSearch(result, 'dshb');
    expect(titles(results)).toContain('Dashboard');
  });

  it('matches an agent by a subset of its name', async () => {
    const { result } = renderPalette();
    const results = await runSearch(result, 'rsrch');
    expect(titles(results)).toContain('Research Agent');
  });

  it('matches an agent by its capabilities, not just its name', async () => {
    const { result } = renderPalette();
    const results = await runSearch(result, 'compliance');
    expect(titles(results)).toContain('Risk Analyzer');
  });

  it('returns no results when nothing matches', async () => {
    const { result } = renderPalette();
    expect(await runSearch(result, 'qqqzzzxxx')).toEqual([]);
  });

  it('orders results by score, best first', async () => {
    const { result } = renderPalette();
    const results = await runSearch(result, 'wallet');
    // An exact page/action hit must outrank an incidental subsequence hit.
    expect(results[0].title.toLowerCase()).toContain('wallet');
  });

  it('carries highlight indices when the title itself matched', async () => {
    const { result } = renderPalette();
    const results = await runSearch(result, 'dshb');
    const dashboard = results.find((r) => r.title === 'Dashboard');
    expect(dashboard?.titleMatches).toHaveLength(4);
  });
});

// ─── Actions ────────────────────────────────────────────────────────────────

describe('useCommandPalette actions', () => {
  it('offers the "run new task" action and navigates when it runs', async () => {
    const { result } = renderPalette();
    const results = await runSearch(result, 'run new task');
    const action = results.find((r) => r.id === 'action-run-new-task');

    expect(action?.category).toBe('action');
    act(() => action!.action());
    expect(mockNavigate).toHaveBeenCalledWith('/tasks/new');
  });

  it('offers "jump to agent" and "open wallet"', async () => {
    const { result } = renderPalette();
    const jump = (await runSearch(result, 'jump to agent')).find(
      (r) => r.id === 'action-jump-to-agent',
    );
    const wallet = (await runSearch(result, 'open wallet')).find(
      (r) => r.id === 'action-open-wallet',
    );

    act(() => jump!.action());
    expect(mockNavigate).toHaveBeenCalledWith('/agents');

    act(() => wallet!.action());
    expect(mockNavigate).toHaveBeenCalledWith('/wallet');
  });

  it('cycles the theme from the "toggle theme" action', async () => {
    const { result } = renderPalette();
    const toggle = (await runSearch(result, 'toggle theme')).find(
      (r) => r.id === 'action-toggle-theme',
    );

    act(() => toggle!.action());
    // The hook is mocked at mode 'dark', which cycles to 'system'.
    expect(mockSetMode).toHaveBeenCalledWith('system');
  });

  it('hides "copy address" when no wallet is connected', async () => {
    const { result } = renderPalette();
    const results = await runSearch(result, 'copy wallet address');
    expect(results.find((r) => r.id === 'action-copy-address')).toBeUndefined();
  });

  it('copies the public key when a wallet is connected', async () => {
    mockPublicKey = 'GABCDEFGHIJKLMNOPQRSTUVWXYZ012345678901234567890123456789';
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });

    const { result } = renderPalette();
    const results = await runSearch(result, 'copy wallet address');
    const copy = results.find((r) => r.id === 'action-copy-address');
    expect(copy).toBeDefined();

    await act(async () => {
      copy!.action();
    });
    expect(writeText).toHaveBeenCalledWith(mockPublicKey);
  });
});

// ─── Tasks ──────────────────────────────────────────────────────────────────

describe('useCommandPalette task results', () => {
  it('does not hit the tasks API without a connected wallet', async () => {
    const { result } = renderPalette();
    await runSearch(result, 'task');
    expect(mockApiGet).not.toHaveBeenCalled();
  });

  it('matches a task by a fragment of its prompt', async () => {
    mockPublicKey = 'GWALLET';
    mockApiGet.mockResolvedValue([
      { id: 'task-abcdef123456', prompt: 'Summarise the quarterly filings', status: 'completed' },
    ]);

    const { result } = renderPalette();
    const results = await runSearch(result, 'quarterly');
    expect(results.find((r) => r.id === 'task-task-abcdef123456')).toBeDefined();
  });

  it('still returns local results when the tasks API fails', async () => {
    mockPublicKey = 'GWALLET';
    mockApiGet.mockRejectedValue(new Error('offline'));

    const { result } = renderPalette();
    const results = await runSearch(result, 'wallet');
    expect(results.length).toBeGreaterThan(0);
  });
});

// ─── Recent searches ────────────────────────────────────────────────────────

describe('useCommandPalette recent searches', () => {
  it('records a query that produced results', async () => {
    const { result } = renderPalette();
    await runSearch(result, 'wallet');
    expect(result.current.recentSearches).toContain('wallet');
  });

  it('does not record a query that found nothing', async () => {
    const { result } = renderPalette();
    await runSearch(result, 'qqqzzzxxx');
    expect(result.current.recentSearches).toEqual([]);
  });

  it('persists history to localStorage and reloads it', async () => {
    const { result, unmount } = renderPalette();
    await runSearch(result, 'wallet');
    unmount();

    const { result: reloaded } = renderPalette();
    expect(reloaded.current.recentSearches).toContain('wallet');
  });

  it('keeps at most five entries, most recent first', async () => {
    const { result } = renderPalette();
    for (const term of ['wallet', 'agents', 'dashboard', 'task', 'theme', 'research']) {
      await runSearch(result, term);
    }
    expect(result.current.recentSearches).toHaveLength(5);
    expect(result.current.recentSearches[0]).toBe('research');
    expect(result.current.recentSearches).not.toContain('wallet');
  });

  it('does not duplicate a repeated query, it moves it to the front', async () => {
    const { result } = renderPalette();
    await runSearch(result, 'wallet');
    await runSearch(result, 'agents');
    await runSearch(result, 'wallet');

    expect(result.current.recentSearches.filter((s) => s === 'wallet')).toHaveLength(1);
    expect(result.current.recentSearches[0]).toBe('wallet');
  });

  it('matches recent history as a search source', async () => {
    const { result } = renderPalette();
    await runSearch(result, 'wallet');

    const results = await runSearch(result, 'wllt');
    const recent = results.find((r) => r.category === 'recent');
    expect(recent).toBeDefined();
    // The stored term as typed, not the page whose label happens to match.
    expect(recent!.title).toBe('wallet');
  });

  it('survives a corrupt localStorage entry', () => {
    localStorage.setItem('command_palette_recent_searches', '{not json');
    const { result } = renderPalette();
    expect(result.current.recentSearches).toEqual([]);
  });

  it('bumps a stored query to the front via runRecentSearch', async () => {
    const { result } = renderPalette();
    await runSearch(result, 'wallet');
    await runSearch(result, 'agents');

    act(() => result.current.runRecentSearch('wallet'));
    expect(result.current.recentSearches[0]).toBe('wallet');
  });
});
