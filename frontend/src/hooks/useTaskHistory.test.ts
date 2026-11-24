import { renderHook, act } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { MockedFunction } from 'vitest';
import { useTaskHistory, DEFAULT_FILTERS } from './useTaskHistory';
import { ApiError, apiClient } from '../services/api';
import type { TaskResponse, DAGNode } from '../types/api';

vi.mock('../services/api', () => ({
  apiClient: { get: vi.fn() },
  ApiError: class ApiError extends Error {
    statusCode: number;
    path: string;
    constructor(statusCode: number, message: string, path: string) {
      super(message);
      this.name = 'ApiError';
      this.statusCode = statusCode;
      this.path = path;
    }
  },
}));

const mockedGet = apiClient.get as unknown as MockedFunction<
  typeof apiClient.get
>;

const WALLET = 'GTESTWALLET0000000000000000000000000000000000000000000000000';

function makeTask(overrides: Partial<TaskResponse> = {}): TaskResponse {
  return {
    taskId: 'task-1',
    prompt: 'Test task',
    walletPublicKey: WALLET,
    status: 'completed',
    dag: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

function makeNode(
  nodeId: string,
  agentType: string,
  status: DAGNode['status'] = 'completed'
): DAGNode {
  return { nodeId, agentType, prompt: 'node prompt', dependsOn: [], status };
}

function page(items: TaskResponse[], nextCursor: string | null = null) {
  return {
    data: {
      items,
      pagination: { limit: 50, nextCursor, hasNextPage: nextCursor !== null },
    },
  };
}

describe('useTaskHistory', () => {
  const noopUpdate = () => {};
  const noopReset = () => {};

  beforeEach(() => {
    localStorage.clear();
    localStorage.setItem('wallet_pubkey', WALLET);
    mockedGet.mockReset();
    mockedGet.mockResolvedValue(page([]));
  });

  // ─── Request-count regression (#631) ────────────────────────────────

  it('issues exactly one fetchTasks(null) request on mount', async () => {
    renderHook(() => useTaskHistory(DEFAULT_FILTERS, noopUpdate, noopReset));
    await act(async () => {});

    expect(mockedGet).toHaveBeenCalledTimes(1);
  });

  it('refetches exactly once when filters.status changes', async () => {
    const { rerender } = renderHook(
      ({ status }) =>
        useTaskHistory({ ...DEFAULT_FILTERS, status }, noopUpdate, noopReset),
      { initialProps: { status: 'all' as const } }
    );
    await act(async () => {});
    expect(mockedGet).toHaveBeenCalledTimes(1);

    rerender({ status: 'completed' as const });
    await act(async () => {});
    expect(mockedGet).toHaveBeenCalledTimes(2);

    rerender({ status: 'failed' as const });
    await act(async () => {});
    expect(mockedGet).toHaveBeenCalledTimes(3);
  });

  it('does not refetch when a non-status filter changes', async () => {
    const { rerender } = renderHook(
      ({ search }) =>
        useTaskHistory({ ...DEFAULT_FILTERS, search }, noopUpdate, noopReset),
      { initialProps: { search: '' } }
    );
    await act(async () => {});
    expect(mockedGet).toHaveBeenCalledTimes(1);

    rerender({ search: 'market' });
    await act(async () => {});
    expect(mockedGet).toHaveBeenCalledTimes(1);
  });

  it('sends the status as a query param only when set', async () => {
    const { rerender } = renderHook(
      ({ status }) =>
        useTaskHistory({ ...DEFAULT_FILTERS, status }, noopUpdate, noopReset),
      { initialProps: { status: 'all' as const } }
    );
    await act(async () => {});

    expect(mockedGet).toHaveBeenCalledWith(
      expect.stringContaining(`/api/wallets/${WALLET}/tasks?limit=50`)
    );

    rerender({ status: 'running' as const });
    await act(async () => {});
    expect(mockedGet).toHaveBeenLastCalledWith(
      expect.stringContaining('status=running')
    );
  });

  // ─── Data handling ─────────────────────────────────────────────────

  it('exposes fetched tasks and clears the loading state', async () => {
    const tasks = [
      makeTask(),
      makeTask({ taskId: 'task-2', status: 'running' }),
    ];
    mockedGet.mockResolvedValue(page(tasks));

    const { result } = renderHook(() =>
      useTaskHistory(DEFAULT_FILTERS, noopUpdate, noopReset)
    );

    expect(result.current.loading).toBe(true);
    await act(async () => {});

    expect(result.current.allTasks).toHaveLength(2);
    expect(result.current.loading).toBe(false);
    expect(result.current.error).toBeNull();
  });

  it('parses the v2 cursor envelope without a fallback request', async () => {
    const tasks = [makeTask({ taskId: 'task-1' })];
    mockedGet.mockResolvedValue(page(tasks, 'cursor-1'));

    const { result } = renderHook(() =>
      useTaskHistory(DEFAULT_FILTERS, noopUpdate, noopReset)
    );
    await act(async () => {});

    expect(mockedGet).toHaveBeenCalledTimes(1);
    expect(result.current.allTasks).toEqual(tasks);
  });

  it('refetch resets the list and reloads from the first page', async () => {
    const first = [makeTask({ taskId: 'task-1' })];
    const second = [makeTask({ taskId: 'task-2' })];
    mockedGet
      .mockResolvedValueOnce(page(first, 'cursor-1'))
      .mockResolvedValueOnce(page(second));

    const { result } = renderHook(() =>
      useTaskHistory(DEFAULT_FILTERS, noopUpdate, noopReset)
    );
    await act(async () => {});
    expect(result.current.allTasks).toEqual(first);

    await act(async () => {
      result.current.refetch();
    });

    expect(mockedGet).toHaveBeenCalledTimes(2);
    expect(result.current.allTasks).toEqual(second);
  });

  it('surfaces the error message when the request fails', async () => {
    mockedGet.mockRejectedValueOnce(new Error('boom'));
    const { result } = renderHook(() =>
      useTaskHistory(DEFAULT_FILTERS, noopUpdate, noopReset)
    );
    await act(async () => {});

    expect(result.current.error).toBe('boom');
    expect(result.current.allTasks).toEqual([]);
    expect(result.current.loading).toBe(false);
  });

  it('returns no tasks when no wallet is connected', async () => {
    localStorage.removeItem('wallet_pubkey');
    localStorage.removeItem('walletAddress');
    const { result } = renderHook(() =>
      useTaskHistory(DEFAULT_FILTERS, noopUpdate, noopReset)
    );
    await act(async () => {});

    expect(mockedGet).not.toHaveBeenCalled();
    expect(result.current.allTasks).toEqual([]);
    expect(result.current.loading).toBe(false);
  });

  it('falls back to the flat-array endpoint on a 404 envelope', async () => {
    mockedGet
      .mockRejectedValueOnce(new ApiError(404, 'not found', '/api/tasks'))
      .mockResolvedValueOnce([makeTask({ taskId: 'flat-1' })]);

    const { result } = renderHook(() =>
      useTaskHistory(DEFAULT_FILTERS, noopUpdate, noopReset)
    );
    await act(async () => {});

    expect(mockedGet).toHaveBeenCalledTimes(2);
    expect(result.current.allTasks).toHaveLength(1);
    expect(result.current.allTasks[0].taskId).toBe('flat-1');
  });

  // ─── Filters and derived data ──────────────────────────────────────

  it('applies non-status filters client-side without refetching', async () => {
    const tasks = [
      makeTask({ taskId: 'a', prompt: 'market report', status: 'completed' }),
      makeTask({ taskId: 'b', prompt: 'other', status: 'failed' }),
    ];
    mockedGet.mockResolvedValue(page(tasks));

    const { result, rerender } = renderHook(
      ({ filters }) => useTaskHistory(filters, noopUpdate, noopReset),
      { initialProps: { filters: DEFAULT_FILTERS } }
    );
    await act(async () => {});
    expect(result.current.filteredTasks).toHaveLength(2);

    rerender({ filters: { ...DEFAULT_FILTERS, search: 'market' } });
    await act(async () => {});
    expect(mockedGet).toHaveBeenCalledTimes(1);
    expect(result.current.filteredTasks.map((t) => t.taskId)).toEqual(['a']);

    rerender({ filters: { ...DEFAULT_FILTERS, status: 'failed' } });
    await act(async () => {});
    expect(result.current.filteredTasks.map((t) => t.taskId)).toEqual(['b']);
  });

  it('supports selecting up to two tasks for comparison', async () => {
    const { result } = renderHook(() =>
      useTaskHistory(DEFAULT_FILTERS, noopUpdate, noopReset)
    );
    await act(async () => {});

    expect(result.current.isComparing).toBe(false);

    act(() => result.current.toggleSelect('a'));
    expect(result.current.selectedIds).toEqual(['a', null]);

    act(() => result.current.toggleSelect('b'));
    expect(result.current.isComparing).toBe(true);

    act(() => result.current.toggleSelect('c'));
    // Deselects the oldest selection when a third is picked
    expect(result.current.selectedIds).toEqual(['b', 'c']);

    act(() => result.current.clearSelection());
    expect(result.current.selectedIds).toEqual([null, null]);
    expect(result.current.isComparing).toBe(false);
  });

  it('derives available agent types from the task DAGs', async () => {
    const tasks = [
      makeTask({ dag: [makeNode('n1', 'research')] }),
      makeTask({
        taskId: 'task-2',
        dag: [makeNode('n2', 'coding')],
      }),
    ];
    mockedGet.mockResolvedValue(page(tasks));

    const { result } = renderHook(() =>
      useTaskHistory(DEFAULT_FILTERS, noopUpdate, noopReset)
    );
    await act(async () => {});

    expect(result.current.availableAgentTypes).toEqual(['coding', 'research']);
  });

  it('passes updateFilters and resetFilters through unchanged', async () => {
    const updateFilters = vi.fn();
    const resetFilters = vi.fn();
    const { result } = renderHook(() =>
      useTaskHistory(DEFAULT_FILTERS, updateFilters, resetFilters)
    );
    await act(async () => {});

    act(() => result.current.updateFilters({ search: 'x' }));
    expect(updateFilters).toHaveBeenCalledWith({ search: 'x' });

    act(() => result.current.resetFilters());
    expect(resetFilters).toHaveBeenCalled();
  });
});
