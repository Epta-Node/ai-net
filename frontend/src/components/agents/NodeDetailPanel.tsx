import { useTranslation } from 'react-i18next';
import styles from './DAGPreview.module.css';

// ─── Types ────────────────────────────────────────────────────────────────────
// Local extensions only — types/api.ts is intentionally left untouched.
// Timing / retry fields are optional; the panel renders clean fallbacks
// when they are undefined.

export interface NodeTiming {
  startedAt?: string;
  finishedAt?: string;
  /** Elapsed wall-clock time in milliseconds. */
  durationMs?: number;
}

export interface NodeDetailData {
  id: string;
  label: string;
  agentName?: string;
  capability?: string;
  status?: string;
  timing?: NodeTiming;
  retries?: number;
  error?: string;
  cost?: number;
}

export interface NodeDetailPanelProps {
  node: NodeDetailData | null;
  onClose: () => void;
}

const FALLBACK = '—';

function formatDuration(durationMs?: number): string {
  if (durationMs === undefined || durationMs === null || Number.isNaN(durationMs)) {
    return FALLBACK;
  }
  if (durationMs < 1000) return `${Math.round(durationMs)}ms`;
  return `${(durationMs / 1000).toFixed(1)}s`;
}

// ─── Component ────────────────────────────────────────────────────────────────

export function NodeDetailPanel({ node, onClose }: NodeDetailPanelProps) {
  const { t } = useTranslation();

  if (!node) return null;

  const status = (node.status ?? 'pending').toLowerCase();
  const title = node.agentName ?? node.label;

  return (
    <aside
      className={styles.sidePanel}
      role="complementary"
      aria-label={t('agent.dag.tooltip.selected')}
      data-testid="node-detail-panel"
    >
      <div className={styles.panelHeader}>
        <div className={styles.panelHeading}>
          <div className={styles.panelEyebrow}>{t('agent.dag.tooltip.selected')}</div>
          <h3 className={styles.panelTitle}>{title}</h3>
        </div>
        <button
          type="button"
          className={styles.closeBtn}
          onClick={onClose}
          aria-label="Close node details"
          data-testid="node-detail-close"
        >
          ×
        </button>
      </div>

      <dl className={styles.panelBody}>
        <div className={styles.panelRow}>
          <dt className={styles.panelLabel}>{t('agent.dag.tooltip.status')}</dt>
          <dd
            className={`${styles.panelValue} ${styles[`status_${status}`] ?? ''}`}
            data-testid="node-detail-status"
          >
            {status}
          </dd>
        </div>

        <div className={styles.panelRow}>
          <dt className={styles.panelLabel}>{t('agent.dag.tooltip.capability')}</dt>
          <dd className={styles.panelValue} data-testid="node-detail-agent">
            {node.capability ?? node.agentName ?? FALLBACK}
          </dd>
        </div>

        <div className={styles.panelRow}>
          <dt className={styles.panelLabel}>Started</dt>
          <dd className={styles.panelValue} data-testid="node-detail-started">
            {node.timing?.startedAt ?? FALLBACK}
          </dd>
        </div>

        <div className={styles.panelRow}>
          <dt className={styles.panelLabel}>Finished</dt>
          <dd className={styles.panelValue} data-testid="node-detail-finished">
            {node.timing?.finishedAt ?? FALLBACK}
          </dd>
        </div>

        <div className={styles.panelRow}>
          <dt className={styles.panelLabel}>Duration</dt>
          <dd className={styles.panelValue} data-testid="node-detail-duration">
            {formatDuration(node.timing?.durationMs)}
          </dd>
        </div>

        <div className={styles.panelRow}>
          <dt className={styles.panelLabel}>Retries</dt>
          <dd className={styles.panelValue} data-testid="node-detail-retries">
            {node.retries ?? FALLBACK}
          </dd>
        </div>

        {node.cost !== undefined && (
          <div className={styles.panelRow}>
            <dt className={styles.panelLabel}>{t('agent.dag.tooltip.cost')}</dt>
            <dd className={styles.panelValue}>
              {node.cost} XLM
            </dd>
          </div>
        )}

        <div className={styles.panelRow}>
          <dt className={styles.panelLabel}>{t('agent.dag.tooltip.nodeId')}</dt>
          <dd className={`${styles.panelValue} ${styles.mono}`} data-testid="node-detail-id">
            {node.id}
          </dd>
        </div>

        <div className={styles.errorSection}>
          <dt className={styles.panelLabel}>Error</dt>
          {node.error ? (
            <dd className={styles.errorBox} data-testid="node-detail-error">
              {node.error}
            </dd>
          ) : (
            <dd className={styles.muted} data-testid="node-detail-error-empty">
              No errors
            </dd>
          )}
        </div>
      </dl>
    </aside>
  );
}

export default NodeDetailPanel;
