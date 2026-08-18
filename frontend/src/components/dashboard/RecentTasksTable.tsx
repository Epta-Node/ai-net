// src/components/dashboard/RecentTasksTable.tsx
import React from 'react';
import { Skeleton } from '../common/Skeleton';
import styles from './RecentTasksTable.module.css';
import { getRecentTasks } from '@services/api';
import { useToast } from '../../hooks/useToast';
import { useToast } from '../../context/ToastContext';
import type { TaskResponse } from '../../types/api';

interface Props {
  walletAddress: string;
  loading: boolean;
}

export const RecentTasksTable: React.FC<Props> = ({ walletAddress, loading }) => {
  const [tasks, setTasks] = React.useState<TaskResponse[]>([]);
  const { showToast } = useToast();

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
        setTasks([]);
      }
    };
    fetchTasks();
  }, [walletAddress, showToast]);

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
    return <div className={styles.empty}>No recent tasks for this wallet.</div>;
  }

  return (
    <table className={styles.table}>
      <thead>
        <tr>
          <th>Task ID</th>
          <th>Status</th>
          <th>Created</th>
          <th>Action</th>
        </tr>
      </thead>
      <tbody>
        {tasks.map((task) => {
          const taskId = task.id || task.taskId;
          return (
            <tr key={taskId}>
              <td>{taskId.slice(0, 8)}…</td>
              <td className={styles[task.status.toLowerCase()] || styles.default}>{task.status}</td>
              <td>{new Date(task.createdAt).toLocaleString()}</td>
              <td>
                <a href={`/tasks/${taskId}`} className={styles.viewLink}>View</a>
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
};
