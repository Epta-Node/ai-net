import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useTaskHistory, DEFAULT_FILTERS } from './useTaskHistory';
import type { TaskResponse } from '../types/api';

describe('useTaskHistory pagination', () => {
  beforeEach(() => {
    localStorage.setItem('wallet_pubkey', 'wallet-1');
  });

  it('loads task 51 and skips duplicate IDs when appending a page', async () => {
    const firstPage = Array.from({ length: 50 }, (_, index) => ({
      taskId: `task-${index + 1}`,
      prompt: `Task ${index + 1}`,
      walletPublicKey: 'wallet-1',
      status: 'completed' as const,
      dag: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    } satisfies TaskResponse));

    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = new URL(String(input), window.location.origin);
      const isNextPage = url.searchParams.has('cursor');
      const body = isNextPage
        ? {
            data: {
              items: [firstPage[49], { ...firstPage[49], taskId: 'task-51', prompt: 'Task 51' }],
              pagination: { limit: 50, nextCursor: null, hasNextPage: false },
            },
          }
        : {
            data: {
              items: firstPage,
              pagination: { limit: 50, nextCursor: 'cursor-2', hasNextPage: true },
            },
          };

      return {
        ok: true,
        status: 200,
        headers: { get: () => 'application/json' },
        json: async () => body,
      } as unknown as Response;
    });

    const { result } = renderHook(() =>
      useTaskHistory(DEFAULT_FILTERS, vi.fn(), vi.fn())
    );

    await waitFor(() => expect(result.current.allTasks).toHaveLength(50));
    expect(result.current.hasNextPage).toBe(true);

    act(() => result.current.loadMore());

    await waitFor(() => expect(result.current.allTasks).toHaveLength(51));
    expect(result.current.allTasks.at(-1)?.taskId).toBe('task-51');
    expect(new Set(result.current.allTasks.map((task) => task.taskId)).size).toBe(51);
    expect(result.current.hasNextPage).toBe(false);
  });
});