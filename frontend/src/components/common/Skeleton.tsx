// src/components/common/Skeleton.tsx
import React from 'react';
import styles from './Skeleton.module.css';

export type SkeletonVariant = 'text' | 'circle' | 'rect' | 'card' | 'pill' | 'circular' | 'rectangular';

export interface SkeletonProps {
  width?: string | number;
  height?: string | number;
  variant?: SkeletonVariant;
  animate?: boolean;
  className?: string;
  style?: React.CSSProperties;
  'data-testid'?: string;
}

const variantClass = (variant: SkeletonVariant): string => {
  switch (variant) {
    case 'pill':
      return styles.pill;
    case 'circle':
    case 'circular':
      return styles.circular;
    case 'rect':
    case 'rectangular':
      return styles.rectangular;
    case 'card':
      return styles.cardVariant;
    case 'text':
    default:
      return styles.text;
  }
};

export const Skeleton: React.FC<SkeletonProps> = ({
  width = '100%',
  height = '1rem',
  variant = 'text',
  animate = true,
  className,
  style,
  'data-testid': testId,
}) => (
  <div
    className={[styles.skeleton, variantClass(variant), !animate && styles.static, className].filter(Boolean).join(' ')}
    style={{ width, height, ...style }}
    aria-hidden="true"
    data-testid={testId}
  />
);

export interface SkeletonTextProps {
  lines?: number;
  width?: string | number;
  height?: string | number;
  /** Width of the final line, which is typically shorter to mimic prose. */
  lastLineWidth?: string | number;
  className?: string;
  'data-testid'?: string;
}

export const SkeletonText: React.FC<SkeletonTextProps> = ({
  lines = 3,
  width = '100%',
  height = '1rem',
  lastLineWidth = '60%',
  className,
  'data-testid': testId,
}) => (
  <div className={[styles.textLines, className].filter(Boolean).join(' ')} data-testid={testId}>
    {Array.from({ length: lines }, (_, i) => (
      <Skeleton
        key={i}
        width={i === lines - 1 ? lastLineWidth : width}
        height={height}
        data-testid="skeleton-text-line"
      />
    ))}
  </div>
);

export interface SkeletonCardProps {
  children?: React.ReactNode;
  className?: string;
  style?: React.CSSProperties;
  'data-testid'?: string;
}

export const SkeletonCard: React.FC<SkeletonCardProps> = ({
  children,
  className,
  style,
  'data-testid': testId,
}) => (
  <div className={[styles.card, className].filter(Boolean).join(' ')} style={style} data-testid={testId}>
    {children}
  </div>
);

export interface SkeletonAvatarProps {
  size?: number;
  className?: string;
  'data-testid'?: string;
}

export const SkeletonAvatar: React.FC<SkeletonAvatarProps> = ({
  size = 40,
  className,
  'data-testid': testId,
}) => (
  <Skeleton variant="circular" width={size} height={size} className={className} data-testid={testId} />
);

export interface SkeletonTableProps {
  rows?: number;
  columns?: number;
  className?: string;
  rowTestId?: string;
  'data-testid'?: string;
}

export const SkeletonTable: React.FC<SkeletonTableProps> = ({
  rows = 5,
  columns = 4,
  className,
  rowTestId,
  'data-testid': testId,
}) => (
  <div className={[styles.table, className].filter(Boolean).join(' ')} data-testid={testId}>
    {Array.from({ length: rows }, (_, r) => (
      <div
        key={r}
        className={styles.tableRow}
        style={{ gridTemplateColumns: `repeat(${columns}, 1fr)` }}
        data-testid={rowTestId ?? 'skeleton-table-row'}
      >
        {Array.from({ length: columns }, (_, c) => (
          <Skeleton key={c} width="100%" height="1rem" />
        ))}
      </div>
    ))}
  </div>
);

export const SkeletonDashboard: React.FC = () => (
  <div className={styles.dashboard} data-testid="skeleton-dashboard" aria-busy="true">
    <div className={styles.dashboardKpis}>
      {Array.from({ length: 4 }, (_, index) => (
        <SkeletonCard key={index}>
          <Skeleton width="55%" height="0.75rem" />
          <Skeleton width="42%" height="1.75rem" />
          <Skeleton variant="rect" width="100%" height="2.5rem" />
        </SkeletonCard>
      ))}
    </div>
    <SkeletonTable rows={5} columns={4} />
  </div>
);

export const SkeletonTaskDetail: React.FC = () => (
  <div className={styles.taskDetail} data-testid="skeleton-task-detail" aria-busy="true">
    <SkeletonCard>
      <Skeleton width="12rem" height="1.75rem" />
      <Skeleton width="16rem" height="0.75rem" />
      <Skeleton width="80%" height="1rem" />
    </SkeletonCard>
    <SkeletonCard className={styles.dagSkeleton}>
      <Skeleton width="12rem" height="1rem" />
      <div className={styles.dagNodes}>
        {Array.from({ length: 3 }, (_, index) => <Skeleton key={index} variant="rect" width="9rem" height="5.75rem" />)}
      </div>
    </SkeletonCard>
    <div className={styles.taskPanels}>
      <SkeletonCard><SkeletonText lines={6} /></SkeletonCard>
      <SkeletonCard><SkeletonText lines={4} /></SkeletonCard>
    </div>
  </div>
);
