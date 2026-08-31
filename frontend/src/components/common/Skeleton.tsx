// src/components/common/Skeleton.tsx
import React from 'react';
import styles from './Skeleton.module.css';

export type SkeletonVariant = 'text' | 'pill' | 'circular' | 'rectangular';

export interface SkeletonProps {
  width?: string | number;
  height?: string | number;
  variant?: SkeletonVariant;
  className?: string;
  style?: React.CSSProperties;
  'data-testid'?: string;
}

const variantClass = (variant: SkeletonVariant): string => {
  switch (variant) {
    case 'pill':
      return styles.pill;
    case 'circular':
      return styles.circular;
    case 'rectangular':
      return styles.rectangular;
    case 'text':
    default:
      return styles.text;
  }
};

export const Skeleton: React.FC<SkeletonProps> = ({
  width = '100%',
  height = '1rem',
  variant = 'text',
  className,
  style,
  'data-testid': testId,
}) => (
  <div
    className={[styles.skeleton, variantClass(variant), className].filter(Boolean).join(' ')}
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
  'data-testid'?: string;
}

export const SkeletonTable: React.FC<SkeletonTableProps> = ({
  rows = 5,
  columns = 4,
  className,
  'data-testid': testId,
}) => (
  <div className={[styles.table, className].filter(Boolean).join(' ')} data-testid={testId}>
    {Array.from({ length: rows }, (_, r) => (
      <div
        key={r}
        className={styles.tableRow}
        style={{ gridTemplateColumns: `repeat(${columns}, 1fr)` }}
        data-testid="skeleton-table-row"
      >
        {Array.from({ length: columns }, (_, c) => (
          <Skeleton key={c} width="100%" height="1rem" />
        ))}
      </div>
    ))}
  </div>
);
