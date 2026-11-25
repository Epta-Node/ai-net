import React from 'react';
import { useTranslation } from 'react-i18next';
import { Skeleton, SkeletonCard, SkeletonTable } from '../../common/Skeleton';
import styles from './AgentsPageSkeleton.module.css';

const DEFAULT_CARDS = 6;
const DEFAULT_ROWS = 5;
const SKELETON_COLUMNS = 6;
const FILTER_CHIPS = 4;

export interface AgentsPageSkeletonProps {
  /** Number of agent card placeholders in the grid. */
  cards?: number;
  /** Number of placeholder rows in the agent table. */
  rows?: number;
  className?: string;
  'data-testid'?: string;
}

/**
 * Loading placeholder for the agent registry page (#876).
 *
 * Mirrors the loaded AgentsPage structure — filter toolbar, agent card grid and
 * agent table — so the page keeps its layout while `GET /api/agents` is in
 * flight and does not shift when the data arrives. Decorative shapes inherit
 * the shimmer / reduced-motion behaviour of the shared skeleton kit.
 */
export const AgentsPageSkeleton: React.FC<AgentsPageSkeletonProps> = ({
  cards = DEFAULT_CARDS,
  rows = DEFAULT_ROWS,
  className,
  'data-testid': testId = 'agents-page-skeleton',
}) => {
  const { t } = useTranslation();

  return (
    <div
      className={[styles.skeleton, className].filter(Boolean).join(' ')}
      data-testid={testId}
      role="status"
      aria-busy="true"
      aria-label={t('a11y.loadingAgentRegistry')}
    >
      <div className={styles.filterBar}>
        <Skeleton variant="rect" width="100%" height="2.5rem" />
        <div className={styles.chipRow}>
          {Array.from({ length: FILTER_CHIPS }, (_, i) => (
            <Skeleton key={i} variant="pill" width="5rem" height="1.75rem" />
          ))}
        </div>
        <div className={styles.filterRow}>
          <Skeleton width="7rem" height="0.75rem" />
          <Skeleton width="10rem" height="0.5rem" />
        </div>
      </div>

      <div className={styles.cardGrid}>
        {Array.from({ length: cards }, (_, i) => (
          <SkeletonCard key={i} data-testid="agents-skeleton-card">
            <div className={styles.cardContent}>
              <div className={styles.cardHeader}>
                <Skeleton variant="circular" width="2.5rem" height="2.5rem" />
                <div className={styles.cardTitle}>
                  <Skeleton width="60%" height="1rem" />
                  <Skeleton width="40%" height="0.75rem" />
                </div>
              </div>
              <div className={styles.chipRow}>
                <Skeleton variant="pill" width="4rem" height="1.25rem" />
                <Skeleton variant="pill" width="5rem" height="1.25rem" />
              </div>
              <Skeleton width="45%" height="1.25rem" />
            </div>
          </SkeletonCard>
        ))}
      </div>

      <div className={styles.table}>
        <div className={styles.tableHeaderRow} aria-hidden="true">
          {Array.from({ length: SKELETON_COLUMNS }, (_, i) => (
            <Skeleton key={i} height="1rem" />
          ))}
        </div>
        <SkeletonTable rows={rows} columns={SKELETON_COLUMNS} rowTestId="agents-skeleton-row" />
      </div>
    </div>
  );
};

export default AgentsPageSkeleton;
