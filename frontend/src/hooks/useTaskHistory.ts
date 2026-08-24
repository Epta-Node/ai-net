import { useState, useEffect, useCallback, useMemo } from 'react';
import type { TaskResponse, NodeStatus } from '../types/api';
import { apiClient } from '../services/api';

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
  error: string | null;
  /** Currently applied filters */
  filters: TaskHistoryFilters;
  /** Update one or more filter fields */
  updateFilters: (next: Partial<TaskHistoryFilters>) => void;
  /** Reset all filters to defaults */
  resetFilters: () => void;
  /** Refetch task list from API */
  refetch: () => void;
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
  resetFilters: () => void
): UseTaskHistoryResult {
  const [allTasks, setAllTasks] = useState<TaskResponse[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedIds, setSelectedIds] = useState<[string | null, string | null]>([
    null,
    null,
  ]);

  const fetchTasks = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const walletAddress =
        localStorage.getItem('wallet_pubkey') ||
        localStorage.getItem('walletAddress') ||
        '';

      let tasks: TaskResponse[] = [];
      if (walletAddress) {
        tasks = await apiClient.get<TaskResponse[]>(
          `/api/wallets/${walletAddress}/tasks?limit=200`
        );
      } else {
        // Fallback: try generic tasks endpoint
        tasks = await apiClient.get<TaskResponse[]>('/api/tasks?limit=200');
      }
      setAllTasks(Array.isArray(tasks) ? tasks : []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load task history');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchTasks();
  }, [fetchTasks]);

  // Derive filtered + zoomed list
  const filteredTasks = useMemo(() => {
    const afterFilter = allTasks.filter((t) => taskMatchesFilters(t, filters));
    // Only apply zoom when no explicit date range is set
    if (!filters.dateFrom && !filters.dateTo) {
      return applyZoom(afterFilter, filters.zoom).sort(
        (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
      );
    }
    return afterFilter.sort(
      (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
    );
  }, [allTasks, filters]);

  // Available agent types for filter dropdown
  const availableAgentTypes = useMemo(() => {
    const types = new Set<string>();
    allTasks.forEach((t) => getTaskAgentTypes(t).forEach((k) => types.add(k)));
    return Array.from(types).sort();
  }, [allTasks]);

  const toggleSelect = useCallback((taskId: string) => {
    setSelectedIds((prev) => {
      const [a, b] = prev;
      // Deselect if already selected
      if (a === taskId) return [b, null];
      if (b === taskId) return [a, null];
      // Fill first empty slot
      if (a === null) return [taskId, b];
      if (b === null) return [a, taskId];
      // Both slots filled: replace oldest (a) with new
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
    error,
    filters,
    updateFilters,
    resetFilters,
    refetch: fetchTasks,
    selectedIds,
    toggleSelect,
    clearSelection,
    isComparing,
    availableAgentTypes,
  };
}
