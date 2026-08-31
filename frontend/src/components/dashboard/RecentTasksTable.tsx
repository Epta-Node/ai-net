// src/components/dashboard/RecentTasksTable.tsx
import React from 'react';
import { useTranslation } from 'react-i18next';
import { Skeleton } from '../common/Skeleton';
import styles from './RecentTasksTable.module.css';
import { getRecentTasks } from '@services/api';
import { useToast } from '../../hooks/useToast';
import type { TaskResponse } from '../../types/api';
import { formatDateTime } from '../../utils/format';
import { DataTable, type DataTableColumn } from '../common/DataTable';

interface Props {
  walletAddress: string;
  loading: boolean;
}

export const RecentTasksTable: React.FC<Props> = ({ walletAddress, loading }) => {
  const [tasks, setTasks] = React.useState<TaskResponse[]>([]);
  const { showToast } = useToast();
  const { t, i18n } = useTranslation();

  React.useEffect(() => {
    if (!walletAddress) return;
    const fetchTasks = async () => {
      try {
        const data = await getRecentTasks(walletAddress);
        const mappedTasks = data.map(task => ({
          ...task,
          id: task.id || task.taskId,
        }));
        setTasks(mappedTasks);
      } catch (e) {
        const message = e instanceof Error ? e.message : 'Failed to load recent tasks.';
        showToast(message, 'error');
        showToast('Failed to fetch recent tasks', 'error');
        // i18n.t (not the captured t) so the toast always uses the current
        // language without putting t in the deps, which would refetch on every
        // language change.
        showToast(i18n.t('dashboard.recentTasks.fetchError'), 'error');
        setTasks([]);
      }
    };
    fetchTasks();
  }, [walletAddress, showToast, i18n]);

  if (loading) {
    return (
      <div className={styles.table}>
        {[...Array(5)].map((_, i) => (
          <div key={i} className={styles.row}>
            <Skeleton width="20%" height="1rem" />
            <Skeleton width="30%" height="1rem" />
            <Skeleton width="30%" height="1rem" />
            <Skeleton width="15%" height="1rem" />
          </div>
        ))}
      </div>
    );
  }

  if (tasks.length === 0) {
    return <div className={styles.empty}>{t('dashboard.recentTasks.empty')}</div>;
  }

  const columns: DataTableColumn<TaskResponse>[] = [
    { key: 'id', header: t('dashboard.recentTasks.taskId'), render: (task) => <span>{(task.id || task.taskId).slice(0, 8)}…</span> },
    { key: 'status', header: t('common.status'), render: (task) => <span className={styles[task.status.toLowerCase()] || styles.default}>{task.status}</span> },
    { key: 'createdAt', header: t('dashboard.recentTasks.created'), render: (task) => <span>{formatDateTime(task.createdAt, i18n.language)}</span> },
    { key: 'action', header: t('dashboard.recentTasks.action'), render: (task) => <a href={`/tasks/${task.id || task.taskId}`} className={styles.viewLink}>{t('dashboard.recentTasks.view')}</a> },
  ];

  return (
    <DataTable
      columns={columns}
      rows={tasks}
      getRowKey={(task) => task.id || task.taskId}
      maxHeight={420}
      stickyHeader
      rowClassName={() => styles.row}
      emptyState={<div className={styles.empty}>{t('dashboard.recentTasks.empty')}</div>}
    />
  );
};
