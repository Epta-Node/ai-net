/**
 * useCursorPagination
 *
 * Generic hook for consuming cursor-paginated v2 list endpoints.
 *
 * Usage:
 *   const { items, loading, error, hasNextPage, loadMore, reset } =
 *     useCursorPagination<TaskResponse>('/api/tasks', 20);
 *
 * On mount it fetches the first page. Calling `loadMore()` appends the next
 * page. Calling `reset()` discards all state and re-fetches from the start.
 *
 * Extra query params (filters, sort, etc.) can be supplied via `params`. When
 * `params` changes the list resets automatically.
 */
import { useState, useEffect, useCallback, useRef } from 'react';
import { apiClient } from '../services/api';
import type { CursorPageEnvelope } from '../types/api';

export interface UseCursorPaginationResult<T> {
  items: T[];
  loading: boolean;
  /** True while loading the first page (items is still empty). */
  initialLoading: boolean;
  error: string | null;
  hasNextPage: boolean;
  loadMore: () => void;
  reset: () => void;
}

export function useCursorPagination<T>(
  endpoint: string,
  limit = 20,
  params: Record<string, string> = {},
): UseCursorPaginationResult<T> {
  const [items, setItems] = useState<T[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [hasNextPage, setHasNextPage] = useState(false);
  const [loading, setLoading] = useState(false);
  const [initialLoading, setInitialLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Serialize params so the effect dep works correctly
  const paramsKey = JSON.stringify(params);
  const cursorRef = useRef<string | null>(null);

  const fetchPage = useCallback(
    async (pageCursor: string | null, append: boolean) => {
      setLoading(true);
      setError(null);
      try {
        const qs = new URLSearchParams({ limit: String(limit), ...params });
        if (pageCursor) qs.set('cursor', pageCursor);

        const envelope = await apiClient.get<CursorPageEnvelope<T>>(
          `${endpoint}?${qs.toString()}`,
        );

        const page = envelope.data;
        setItems((prev) => (append ? [...prev, ...page.items] : page.items));
        const next = page.pagination.nextCursor ?? null;
        setCursor(next);
        cursorRef.current = next;
        setHasNextPage(page.pagination.hasNextPage);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to load data');
      } finally {
        setLoading(false);
        setInitialLoading(false);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [endpoint, limit, paramsKey],
  );

  // Reset and fetch first page when endpoint or params change
  useEffect(() => {
    setItems([]);
    setCursor(null);
    cursorRef.current = null;
    setHasNextPage(false);
    setInitialLoading(true);
    fetchPage(null, false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [endpoint, limit, paramsKey]);

  const loadMore = useCallback(() => {
    if (!loading && cursorRef.current) {
      fetchPage(cursorRef.current, true);
    }
  }, [loading, fetchPage]);

  const reset = useCallback(() => {
    setItems([]);
    setCursor(null);
    cursorRef.current = null;
    setHasNextPage(false);
    setInitialLoading(true);
    fetchPage(null, false);
  }, [fetchPage]);

  return { items, loading, initialLoading, error, hasNextPage, loadMore, reset };
}
