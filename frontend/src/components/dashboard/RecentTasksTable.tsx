// src/components/dashboard/RecentTasksTable.tsx
import React from 'react';
import { useTranslation } from 'react-i18next';
import { Skeleton } from '../common/Skeleton';
import styles from './RecentTasksTable.module.css';
import { getRecentTasks } from '@services/api';
import { useToast } from '../../context/ToastContext';
import type { TaskResponse } from '../../types/api';
import { formatDateTime } from '../../utils/format';

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

  return (
    <table className={styles.table}>
      <thead>
        <tr>
          <th>{t('dashboard.recentTasks.taskId')}</th>
          <th>{t('common.status')}</th>
          <th>{t('dashboard.recentTasks.created')}</th>
          <th>{t('dashboard.recentTasks.action')}</th>
        </tr>
      </thead>
      <tbody>
        {tasks.map((task) => {
          const taskId = task.id || task.taskId;
          return (
            <tr key={taskId}>
              <td>{taskId.slice(0, 8)}…</td>
              <td className={styles[task.status.toLowerCase()] || styles.default}>{task.status}</td>
              <td>{formatDateTime(task.createdAt, i18n.language)}</td>
              <td>
                <a href={`/tasks/${taskId}`} className={styles.viewLink}>{t('dashboard.recentTasks.view')}</a>
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
};
