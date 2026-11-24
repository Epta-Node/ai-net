import React from 'react';
import { Skeleton } from '../../common/Skeleton';

export interface SkeletonChartProps {
  /** Number of bars in the placeholder chart. */
  bars?: number;
  /** Bars height in px (chart area). */
  height?: number;
  className?: string;
  'data-testid'?: string;
}

/**
 * Bar-chart placeholder (#719).
 * Renders deterministic bar heights (no randomness — keeps visual snapshots
 * stable) and inherits the shimmer / reduced-motion behaviour from `Skeleton`.
 */
export const SkeletonChart: React.FC<SkeletonChartProps> = ({
  bars = 12,
  height = 120,
  className,
  'data-testid': testId = 'skeleton-chart',
}) => (
  <div
    data-testid={testId}
    aria-hidden="true"
    className={className}
    style={{
      display: 'flex',
      alignItems: 'flex-end',
      gap: '6px',
      height,
    }}
  >
    {Array.from({ length: bars }, (_, i) => {
      // Deterministic pseudo-heights: 35%..95% wave so snapshots don't flake.
      const ratio = 0.35 + 0.6 * Math.abs(Math.sin((i + 1) * 1.1));
      return (
        <Skeleton
          key={i}
          variant="rect"
          width="100%"
          height={`${Math.round(ratio * height)}px`}
          data-testid="skeleton-chart-bar"
        />
      );
    })}
  </div>
);
