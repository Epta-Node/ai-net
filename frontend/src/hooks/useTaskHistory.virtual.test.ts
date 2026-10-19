import { describe, expect, it } from 'vitest';
import type { TaskResponse } from '../types/api';
import { getVirtualRange, mergeTaskPages, shouldFetchNextPage } from './useTaskHistory';

const task = (taskId: string, status: TaskResponse['status'] = 'completed'): TaskResponse =>
  ({ taskId, prompt: taskId, walletPublicKey: 'w', status, dag: [], createdAt: '2026-10-19T00:00:00Z', updatedAt: '2026-10-19T00:00:00Z' }) as TaskResponse;

describe('task history cursor merge (#816)', () => {
  it('keeps one copy of tasks seen in two cursor windows, updated to the newer copy', () => {
    const merged = mergeTaskPages([task('a'), task('b', 'running')], [task('b', 'completed'), task('c')]);
    expect(merged.map((t) => t.taskId)).toEqual(['a', 'b', 'c']);
    expect(merged[1].status).toBe('completed');
  });

  it('handles empty pages', () => {
    expect(mergeTaskPages([], [])).toEqual([]);
  });
});

describe('virtual list range (#816)', () => {
  it('renders no more than 30 rows for a 500-item list', () => {
    for (const scrollTop of [0, 5000, 31_000]) {
      const range = getVirtualRange(scrollTop, 600, 32, 500);
      expect(range.end - range.start).toBeLessThanOrEqual(30);
      expect(range.totalHeight).toBe(500 * 32);
    }
  });

  it('applies overscan and clamps to the list bounds', () => {
    expect(getVirtualRange(0, 320, 64, 100)).toEqual({ start: 0, end: 10, offsetTop: 0, totalHeight: 6400 });
    expect(getVirtualRange(6400, 320, 64, 100).end).toBe(100);
    expect(getVirtualRange(0, 320, 64, 0)).toEqual({ start: 0, end: 0, offsetTop: 0, totalHeight: 0 });
  });

  it('asks for the next page near the bottom only', () => {
    expect(shouldFetchNextPage(0, 600, 6400)).toBe(false);
    expect(shouldFetchNextPage(5700, 600, 6400)).toBe(true);
    expect(shouldFetchNextPage(0, 600, 0)).toBe(false);
  });
});
