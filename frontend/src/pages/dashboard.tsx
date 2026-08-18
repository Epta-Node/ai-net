// src/pages/dashboard.tsx
import React from 'react';
import { useWallet } from '../hooks/useWallet';
import { useNetworkStats } from '../hooks/useNetworkStats';
import { useToast } from '../context/ToastContext';
import { DashboardLayout } from '../components/dashboard/DashboardLayout';
import { KpiCard } from '../components/dashboard/KpiCard';
import { NetworkHealthBadge } from '../components/dashboard/NetworkHealthBadge';
import { RecentTasksTable } from '../components/dashboard/RecentTasksTable';
import { useToast } from '../hooks/useToast';
import styles from './dashboard.module.css';

export const DashboardPage: React.FC = () => {
  const { address } = useWallet();
  const { data, loading, error } = useNetworkStats();
  const { showToast } = useToast();

  // Show error toast when network stats fetch fails
  React.useEffect(() => {
    if (error) {
      showToast(`Failed to load network stats: ${error}`, 'error');
    }
  }, [error, showToast]);

  // Redirect unauthenticated users
  React.useEffect(() => {
    if (!address) {
      window.location.replace('/');
    }
  }, [address]);

  React.useEffect(() => {
    if (error) {
      showToast(error.message || 'Unable to load dashboard data.', 'error');
    }
  }, [error, showToast]);

  if (!address) return null; // render nothing while redirecting

  const kpiData = data || {
    totalAgents: 0,
    totalTasks: 0,
    totalXLMTransacted: 0,
    uptimePercent: 0,
  };

  const sparkline = [kpiData.totalAgents, kpiData.totalTasks, kpiData.totalXLMTransacted]; // placeholder data

  return (
    <DashboardLayout>
      <section className={styles.kpis}>
        <KpiCard title="Total Agents" value={kpiData.totalAgents} sparklineData={sparkline} loading={loading} />
        <KpiCard title="Total Tasks Run" value={kpiData.totalTasks} sparklineData={sparkline} loading={loading} />
        <KpiCard title="Total XLM Transacted" value={kpiData.totalXLMTransacted} sparklineData={sparkline} loading={loading} />
        <KpiCard title="Network Uptime" value={`${kpiData.uptimePercent.toFixed(2)}%`} sparklineData={sparkline} loading={loading} />
      </section>
      <section className={styles.health}>
        <NetworkHealthBadge uptimePercent={kpiData.uptimePercent} />
      </section>
      <section className={styles.recentTasks}>
        <h2 className={styles.heading}>Recent Tasks</h2>
        <RecentTasksTable walletAddress={address} loading={loading} />
      </section>
    </DashboardLayout>
  );
};

export default DashboardPage;
