import { useEffect, useState, type ReactNode } from 'react';
import type { TaskResponse } from '../../types/api';
import { getVirtualRange, shouldFetchNextPage } from '../../hooks/useTaskHistory';

export interface TaskListProps {
  tasks: TaskResponse[];
  renderRow: (task: TaskResponse) => ReactNode;
  rowHeight?: number;
  height?: number;
  hasNextPage: boolean;
  isFetchingNextPage: boolean;
  fetchNextPage: () => void;
}

/**
 * Virtualised task list (#816): renders only the visible rows ± 5 overscan and
 * asks for the next cursor page when scrolled near the bottom.
 */
export function TaskList({
  tasks,
  renderRow,
  rowHeight = 64,
  height = 600,
  hasNextPage,
  isFetchingNextPage,
  fetchNextPage,
}: TaskListProps) {
  const [scrollTop, setScrollTop] = useState(0);
  const range = getVirtualRange(scrollTop, height, rowHeight, tasks.length);

  useEffect(() => {
    if (
      hasNextPage &&
      !isFetchingNextPage &&
      shouldFetchNextPage(scrollTop, height, range.totalHeight)
    ) {
      fetchNextPage();
    }
  }, [scrollTop, height, range.totalHeight, hasNextPage, isFetchingNextPage, fetchNextPage]);

  return (
    <div
      role="list"
      aria-busy={isFetchingNextPage || undefined}
      style={{ height, overflowY: 'auto' }}
      onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}
    >
      <div style={{ height: range.totalHeight, position: 'relative' }}>
        <div style={{ transform: `translateY(${range.offsetTop}px)` }}>
          {tasks.slice(range.start, range.end).map((task) => (
            <div role="listitem" key={task.taskId} style={{ height: rowHeight }}>
              {renderRow(task)}
            </div>
          ))}
        </div>
      </div>
      {isFetchingNextPage && (
        <div role="status" style={{ padding: 'var(--space-3)', textAlign: 'center' }}>
          Loading more tasks…
        </div>
      )}
    </div>
  );
}

export default TaskList;
