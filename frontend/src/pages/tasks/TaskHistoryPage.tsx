import React, { useCallback, useMemo } from 'react';
import { useSearchParams } from 'react-router-dom';
import { History, ArrowLeftRight, X } from 'lucide-react';
import {
  useTaskHistory,
  filtersFromSearchParams,
  filtersToSearchParams,
  type TaskHistoryFilters,
} from '../../hooks/useTaskHistory';
import { TaskFilterBar } from '../../components/tasks/TaskFilterBar';
import { TaskTimeline } from '../../components/tasks/TaskTimeline';
import { TaskComparison } from '../../components/tasks/TaskComparison';
import styles from './TaskHistoryPage.module.css';

const TaskHistoryPage: React.FC = () => {
  const [searchParams, setSearchParams] = useSearchParams();

  // Derive filters from URL so the view is shareable / bookmarkable
  const filters = useMemo(
    () => filtersFromSearchParams(searchParams),
    [searchParams]
  );

  const updateFilters = useCallback(
    (next: Partial<TaskHistoryFilters>) => {
      const merged = { ...filters, ...next };
      setSearchParams(filtersToSearchParams(merged), { replace: true });
    },
    [filters, setSearchParams]
  );

  const resetFilters = useCallback(() => {
    setSearchParams({}, { replace: true });
  }, [setSearchParams]);

  const {
    allTasks,
    filteredTasks,
    loading,
    error,
    refetch,
    selectedIds,
    toggleSelect,
    clearSelection,
    isComparing,
    availableAgentTypes,
  } = useTaskHistory(filters, updateFilters, resetFilters);

  // Resolve the two selected tasks for the comparison panel
  const taskA = useMemo(
    () => allTasks.find((t) => (t.taskId || t.id) === selectedIds[0]) ?? null,
    [allTasks, selectedIds]
  );
  const taskB = useMemo(
    () => allTasks.find((t) => (t.taskId || t.id) === selectedIds[1]) ?? null,
    [allTasks, selectedIds]
  );

  const hasFilters =
    filters.status !== 'all' ||
    filters.agentType !== 'all' ||
    !!filters.dateFrom ||
    !!filters.dateTo ||
    !!filters.search;

  return (
    <div className={styles.page}>
      {/* Page header */}
      <div className={styles.header}>
        <div className={styles.headerLeft}>
          <History size={22} className={styles.headerIcon} aria-hidden="true" />
          <div>
            <h1 className={styles.title}>Task History</h1>
            <p className={styles.subtitle}>
              {loading
                ? 'Loading…'
                : `${filteredTasks.length} of ${allTasks.length} task${
                    allTasks.length === 1 ? '' : 's'
                  }`}
            </p>
          </div>
        </div>

        {/* Comparison hint / banner */}
        {(selectedIds[0] !== null || selectedIds[1] !== null) && (
          <div className={styles.selectionBanner} role="status">
            <ArrowLeftRight size={15} aria-hidden="true" />
            <span>
              {selectedIds[0] !== null && selectedIds[1] !== null
                ? 'Ready to compare — click Compare'
                : `${selectedIds[0] !== null || selectedIds[1] !== null ? 1 : 0} of 2 tasks selected`}
            </span>

            {isComparing && (
              <button
                type="button"
                className={styles.compareBtn}
                onClick={() => {
                  /* comparison panel opens automatically when isComparing && taskA && taskB */
                }}
                aria-label="View comparison panel"
              >
                Compare
              </button>
            )}

            <button
              type="button"
              className={styles.clearBtn}
              onClick={clearSelection}
              aria-label="Clear selection"
            >
              <X size={13} />
              Clear
            </button>
          </div>
        )}
      </div>

      {/* Error state */}
      {error && !loading && (
        <div className={styles.errorBox} role="alert">
          <p>Failed to load task history: {error}</p>
          <button type="button" className={styles.retryButton} onClick={refetch}>
            Retry
          </button>
        </div>
      )}

      {/* Filter bar */}
      <TaskFilterBar
        filters={filters}
        availableAgentTypes={availableAgentTypes}
        onChange={updateFilters}
        onReset={resetFilters}
        onRefresh={refetch}
        totalCount={allTasks.length}
        filteredCount={filteredTasks.length}
      />

      {/* Timeline */}
      <TaskTimeline
        tasks={filteredTasks}
        loading={loading}
        selectedIds={selectedIds}
        onToggleSelect={toggleSelect}
        isComparing={isComparing}
        hasFilters={hasFilters}
      />

      {/* Comparison panel — shown when both tasks selected */}
      {isComparing && taskA && taskB && (
        <TaskComparison taskA={taskA} taskB={taskB} onClose={clearSelection} />
      )}
    </div>
  );
};

export default TaskHistoryPage;
