import React from 'react';
import { RotateCw, X, Search, Calendar } from 'lucide-react';
import type { TaskHistoryFilters, ZoomLevel } from '../../hooks/useTaskHistory';
import type { NodeStatus } from '../../types/api';
import styles from './TaskFilterBar.module.css';

interface TaskFilterBarProps {
  filters: TaskHistoryFilters;
  availableAgentTypes: string[];
  onChange: (next: Partial<TaskHistoryFilters>) => void;
  onReset: () => void;
  onRefresh: () => void;
  totalCount: number;
  filteredCount: number;
}

const STATUS_OPTIONS: { value: NodeStatus | 'all'; label: string; color: string }[] = [
  { value: 'all', label: 'All', color: '' },
  { value: 'pending', label: 'Pending', color: 'amber' },
  { value: 'running', label: 'Running', color: 'indigo' },
  { value: 'completed', label: 'Completed', color: 'emerald' },
  { value: 'failed', label: 'Failed', color: 'rose' },
];

const ZOOM_OPTIONS: { value: ZoomLevel; label: string }[] = [
  { value: 'day', label: 'Today' },
  { value: 'week', label: 'This Week' },
  { value: 'month', label: 'This Month' },
];

const AGENT_LABELS: Record<string, string> = {
  research: 'Research',
  risk: 'Risk',
  coding: 'Coding',
  design: 'Design',
  report: 'Report',
};

export const TaskFilterBar: React.FC<TaskFilterBarProps> = ({
  filters,
  availableAgentTypes,
  onChange,
  onReset,
  onRefresh,
  totalCount,
  filteredCount,
}) => {
  const hasActiveFilters =
    filters.status !== 'all' ||
    filters.agentType !== 'all' ||
    !!filters.dateFrom ||
    !!filters.dateTo ||
    !!filters.search;

  const handleSearchChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    onChange({ search: e.target.value });
  };

  const clearSearch = () => onChange({ search: '' });

  return (
    <div className={styles.bar} role="search" aria-label="Task history filters">
      {/* Search box */}
      <div className={styles.searchGroup}>
        <Search size={14} className={styles.searchIcon} aria-hidden="true" />
        <input
          type="search"
          className={styles.searchInput}
          placeholder="Search tasks…"
          value={filters.search}
          onChange={handleSearchChange}
          aria-label="Search tasks by prompt or ID"
        />
        {filters.search && (
          <button
            type="button"
            className={styles.clearSearch}
            onClick={clearSearch}
            aria-label="Clear search"
          >
            <X size={12} />
          </button>
        )}
      </div>

      {/* Status filter */}
      <div className={styles.group}>
        <span className={styles.groupLabel}>Status</span>
        <div className={styles.toggle} role="group" aria-label="Filter by task status">
          {STATUS_OPTIONS.map((opt) => (
            <button
              key={opt.value}
              type="button"
              className={`${styles.toggleButton} ${
                filters.status === opt.value
                  ? styles[`toggleButton_${opt.color || 'active'}`] || styles.toggleButtonActive
                  : ''
              }`}
              aria-pressed={filters.status === opt.value}
              onClick={() => onChange({ status: opt.value })}
            >
              {opt.color && (
                <span
                  className={styles.statusDot}
                  style={{ background: `var(--status-${opt.color})` }}
                  aria-hidden="true"
                />
              )}
              {opt.label}
            </button>
          ))}
        </div>
      </div>

      {/* Agent type filter */}
      {availableAgentTypes.length > 0 && (
        <div className={styles.group}>
          <span className={styles.groupLabel}>Agent</span>
          <div className={styles.capList} role="group" aria-label="Filter by agent type">
            <button
              type="button"
              className={`${styles.capChip} ${
                filters.agentType === 'all' ? styles.capChipActive : ''
              }`}
              aria-pressed={filters.agentType === 'all'}
              onClick={() => onChange({ agentType: 'all' })}
            >
              All
            </button>
            {availableAgentTypes.map((type) => (
              <button
                key={type}
                type="button"
                className={`${styles.capChip} ${
                  filters.agentType === type ? styles.capChipActive : ''
                }`}
                aria-pressed={filters.agentType === type}
                onClick={() => onChange({ agentType: type })}
              >
                {AGENT_LABELS[type] ?? type}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Date range */}
      <div className={styles.group}>
        <span className={styles.groupLabel}>
          <Calendar size={11} aria-hidden="true" style={{ display: 'inline', marginRight: 4 }} />
          Date Range
        </span>
        <div className={styles.dateRange}>
          <input
            type="date"
            className={styles.dateInput}
            value={filters.dateFrom}
            max={filters.dateTo || undefined}
            aria-label="Start date"
            onChange={(e) => onChange({ dateFrom: e.target.value })}
          />
          <span className={styles.dateSep}>–</span>
          <input
            type="date"
            className={styles.dateInput}
            value={filters.dateTo}
            min={filters.dateFrom || undefined}
            aria-label="End date"
            onChange={(e) => onChange({ dateTo: e.target.value })}
          />
        </div>
      </div>

      {/* Zoom */}
      <div className={styles.group}>
        <span className={styles.groupLabel}>Zoom</span>
        <div className={styles.toggle} role="group" aria-label="Timeline zoom level">
          {ZOOM_OPTIONS.map((opt) => (
            <button
              key={opt.value}
              type="button"
              className={`${styles.toggleButton} ${
                filters.zoom === opt.value ? styles.toggleButtonActive : ''
              }`}
              aria-pressed={filters.zoom === opt.value}
              onClick={() => onChange({ zoom: opt.value, dateFrom: '', dateTo: '' })}
            >
              {opt.label}
            </button>
          ))}
        </div>
      </div>

      {/* Actions + count */}
      <div className={styles.actions}>
        <span className={styles.count} aria-live="polite">
          {filteredCount} / {totalCount}
        </span>

        <button
          type="button"
          className={styles.iconAction}
          onClick={onRefresh}
          title="Refresh"
          aria-label="Refresh task list"
        >
          <RotateCw size={14} />
        </button>

        {hasActiveFilters && (
          <button type="button" className={styles.resetButton} onClick={onReset}>
            <X size={14} />
            Clear
          </button>
        )}
      </div>
    </div>
  );
};
