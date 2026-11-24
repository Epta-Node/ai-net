import React from 'react';
import { RefreshCw } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { EmptyState } from '../common/EmptyState';
import styles from './DashboardPanel.module.css';

interface DashboardPanelProps {
  loading: boolean;
  error?: Error | string | null;
  onRetry?: () => void;
  empty?: boolean;
  emptyTitle: string;
  emptyDescription: string;
  children: React.ReactNode;
  loadingContent?: React.ReactNode;
}

export const DashboardPanel: React.FC<DashboardPanelProps> = ({
  loading,
  error,
  onRetry,
  empty = false,
  emptyTitle,
  emptyDescription,
  children,
  loadingContent,
}) => {
  const { t } = useTranslation();
  if (loading)
    return (
      <div className={styles.panel} aria-busy="true">
        {loadingContent ?? <div className={styles.loading} />}
      </div>
    );
  if (error) {
    const message = error instanceof Error ? error.message : error;
    return (
      <div className={styles.panel} role="alert">
        <p className={styles.error}>{message || t('page.dashboard.unknownError')}</p>
        {onRetry && (
          <button type="button" className={styles.retry} onClick={onRetry}>
            <RefreshCw size={14} />
            {t('common.retry')}
          </button>
        )}
      </div>
    );
  }
  if (empty) {
    return (
      <div className={styles.panel}>
        <EmptyState
          title={emptyTitle}
          description={emptyDescription}
          variant="compact"
          headingLevel={2}
        />
      </div>
    );
  }
  return (
    <div className={styles.panel} data-testid="dashboard-panel">
      {children}
    </div>
  );
};
