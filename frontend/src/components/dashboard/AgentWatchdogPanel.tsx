import React, { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { Activity, AlertTriangle, RefreshCw } from 'lucide-react';
import { getQuarantinedAgents, getWatchdogAlerts } from '../../services/api';
import type { AgentWatchdogAlert, QuarantinedAgent } from '../../types/api';
import styles from './AgentWatchdogPanel.module.css';

const REFRESH_MS = 30_000;
const ALERT_LIMIT = 20;

function formatSilentFor(ms: number | null, t: TFunction): string {
  if (ms === null || !Number.isFinite(ms)) return '—';
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return t('watchdog.silentSeconds', { seconds: Math.floor(ms / 1000) });
  if (minutes < 60) return t('watchdog.silentMinutes', { minutes });
  const hours = Math.floor(minutes / 60);
  return t('watchdog.silentHours', { hours });
}

/**
 * Fleet health from the heartbeat watchdog (Issue #379).
 *
 * The issue is that dead agents "silently linger". A log line does not fix that,
 * so this surfaces the two things an operator acts on: who is currently
 * quarantined (unavailable but still registered) and the recent alert history.
 *
 * Polls on an interval because these are background-driven state changes — there
 * is no user action that should be required to notice a dead agent.
 */
export const AgentWatchdogPanel: React.FC = () => {
  const { t } = useTranslation();
  const [alerts, setAlerts] = useState<AgentWatchdogAlert[]>([]);
  const [quarantined, setQuarantined] = useState<QuarantinedAgent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (): Promise<void> => {
    try {
      const [alertData, quarantineData] = await Promise.all([
        getWatchdogAlerts({ limit: ALERT_LIMIT }),
        getQuarantinedAgents(),
      ]);
      setAlerts(alertData);
      setQuarantined(quarantineData);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), REFRESH_MS);
    return () => clearInterval(timer);
  }, [load]);

  const criticalCount = alerts.filter((a) => a.severity === 'critical').length;

  return (
    <section className={styles.panel} aria-label={t('watchdog.title', { defaultValue: 'Agent health' })}>
      <header className={styles.header}>
        <div className={styles.titleGroup}>
          <Activity size={16} aria-hidden />
          <h3 className={styles.title}>{t('watchdog.title', { defaultValue: 'Agent health' })}</h3>
          {criticalCount > 0 && <span className={styles.count}>{criticalCount}</span>}
        </div>
        <button
          type="button"
          className={styles.refresh}
          onClick={() => void load()}
          disabled={loading}
          aria-label={t('watchdog.refresh', { defaultValue: 'Refresh' })}
        >
          <RefreshCw size={11} aria-hidden className={loading ? styles.spinning : undefined} />
          {t('watchdog.refresh', { defaultValue: 'Refresh' })}
        </button>
      </header>

      {error && (
        <p className={styles.error} role="alert">
          {error}
        </p>
      )}

      {quarantined.length > 0 && (
        <div className={styles.quarantine}>
          <span className={styles.quarantineHeader}>
            <AlertTriangle size={12} aria-hidden />
            {t('watchdog.quarantined', { defaultValue: 'Quarantined' })}
          </span>
          <ul className={styles.quarantineList}>
            {quarantined.map((agent) => (
              <li key={agent.agentId} className={styles.quarantineRow}>
                <span>{agent.agentId}</span>
                <span>{formatSilentFor(agent.silentForMs, t)}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {alerts.length === 0 ? (
        <p className={styles.empty}>
          {loading
            ? t('watchdog.loading', { defaultValue: 'Loading…' })
            : t('watchdog.allHealthy', { defaultValue: 'No agent health alerts.' })}
        </p>
      ) : (
        <ul className={styles.alertList}>
          {alerts.map((alert) => (
            <li key={alert.id} className={styles.alertRow} data-severity={alert.severity}>
              <AlertTriangle
                size={13}
                aria-hidden
                style={{
                  marginTop: 2,
                  color: alert.severity === 'critical'
                    ? 'var(--status-danger, #ef4444)'
                    : 'var(--color-warning, #f59e0b)',
                }}
              />
              <span className={styles.alertBody}>
                <span className={styles.alertMessage} title={alert.message}>
                  {alert.message}
                </span>
                <span className={styles.alertAgent}>
                  {t(`watchdog.type.${alert.type}`, { defaultValue: alert.type })}
                </span>
              </span>
              <span className={styles.alertTime}>
                {new Date(alert.detectedAt).toLocaleTimeString()}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
};

export default AgentWatchdogPanel;
