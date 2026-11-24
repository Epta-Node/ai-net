// src/components/dashboard/RecentTasksTable.tsx
import React from 'react';
import { useTranslation } from 'react-i18next';
import { SkeletonTable } from '../common/Skeleton';
import styles from './RecentTasksTable.module.css';
import type { TaskResponse } from '../../types/api';
import { formatDateTime } from '../../utils/format';
import { DataTable, type DataTableColumn } from '../common/DataTable';

import { Layers, Plus } from 'lucide-react';
import { EmptyState } from '../common/EmptyState';

interface Props {
  walletAddress: string;
  loading: boolean;
}

export const RecentTasksTable: React.FC<Props> = ({ walletAddress, loading }) => {
  const [tasks] = React.useState<TaskResponse[]>([]);
  const { t, i18n } = useTranslation();

  if (loading) {
    return (
      <div className={styles.table}>
        <SkeletonTable rows={5} columns={4} />
      </div>
    );
  }

  const renderEmptyState = () => (
    <EmptyState
      icon={<Layers size={28} />}
      title={t('dashboard.recentTasks.empty')}
      description="Submit a new multi-agent task to begin orchestration on the AI Network."
      primaryAction={{
        label: t('landing.hero.startTask', { defaultValue: 'Create New Task' }),
        to: '/tasks/new',
        icon: <Plus size={16} />,
      }}
      headingLevel={2}
      variant="compact"
    />
  );

  if (tasks.length === 0) {
    return renderEmptyState();
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
      emptyState={renderEmptyState()}
    />
  );
};
