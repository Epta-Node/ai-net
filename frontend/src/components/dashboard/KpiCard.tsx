// src/components/dashboard/KpiCard.tsx
import React from 'react';
import { Area, AreaChart, ResponsiveContainer } from 'recharts';
import { motion } from 'framer-motion';
import styles from './KpiCard.module.css';
import { useAnimatedCounter } from '../../hooks/useAnimatedCounter';

interface KpiCardProps {
  title: string;
  value: number | string;
  sparklineData: number[]; // array of values for chart
  loading?: boolean;
}

export const KpiCard: React.FC<KpiCardProps> = ({ title, value, sparklineData, loading }) => {
  const data = sparklineData.map((v, i) => ({ x: i, y: v }));

  // Numeric values get the spring-animated counter; strings (e.g. "98.12%") render as-is
  const numericValue = typeof value === 'number' ? value : null;
  const animatedValue = useAnimatedCounter(numericValue ?? 0);

  const isZero = numericValue !== null && numericValue === 0;

  if (loading) {
    return (
      <div className={`${styles.card} ${styles.loadingCard}`}>
        <div className={styles.skeleton} />
      </div>
    );
  }

  return (
    <div className={styles.card}>
      <div className={styles.title}>{title}</div>
      {isZero ? (
        <div
          className={styles.value}
          role="status"
          aria-label={`${title}: no data`}
        >
          —
        </div>
      ) : numericValue !== null ? (
        <motion.div
          className={styles.value}
          role="status"
          aria-label={`${title}: ${numericValue}`}
        >
          {animatedValue}
        </motion.div>
      ) : (
        <div className={styles.value}>{value}</div>
      )}
      <div className={styles.sparkline}>
        <ResponsiveContainer width="100%" height={40}>
          <AreaChart data={data} margin={{ top: 0, right: 0, left: 0, bottom: 0 }}>
            <defs>
              <linearGradient id={`spark-${title}`} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="#8884d8" stopOpacity={0.4} />
                <stop offset="100%" stopColor="#8884d8" stopOpacity={0} />
              </linearGradient>
            </defs>
            <Area
              type="monotone"
              dataKey="y"
              stroke="#8884d8"
              fill={`url(#spark-${title})`}
              strokeWidth={2}
              dot={false}
              isAnimationActive
            />
          </AreaChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
};