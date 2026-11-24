import { useState, useEffect, useCallback, useMemo } from 'react';
import type { CursorPageEnvelope, TaskResponse, NodeStatus } from '../types/api';
import { ApiError, apiClient } from '../services/api';
import { readWalletSession } from '../services/walletSession';

// ─── Filter types ────────────────────────────────────────────────────────────

export type ZoomLevel = 'day' | 'week' | 'month';

export interface TaskHistoryFilters {
  status: NodeStatus | 'all';
  agentType: string;
  dateFrom: string; // ISO date string or ''
  dateTo: string;   // ISO date string or ''
  zoom: ZoomLevel;
  search: string;
}

export const DEFAULT_FILTERS: TaskHistoryFilters = {
  status: 'all',
  agentType: 'all',
  dateFrom: '',
  dateTo: '',
  zoom: 'week',
  search: '',
};

// ─── URL serialisation ───────────────────────────────────────────────────────

export function filtersFromSearchParams(
  params: URLSearchParams
): TaskHistoryFilters {
  return {
    status: (params.get('status') as TaskHistoryFilters['status']) || 'all',
    agentType: params.get('agentType') || 'all',
    dateFrom: params.get('dateFrom') || '',
    dateTo: params.get('dateTo') || '',
    zoom: (params.get('zoom') as ZoomLevel) || 'week',
    search: params.get('search') || '',
  };
}

export function filtersToSearchParams(
  filters: TaskHistoryFilters
): Record<string, string> {
  const out: Record<string, string> = {};
  if (filters.status !== 'all') out.status = filters.status;
  if (filters.agentType !== 'all') out.agentType = filters.agentType;
  if (filters.dateFrom) out.dateFrom = filters.dateFrom;
  if (filters.dateTo) out.dateTo = filters.dateTo;
  if (filters.zoom !== 'week') out.zoom = filters.zoom;
  if (filters.search) out.search = filters.search;
  return out;
}

// ─── Derived helpers ─────────────────────────────────────────────────────────

/** Compute the total duration (ms) of a task. Returns undefined when unknown. */
export function getTaskDuration(task: TaskResponse): number | undefined {
  if (!task.createdAt || !task.updatedAt) return undefined;
  const start = new Date(task.createdAt).getTime();
  const end = new Date(task.updatedAt).getTime();
  return end > start ? end - start : undefined;
}

/** Rough cost estimate: sum agent costs derived from agentType. */
export function getTaskCost(task: TaskResponse): number {
  if (!task.dag || !task.dag.length) return 0;
  const costs: Record<string, number> = {
    research: 0.5,
    risk: 0.3,
    coding: 1.2,
    design: 0.6,
    report: 0.4,
  };
  return task.dag.reduce((sum, node) => {
    const type = (node.agentType || '').toLowerCase();
    const match = Object.keys(costs).find((k) => type.includes(k));
    return sum + (match ? costs[match] : 0.5);
  }, 0);
}

/** Unique agent types used across a task's DAG */
export function getTaskAgentTypes(task: TaskResponse): string[] {
  if (!task.dag) return [];
  const types = new Set<string>();
  task.dag.forEach((n) => {
    const base = (n.agentType || '').toLowerCase();
    const key = ['research', 'risk', 'coding', 'design', 'report'].find((k) =>
      base.includes(k)
    );
    if (key) types.add(key);
  });
  return Array.from(types);
}

/** Format ms duration as human-readable string */
export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const m = Math.floor(ms / 60_000);
  const s = Math.round((ms % 60_000) / 1000);
  return s > 0 ? `${m}m ${s}s` : `${m}m`;
}

// ─── Cursor merging & virtualisation (#816) ──────────────────────────────────

/** Default page size requested from the cursor endpoint. */
export const DEFAULT_TASK_PAGE_SIZE = 50;

/**
 * Appends a cursor page to the tasks already loaded. A task that shows up in
 * two cursor windows (clock skew between pages) is kept once, in its original
 * position, updated to the newer copy so a status change isn't lost. New tasks
 * are appended in page order; display sorting happens in `filteredTasks`.
 */
export function mergeTaskPages(existing: TaskResponse[], incoming: TaskResponse[]): TaskResponse[] {
  const byId = new Map<string, TaskResponse>();
  for (const task of existing) byId.set(task.taskId, task);
  for (const task of incoming) byId.set(task.taskId, task);
  return Array.from(byId.values());
}

export interface VirtualRange {
  start: number;
  /** Exclusive end index. */
  end: number;
  /** Space above the first rendered row, in px. */
  offsetTop: number;
  totalHeight: number;
}

/**
 * Rows to render for a fixed-height virtual list: only the rows in the
 * viewport plus `overscan` on each side, so the DOM size stays constant no
 * matter how many tasks are loaded.
 */
export function getVirtualRange(
  scrollTop: number,
  viewportHeight: number,
  rowHeight: number,
  itemCount: number,
  overscan = 5,
): VirtualRange {
  const totalHeight = itemCount * rowHeight;
  if (itemCount === 0 || rowHeight <= 0) return { start: 0, end: 0, offsetTop: 0, totalHeight: 0 };
  const visible = Math.ceil(viewportHeight / rowHeight);
  // Clamp so an over-scrolled position still renders the last screenful.
  const first = Math.min(
    Math.floor(Math.max(0, scrollTop) / rowHeight),
    Math.max(0, itemCount - visible),
  );
  const start = Math.max(0, first - overscan);
  const end = Math.min(itemCount, first + visible + overscan);
  return { start, end, offsetTop: start * rowHeight, totalHeight };
}

/** True when the scroll position is within `threshold` px of the bottom. */
export function shouldFetchNextPage(
  scrollTop: number,
  viewportHeight: number,
  totalHeight: number,
  threshold = 200,
): boolean {
  return totalHeight > 0 && scrollTop + viewportHeight >= totalHeight - threshold;
}

// ─── Filter logic ─────────────────────────────────────────────────────────────

function taskMatchesFilters(
  task: TaskResponse,
  filters: TaskHistoryFilters
): boolean {
  // Status filter
  if (filters.status !== 'all' && task.status !== filters.status) return false;

  // Agent type filter
  if (filters.agentType !== 'all') {
    const types = getTaskAgentTypes(task);
    if (!types.includes(filters.agentType)) return false;
  }

  // Date range filter
  const createdAt = new Date(task.createdAt).getTime();
  if (filters.dateFrom) {
    const from = new Date(filters.dateFrom).getTime();
    if (createdAt < from) return false;
  }
  if (filters.dateTo) {
    // Include the whole "to" day
    const to = new Date(filters.dateTo).getTime() + 86_400_000;
    if (createdAt > to) return false;
  }

  // Full-text search against prompt
  if (filters.search) {
    const q = filters.search.toLowerCase();
    if (!task.prompt?.toLowerCase().includes(q) && !task.taskId?.toLowerCase().includes(q)) {
      return false;
    }
  }

  return true;
}

/** Restrict task list to the zoom window relative to now */
function applyZoom(tasks: TaskResponse[], zoom: ZoomLevel): TaskResponse[] {
  const now = Date.now();
  const windowMs: Record<ZoomLevel, number> = {
    day: 86_400_000,
    week: 7 * 86_400_000,
    month: 30 * 86_400_000,
  };
  const cutoff = now - windowMs[zoom];
  return tasks.filter((t) => new Date(t.createdAt).getTime() >= cutoff);
}

// ─── Hook ────────────────────────────────────────────────────────────────────

export interface UseTaskHistoryResult {
  /** All tasks fetched (unfiltered) */
  allTasks: TaskResponse[];
  /** Tasks matching current filters within the zoom window */
  filteredTasks: TaskResponse[];
  loading: boolean;
  /** True while a follow-up page (not the first) is loading — show the bottom spinner. */
  isFetchingNextPage: boolean;
  error: string | null;
  /** Currently applied filters */
  filters: TaskHistoryFilters;
  /** Update one or more filter fields */
  updateFilters: (next: Partial<TaskHistoryFilters>) => void;
  /** Reset all filters to defaults */
  resetFilters: () => void;
  /** Refetch task list from API */
  refetch: () => void;
  /** Cursor for the next page, if one is available */
  nextCursor: string | null;
  /** Whether another page of tasks is available */
  hasNextPage: boolean;
  /** Append the next page of tasks */
  loadMore: () => void;
  /** IDs of the (up to 2) tasks selected for comparison */
  selectedIds: [string | null, string | null];
  /** Toggle a task's selection for comparison; deselects oldest if >2 */
  toggleSelect: (taskId: string) => void;
  /** Clear the comparison selection */
  clearSelection: () => void;
  /** Whether comparison mode is active (both slots filled) */
  isComparing: boolean;
  /** Available agent types derived from the full task list */
  availableAgentTypes: string[];
}

export function useTaskHistory(
  filters: TaskHistoryFilters,
  updateFilters: (next: Partial<TaskHistoryFilters>) => void,
  resetFilters: () => void,
  pageSize: number = DEFAULT_TASK_PAGE_SIZE
): UseTaskHistoryResult {
  const [allTasks, setAllTasks] = useState<TaskResponse[]>([]);
  const [loading, setLoading] = useState(true);
  const [isFetchingNextPage, setIsFetchingNextPage] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedIds, setSelectedIds] = useState<[string | null, string | null]>([
    null,
    null,
  ]);
  // Cursor state for incremental loading
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [hasNextPage, setHasNextPage] = useState(false);

  const fetchTasks = useCallback(async (cursor?: string | null) => {
    setLoading(true);
    setIsFetchingNextPage(!!cursor);
    setError(null);
    try {
      // Read through the shared session layer (#477) so this stays in step with
      // WalletContext after the move from localStorage to sessionStorage.
      const walletAddress = readWalletSession()?.publicKey ?? '';

      if (!walletAddress) {
        setAllTasks([]);
        return;
      }

      // Build cursor-based query params
      const qs = new URLSearchParams({ limit: String(pageSize) });
      if (cursor) qs.set('cursor', cursor);
      if (filters.status && filters.status !== 'all') qs.set('status', filters.status);

      const url = `/api/wallets/${walletAddress}/tasks?${qs.toString()}`;

      // Try v2 cursor envelope first, with a flat-array compatibility fallback.
      let fetchedTasks: TaskResponse[] = [];
      let newCursor: string | null = null;
      let morePages = false;
      let envelope: CursorPageEnvelope<TaskResponse> | TaskResponse[] | undefined;
      let useFallback = false;

      try {
        envelope = await apiClient.get<CursorPageEnvelope<TaskResponse> | TaskResponse[]>(url);
      } catch (err) {
        if (err instanceof ApiError && err.statusCode === 404) {
          useFallback = true;
        } else {
          throw err;
        }
      }

      if (!useFallback && Array.isArray(envelope)) {
        fetchedTasks = envelope;
      } else if (
        !useFallback &&
        envelope &&
        !Array.isArray(envelope) &&
        Array.isArray(envelope.data?.items) &&
        envelope.data.pagination &&
        typeof envelope.data.pagination.hasNextPage === 'boolean' &&
        (typeof envelope.data.pagination.nextCursor === 'string' ||
          envelope.data.pagination.nextCursor === null)
      ) {
        fetchedTasks = envelope.data.items;
        newCursor = envelope.data.pagination.nextCursor;
        morePages = envelope.data.pagination.hasNextPage;
      } else {
        useFallback = true;
      }

      if (useFallback) {
        // Retry without the cursor only for a missing endpoint or incompatible response shape.
        qs.delete('cursor');
        const fallback = await apiClient.get<TaskResponse[]>(
          `/api/wallets/${walletAddress}/tasks?${qs.toString()}`
        );
        fetchedTasks = Array.isArray(fallback) ? fallback : [];
      }

      setAllTasks((prev) => (cursor ? mergeTaskPages(prev, fetchedTasks) : fetchedTasks));
      setNextCursor(newCursor);
      setHasNextPage(morePages);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load task history');
    } finally {
      setLoading(false);
      setIsFetchingNextPage(false);
    }
  }, [filters.status, pageSize]);

  useEffect(() => {
    // `fetchTasks` is recreated only when `filters.status` changes, so this
    // effect fetches exactly once on mount and refetches exactly once per
    // status change. Non-status filters are applied client-side and never
    // trigger a new request.
    setAllTasks([]);
    setNextCursor(null);
    setHasNextPage(false);
    fetchTasks(null);
  }, [fetchTasks]);

  const refetch = useCallback(() => {
    setAllTasks([]);
    setNextCursor(null);
    setHasNextPage(false);
    fetchTasks(null);
  }, [fetchTasks]);

  const loadMore = useCallback(() => {
    if (!loading && hasNextPage && nextCursor) fetchTasks(nextCursor);
  }, [fetchTasks, hasNextPage, loading, nextCursor]);

  // Derive filtered + zoomed list
  const filteredTasks = useMemo(() => {
    const afterFilter = allTasks.filter((t) => taskMatchesFilters(t, filters));
    if (!filters.dateFrom && !filters.dateTo) {
      return applyZoom(afterFilter, filters.zoom).sort(
        (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
      );
    }
    return afterFilter.sort(
      (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
    );
  }, [allTasks, filters]);

  const availableAgentTypes = useMemo(() => {
    const types = new Set<string>();
    allTasks.forEach((t) => getTaskAgentTypes(t).forEach((k) => types.add(k)));
    return Array.from(types).sort();
  }, [allTasks]);

  const toggleSelect = useCallback((taskId: string) => {
    setSelectedIds((prev) => {
      const [a, b] = prev;
      if (a === taskId) return [b, null];
      if (b === taskId) return [a, null];
      if (a === null) return [taskId, b];
      if (b === null) return [a, taskId];
      return [b, taskId];
    });
  }, []);

  const clearSelection = useCallback(() => {
    setSelectedIds([null, null]);
  }, []);

  const isComparing = selectedIds[0] !== null && selectedIds[1] !== null;

  return {
    allTasks,
    filteredTasks,
    loading,
    isFetchingNextPage,
    error,
    filters,
    updateFilters,
    resetFilters,
    refetch,
    nextCursor,
    hasNextPage,
    loadMore,
    selectedIds,
    toggleSelect,
    clearSelection,
    isComparing,
    availableAgentTypes,
  };
}
