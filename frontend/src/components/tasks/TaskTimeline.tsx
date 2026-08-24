import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  CheckCircle2,
  XCircle,
  Clock,
  Loader2,
  ChevronDown,
  ChevronRight,
  ExternalLink,
  AlertCircle,
} from 'lucide-react';
import type { TaskResponse } from '../../types/api';
import {
  getTaskDuration,
  getTaskCost,
  getTaskAgentTypes,
  formatDuration,
} from '../../hooks/useTaskHistory';
import styles from './TaskTimeline.module.css';

// ─── Agent icon colours ───────────────────────────────────────────────────────

const AGENT_COLORS: Record<string, string> = {
  research: '#38bdf8', // cyan
  risk: '#f59e0b',     // amber
  coding: '#a78bfa',   // violet
  design: '#f472b6',   // pink
  report: '#34d399',   // green
};

const AGENT_ABBR: Record<string, string> = {
  research: 'RE',
  risk: 'RI',
  coding: 'CO',
  design: 'DE',
  report: 'RP',
};

// ─── Status helpers ───────────────────────────────────────────────────────────

interface StatusMeta {
  icon: React.ReactNode;
  dotClass: string;
  badgeClass: string;
  label: string;
}

function getStatusMeta(status: TaskResponse['status']): StatusMeta {
  switch (status) {
    case 'completed':
      return {
        icon: <CheckCircle2 size={14} />,
        dotClass: styles.dotCompleted,
        badgeClass: styles.badgeCompleted,
        label: 'Completed',
      };
    case 'failed':
      return {
        icon: <XCircle size={14} />,
        dotClass: styles.dotFailed,
        badgeClass: styles.badgeFailed,
        label: 'Failed',
      };
    case 'running':
      return {
        icon: <Loader2 size={14} className={styles.spinIcon} />,
        dotClass: styles.dotRunning,
        badgeClass: styles.badgeRunning,
        label: 'Running',
      };
    default:
      return {
        icon: <Clock size={14} />,
        dotClass: styles.dotPending,
        badgeClass: styles.badgePending,
        label: 'Pending',
      };
  }
}

// ─── Execution bar ────────────────────────────────────────────────────────────

interface ExecutionBarProps {
  task: TaskResponse;
}

const ExecutionBar: React.FC<ExecutionBarProps> = ({ task }) => {
  if (!task.dag || task.dag.length === 0) return null;

  const total = task.dag.length;
  const width = 100 / total;

  return (
    <div className={styles.execBar} role="img" aria-label="Node execution status breakdown">
      {task.dag.map((node, i) => {
        let cls = styles.execSegmentPending;
        if (node.status === 'completed') cls = styles.execSegmentCompleted;
        else if (node.status === 'running') cls = styles.execSegmentRunning;
        else if (node.status === 'failed') cls = styles.execSegmentFailed;

        return (
          <div
            key={node.nodeId || i}
            className={`${styles.execSegment} ${cls}`}
            style={{ width: `${width}%` }}
            title={`${node.agentType || node.nodeId}: ${node.status}`}
          />
        );
      })}
    </div>
  );
};

// ─── Single timeline entry ────────────────────────────────────────────────────

interface TimelineEntryProps {
  task: TaskResponse;
  isSelected: boolean;
  selectionIndex: 0 | 1 | null;
  onToggleSelect: (id: string) => void;
  isComparing: boolean;
}

const TimelineEntry: React.FC<TimelineEntryProps> = ({
  task,
  isSelected,
  selectionIndex,
  onToggleSelect,
  isComparing,
}) => {
  const navigate = useNavigate();
  const [errorExpanded, setErrorExpanded] = useState(false);

  const taskId = task.taskId || task.id || '';
  const meta = getStatusMeta(task.status);
  const duration = getTaskDuration(task);
  const cost = getTaskCost(task);
  const agentTypes = getTaskAgentTypes(task);
  const hasFailed = task.status === 'failed';

  // Find error details from the DAG
  const failedNodes = task.dag?.filter((n) => n.status === 'failed') ?? [];

  const date = new Date(task.createdAt);
  const dateStr = date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  const timeStr = date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });

  const handleSelect = (e: React.MouseEvent) => {
    e.stopPropagation();
    onToggleSelect(taskId);
  };

  const handleNavigate = () => {
    navigate(`/tasks/${taskId}`);
  };

  return (
    <div
      className={`${styles.entry} ${isSelected ? styles.entrySelected : ''} ${
        hasFailed ? styles.entryFailed : ''
      }`}
      aria-selected={isSelected}
    >
      {/* Timeline connector */}
      <div className={styles.connectorArea}>
        <div className={`${styles.dot} ${meta.dotClass}`} aria-hidden="true">
          {meta.icon}
        </div>
        <div className={styles.line} aria-hidden="true" />
      </div>

      {/* Card body */}
      <div className={styles.card}>
        {/* Header row */}
        <div className={styles.cardHeader}>
          <div className={styles.cardHeaderLeft}>
            {/* Selection checkbox */}
            <button
              type="button"
              className={`${styles.selectBtn} ${isSelected ? styles.selectBtnActive : ''}`}
              onClick={handleSelect}
              aria-label={isSelected ? 'Deselect task for comparison' : 'Select task for comparison'}
              title={
                isSelected
                  ? 'Deselect'
                  : isComparing && !isSelected
                  ? 'Replace one selection to compare'
                  : 'Select to compare'
              }
            >
              {isSelected && selectionIndex !== null ? (
                <span className={styles.selectIndex}>{selectionIndex + 1}</span>
              ) : (
                <span className={styles.selectEmpty} />
              )}
            </button>

            {/* Prompt / title */}
            <div className={styles.taskTitle}>
              <span className={styles.taskPrompt} title={task.prompt}>
                {task.prompt?.length > 80
                  ? `${task.prompt.slice(0, 80)}…`
                  : task.prompt}
              </span>
              <span className={styles.taskId}>#{taskId.slice(-8)}</span>
            </div>
          </div>

          <div className={styles.cardHeaderRight}>
            {/* Status badge */}
            <span className={`${styles.badge} ${meta.badgeClass}`} aria-label={`Status: ${meta.label}`}>
              {meta.icon}
              {meta.label}
            </span>

            {/* Date */}
            <span className={styles.dateLabel}>
              {dateStr} <span className={styles.timeLabel}>{timeStr}</span>
            </span>

            {/* Navigate to detail */}
            <button
              type="button"
              className={styles.detailBtn}
              onClick={handleNavigate}
              aria-label="View task detail"
              title="View task detail"
            >
              <ExternalLink size={13} />
            </button>
          </div>
        </div>

        {/* Execution bar */}
        <ExecutionBar task={task} />

        {/* Meta row: agents, duration, cost */}
        <div className={styles.metaRow}>
          {agentTypes.length > 0 && (
            <div className={styles.agentIcons} aria-label="Agents used">
              {agentTypes.map((type) => (
                <span
                  key={type}
                  className={styles.agentBadge}
                  style={{
                    background: `${AGENT_COLORS[type] || '#94a3b8'}22`,
                    border: `1px solid ${AGENT_COLORS[type] || '#94a3b8'}44`,
                    color: AGENT_COLORS[type] || '#94a3b8',
                  }}
                  title={type}
                  aria-label={`${type} agent`}
                >
                  {AGENT_ABBR[type] || type.slice(0, 2).toUpperCase()}
                </span>
              ))}
            </div>
          )}

          <div className={styles.stats}>
            {duration !== undefined && (
              <span className={styles.stat} title="Duration">
                <Clock size={11} aria-hidden="true" />
                {formatDuration(duration)}
              </span>
            )}
            {cost > 0 && (
              <span className={styles.stat} title="Estimated cost">
                <span aria-hidden="true">◎</span>
                {cost.toFixed(2)} XLM
              </span>
            )}
          </div>
        </div>

        {/* Failed node error expander */}
        {hasFailed && failedNodes.length > 0 && (
          <div className={styles.errorSection}>
            <button
              type="button"
              className={styles.errorToggle}
              onClick={() => setErrorExpanded((p) => !p)}
              aria-expanded={errorExpanded}
              aria-controls={`error-${taskId}`}
            >
              <AlertCircle size={13} className={styles.errorIcon} aria-hidden="true" />
              <span>{failedNodes.length} node{failedNodes.length > 1 ? 's' : ''} failed</span>
              {errorExpanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
            </button>

            {errorExpanded && (
              <div id={`error-${taskId}`} className={styles.errorDetails}>
                {failedNodes.map((node) => (
                  <div key={node.nodeId} className={styles.errorItem}>
                    <span className={styles.errorNodeId}>
                      {node.nodeId.replace(/^node[_-]/, '')}
                    </span>
                    <span className={styles.errorMsg}>
                      {node.error || 'Unknown error'}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
};

// ─── Date separator ───────────────────────────────────────────────────────────

interface DateBucketProps {
  label: string;
}

const DateBucket: React.FC<DateBucketProps> = ({ label }) => (
  <div className={styles.dateBucket} aria-label={`Tasks for ${label}`}>
    <div className={styles.dateBucketLine} aria-hidden="true" />
    <span className={styles.dateBucketLabel}>{label}</span>
    <div className={styles.dateBucketLine} aria-hidden="true" />
  </div>
);

// ─── Group tasks by bucket ────────────────────────────────────────────────────

function getBucketLabel(date: Date): string {
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const taskDay = new Date(
    date.getFullYear(),
    date.getMonth(),
    date.getDate()
  ).getTime();
  const diff = today - taskDay;

  if (diff === 0) return 'Today';
  if (diff === 86_400_000) return 'Yesterday';
  if (diff < 7 * 86_400_000) {
    return date.toLocaleDateString(undefined, { weekday: 'long' });
  }
  return date.toLocaleDateString(undefined, { month: 'long', day: 'numeric', year: 'numeric' });
}

// ─── Empty state ──────────────────────────────────────────────────────────────

const EmptyState: React.FC<{ hasFilters: boolean }> = ({ hasFilters }) => (
  <div className={styles.empty}>
    <Clock size={40} className={styles.emptyIcon} aria-hidden="true" />
    <p className={styles.emptyTitle}>
      {hasFilters ? 'No tasks match the current filters' : 'No task history yet'}
    </p>
    <p className={styles.emptySubtitle}>
      {hasFilters
        ? 'Try adjusting the filters or expanding the zoom window.'
        : 'Submit a task to see it appear here.'}
    </p>
  </div>
);

// ─── Skeleton loader ──────────────────────────────────────────────────────────

const SkeletonEntry: React.FC = () => (
  <div className={styles.entry}>
    <div className={styles.connectorArea}>
      <div className={`${styles.dot} ${styles.dotSkeleton}`} aria-hidden="true" />
      <div className={styles.line} aria-hidden="true" />
    </div>
    <div className={`${styles.card} ${styles.skeletonCard}`}>
      <div className={styles.skeletonLine} style={{ width: '60%' }} />
      <div className={styles.skeletonLine} style={{ width: '40%', marginTop: 6 }} />
    </div>
  </div>
);

// ─── Main component ───────────────────────────────────────────────────────────

interface TaskTimelineProps {
  tasks: TaskResponse[];
  loading: boolean;
  selectedIds: [string | null, string | null];
  onToggleSelect: (id: string) => void;
  isComparing: boolean;
  hasFilters: boolean;
}

export const TaskTimeline: React.FC<TaskTimelineProps> = ({
  tasks,
  loading,
  selectedIds,
  onToggleSelect,
  isComparing,
  hasFilters,
}) => {
  if (loading) {
    return (
      <div className={styles.timeline} aria-busy="true" aria-label="Loading task history">
        {Array.from({ length: 5 }).map((_, i) => (
          <SkeletonEntry key={i} />
        ))}
      </div>
    );
  }

  if (tasks.length === 0) {
    return <EmptyState hasFilters={hasFilters} />;
  }

  // Group tasks by date bucket
  const buckets: { label: string; items: TaskResponse[] }[] = [];
  let currentBucket: string | null = null;

  for (const task of tasks) {
    const label = getBucketLabel(new Date(task.createdAt));
    if (label !== currentBucket) {
      buckets.push({ label, items: [] });
      currentBucket = label;
    }
    buckets[buckets.length - 1].items.push(task);
  }

  return (
    <div className={styles.timeline} role="feed" aria-label="Task history timeline">
      {buckets.map(({ label, items }) => (
        <React.Fragment key={label}>
          <DateBucket label={label} />
          {items.map((task) => {
            const taskId = task.taskId || task.id || '';
            const selIndex =
              selectedIds[0] === taskId
                ? 0
                : selectedIds[1] === taskId
                ? 1
                : null;

            return (
              <TimelineEntry
                key={taskId}
                task={task}
                isSelected={selIndex !== null}
                selectionIndex={selIndex as 0 | 1 | null}
                onToggleSelect={onToggleSelect}
                isComparing={isComparing}
              />
            );
          })}
        </React.Fragment>
      ))}
    </div>
  );
};
