// src/components/dashboard/KpiCard.tsx
import React from 'react';
import { motion } from 'framer-motion';
import styles from './KpiCard.module.css';
import { useAnimatedCounter } from '../../hooks/useAnimatedCounter';
import { Skeleton } from '../common/Skeleton';
import { Sparkline } from '../common/Sparkline';

interface KpiCardProps {
  title: string;
  value: number | string;
  /** 7-day daily series used for the sparkline. Omitted when no real series is available. */
  sparklineData?: number[];
  loading?: boolean;
}

export const KpiCard: React.FC<KpiCardProps> = ({ title, value, sparklineData, loading }) => {
  // Numeric values animate with spring count-up; strings (e.g. "98.12%") render as-is
  const numericValue = typeof value === 'number' ? value : null;
  const displayValue = useAnimatedCounter(numericValue ?? 0);

  const isZero = numericValue !== null && numericValue === 0;

  if (loading) {
    return (
      <div className={`${styles.card} ${styles.loadingCard}`}>
        <Skeleton width="100%" height="100%" variant="card" />
      </div>
    );
  }

  return (
    <motion.div
      className={styles.card}
      whileHover={{ y: -3, boxShadow: '0 8px 24px rgba(15, 23, 42, 0.18)' }}
      transition={{ type: 'spring', stiffness: 300, damping: 22 }}
    >
      <div className={styles.title}>{title}</div>

      {isZero ? (
        <div className={styles.value} role="status" aria-label={`${title}: no data`}>
          —
        </div>
      ) : numericValue !== null ? (
        <div
          className={styles.value}
          role="status"
          aria-label={`${title}: ${numericValue}`}
          aria-live="polite"
        >
          {displayValue.toLocaleString()}
        </div>
      ) : (
        <div className={styles.value}>{value}</div>
      )}

      {sparklineData && sparklineData.length > 0 && (
        <div className={styles.sparkline} aria-hidden="true">
          <Sparkline data={sparklineData} height={40} />
        </div>
      )}
    </motion.div>
  );
};
