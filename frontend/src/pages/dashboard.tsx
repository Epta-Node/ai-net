// src/pages/dashboard.tsx
import React from 'react';
import { useTranslation } from 'react-i18next';
import { Navigate } from 'react-router-dom';
import { useWallet } from '../hooks/useWallet';
import { useNetworkStats } from '../hooks/useNetworkStats';
import { useToast } from '../context/ToastContext';
import { DashboardLayout } from '../components/dashboard/DashboardLayout';
import { KpiCard } from '../components/dashboard/KpiCard';
import { NetworkHealthBadge } from '../components/dashboard/NetworkHealthBadge';
import { RecentTasksTable } from '../components/dashboard/RecentTasksTable';
import { useToast } from '../hooks/useToast';
import { Skeleton, SkeletonAvatar, SkeletonCard, SkeletonTable } from '../components/common/Skeleton';
import styles from './dashboard.module.css';
import type { TimePoint } from '../types/api';

// Extract just the y-values from a 24h TimePoint[] series, falling back to a
// deterministic synthetic series shaped around the current value.
const toSeries = (points: TimePoint[] | undefined): number[] => {
  if (points && points.length > 0) {
    return points.map((p) => p.value);
  }
  return [];
};

const syntheticSeries = (value: number): number[] => {
  const base = Math.max(value, 1);
  return Array.from({ length: 24 }, (_, i) => {
    const wave = Math.sin(i / 2) * base * 0.12;
    const drift = (i / 23) * base * 0.3;
    return Math.max(0, Math.round(drift + wave + 1));
  });
};

/**
 * Context-aware skeleton that mirrors the dashboard layout so there is no
 * layout shift between the loading and loaded states.
 */
export const DashboardSkeleton: React.FC = () => {
  const { t } = useTranslation();

  return (
    <div data-testid="dashboard-skeleton" aria-busy="true" aria-label={t('a11y.loadingDashboard')}>
      <section className={styles.kpis}>
        {Array.from({ length: 4 }, (_, i) => (
          <SkeletonCard key={i} className={styles.kpiSkeleton} data-testid="dashboard-kpi-skeleton">
            <Skeleton width="60%" height="0.875rem" />
            <Skeleton width="70%" height="1.75rem" />
            <Skeleton variant="rectangular" width="100%" height="2.5rem" />
          </SkeletonCard>
        ))}
      </section>
      <section className={styles.health}>
        <SkeletonAvatar size={10} />
        <Skeleton width="4rem" height="0.875rem" />
      </section>
      <section className={styles.recentTasks}>
        <h2 className={styles.heading}>{t('page.dashboard.recentTasks')}</h2>
        <SkeletonTable rows={5} columns={4} />
      </section>
    </div>
  );
};

export const DashboardPage: React.FC = () => {
  const { address, connected } = useWallet();
  const { data, loading, error } = useNetworkStats();
  const { showToast } = useToast();
  const { t, i18n } = useTranslation();

  // Show error toast when network stats fetch fails
  React.useEffect(() => {
    if (error) {
      // i18n.t so the toast uses the current language without re-running the
      // effect on every language change.
      showToast(i18n.t('page.dashboard.statsError', { error }), 'error');
    }
  }, [error, showToast, i18n]);

  // Redirect unauthenticated users using React Router to preserve SPA state
  if (!connected) {
    return <Navigate to="/" replace />;
  }

  React.useEffect(() => {
    if (error) {
      showToast(error.message || 'Unable to load dashboard data.', 'error');
    }
  }, [error, showToast]);

  if (!address) return null; // render nothing while redirecting
  if (loading) {
    return (
      <DashboardLayout>
        <DashboardSkeleton />
      </DashboardLayout>
    );
  }

  const kpiData = data || {
    totalAgents: 0,
    totalTasks: 0,
    totalXLMTransacted: 0,
    uptimePercent: 0,
  };

  const agentsSeries = toSeries(kpiData.tasksLast24h).length > 0 ? toSeries(kpiData.tasksLast24h) : syntheticSeries(kpiData.totalAgents);
  const tasksSeries = toSeries(kpiData.tasksLast24h).length > 0 ? toSeries(kpiData.tasksLast24h) : syntheticSeries(kpiData.totalTasks);
  const xlmSeries = toSeries(kpiData.xlmLast24h).length > 0 ? toSeries(kpiData.xlmLast24h) : syntheticSeries(kpiData.totalXLMTransacted);
  const uptimeSeries = toSeries(kpiData.tasksLast24h).length > 0 ? toSeries(kpiData.tasksLast24h) : syntheticSeries(Math.round(kpiData.uptimePercent));

  return (
    <DashboardLayout className="fade-in">
      <section className={styles.kpis}>
        <KpiCard title={t('page.dashboard.totalAgents')} value={kpiData.totalAgents} sparklineData={agentsSeries} loading={loading} />
        <KpiCard title={t('page.dashboard.totalTasks')} value={kpiData.totalTasks} sparklineData={tasksSeries} loading={loading} />
        <KpiCard title={t('page.dashboard.totalXLM')} value={kpiData.totalXLMTransacted} sparklineData={xlmSeries} loading={loading} />
        <KpiCard title={t('page.dashboard.uptime')} value={`${kpiData.uptimePercent.toFixed(2)}%`} sparklineData={uptimeSeries} loading={loading} />
      </section>
      <section className={styles.health}>
        <NetworkHealthBadge uptimePercent={kpiData.uptimePercent} />
      </section>
      <section className={styles.recentTasks}>
        <h2 className={styles.heading}>{t('page.dashboard.recentTasks')}</h2>
        <RecentTasksTable walletAddress={address ?? ''} loading={loading} />
      </section>
    </DashboardLayout>
  );
};

export default DashboardPage;