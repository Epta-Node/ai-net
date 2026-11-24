// src/pages/dashboard.tsx
import React from 'react';
import { useTranslation } from 'react-i18next';
import { Navigate } from 'react-router-dom';
import { useWallet } from '../hooks/useWallet';
import { useNetworkStats } from '../hooks/useNetworkStats';
import { DashboardLayout } from '../components/dashboard/DashboardLayout';
import { KpiCard } from '../components/dashboard/KpiCard';
import { NetworkHealthBadge } from '../components/dashboard/NetworkHealthBadge';
import { RecentTasksTable } from '../components/dashboard/RecentTasksTable';
import { AgentWatchdogPanel } from '../components/dashboard/AgentWatchdogPanel';
import { DashboardPanel } from '../components/dashboard/DashboardPanel';
import { useToast } from '../hooks/useToast';
import {
  Skeleton,
  SkeletonAvatar,
  SkeletonCard,
  SkeletonTable,
} from '../components/common/Skeleton';
import styles from './dashboard.module.css';
import type { TimePoint, NetworkStats } from '../types/api';

// Extract y-values from a TimePoint[] series.
const toSeries = (points: TimePoint[] | undefined): number[] => {
  if (points && points.length > 0) {
    return points.map((p) => p.value);
  }
  return [];
};

// Sub-cent totals need more precision than cents, or a real cost renders as $0.00.
const formatCostUsd = (value: number): string => {
  if (!Number.isFinite(value) || value === 0) return '$0.00';
  if (value < 0.01) return `$${value.toFixed(4)}`;
  return `$${value.toFixed(2)}`;
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
  const { data, loading, error, retry } = useNetworkStats();
  const { showToast } = useToast();
  const { t, i18n } = useTranslation();

  React.useEffect(() => {
    if (error) {
      // i18n.t so the toast uses the current language without re-running the
      // effect on every language change.
      showToast(
        i18n.t('page.dashboard.statsError', { error: error.message || String(error) }),
        'error'
      );
    }
  }, [error, showToast, i18n]);

  // Redirect unauthenticated users using React Router to preserve SPA state
  if (!connected) {
    return <Navigate to="/" replace />;
  }

  if (!address) return null; // render nothing while redirecting
  const kpiData: NetworkStats = data || {
    totalAgents: 0,
    totalTasks: 0,
    totalXLMTransacted: 0,
    uptimePercent: 0,
  };

  // Only totalTasks and totalXLMTransacted have a real 7-day series from the
  // backend. totalAgents and uptimePercent have no time-series equivalent, so
  // their KPI cards render without a sparkline rather than a fabricated one.
  const tasksSeries = toSeries(kpiData.tasksLast7d);
  const xlmSeries = toSeries(kpiData.xlmLast7d);
  // No synthetic fallback here either: inventing a spend series for a metric
  // that is actually measured would make a zero-cost platform look like it had
  // a trend.
  const costSeries = toSeries(kpiData.cost?.costLast7d);

  return (
    <DashboardLayout className="fade-in">
      <DashboardPanel
        loading={loading}
        error={error}
        onRetry={() => void retry()}
        empty={!data}
        emptyTitle={t('page.dashboard.emptyTitle')}
        emptyDescription={t('page.dashboard.emptyDescription')}
        loadingContent={<DashboardSkeleton />}
      >
        <section className={styles.kpis}>
          <KpiCard
            title={t('page.dashboard.totalAgents')}
            value={kpiData.totalAgents}
            loading={loading}
          />
          <KpiCard
            title={t('page.dashboard.totalTasks')}
            value={kpiData.totalTasks}
            sparklineData={tasksSeries}
            loading={loading}
          />
          <KpiCard
            title={t('page.dashboard.totalXLM')}
            value={kpiData.totalXLMTransacted}
            sparklineData={xlmSeries}
            loading={loading}
          />
          <KpiCard
            title={t('page.dashboard.uptime')}
            value={`${kpiData.uptimePercent.toFixed(2)}%`}
            loading={loading}
          />
          {/* Platform LLM spend (Issue #390). Renders as a string, so KpiCard shows
            it verbatim rather than count-animating a dollar figure. */}
          <KpiCard
            title={t('page.dashboard.totalCost', { defaultValue: 'LLM spend' })}
            value={formatCostUsd(kpiData.cost?.costUsd ?? 0)}
            sparklineData={costSeries}
            loading={loading}
          />
        </section>
        <section className={styles.health}>
          <NetworkHealthBadge uptimePercent={kpiData.uptimePercent} />
        </section>
        <section className={styles.recentTasks}>
          <h2 className={styles.heading}>{t('page.dashboard.recentTasks')}</h2>
          <RecentTasksTable walletAddress={address ?? ''} loading={loading} />
        </section>
      </DashboardPanel>
      {/* Agent heartbeat health (Issue #379) */}
      <AgentWatchdogPanel />
    </DashboardLayout>
  );
};

export default DashboardPage;
