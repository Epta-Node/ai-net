import React from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { Coins, Scissors, AlertTriangle } from 'lucide-react';
import type { TaskCost, TaskNodeCost } from '../../types/api';
import styles from './TaskCostPanel.module.css';

interface TaskCostPanelProps {
  /** Null when the task has no cost recorded (older backend, wrong wallet). */
  cost: TaskCost | null;
  loading?: boolean;
}

/** Sub-dollar amounts need more precision than cents; past a dollar, cents suffice. */
function formatUsd(value: number): string {
  if (!Number.isFinite(value)) return '—';
  if (value === 0) return '$0.00';
  if (value < 0.01) return `$${value.toFixed(4)}`;
  return `$${value.toFixed(2)}`;
}

function formatTokens(value: number): string {
  if (!Number.isFinite(value)) return '—';
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(2)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
  return String(Math.round(value));
}

/** Usage ratio, clamped to [0, 1] so the bar cannot render wider than its track. */
function usedRatio(cost: TaskCost): number {
  if (cost.budgetTokens <= 0) return cost.usedTokens > 0 ? 1 : 0;
  return Math.min(1, cost.usedTokens / cost.budgetTokens);
}

function tone(cost: TaskCost): 'ok' | 'warn' | 'danger' {
  if (cost.exceeded) return 'danger';
  if (usedRatio(cost) >= 0.8) return 'warn';
  return 'ok';
}

function nodeLabel(node: TaskNodeCost, t: TFunction): string {
  if (node.agentType) return t(`agentType.${node.agentType}`, { defaultValue: node.agentType });
  return node.nodeId;
}

/**
 * Token budget and LLM spend for one task (Issue #390).
 *
 * Two things this deliberately shows rather than hides:
 *  - `inProgress` is labelled, because a running task's numbers are provisional
 *    and an operator comparing them to a bill will otherwise think they are final.
 *  - `trimmed` / `budgetExhausted` are per-node flags, because "the task cost
 *    less than expected" is almost always "we silently dropped part of a prompt".
 */
export const TaskCostPanel: React.FC<TaskCostPanelProps> = ({ cost, loading = false }) => {
  const { t } = useTranslation();

  // Supplementary panel: render nothing rather than a misleading zero when the
  // backend has no cost record for this task.
  if (loading || !cost) return null;

  const barTone = tone(cost);
  const nodes = [...cost.agents].sort((a, b) => b.costUsd - a.costUsd);

  return (
    <section className={styles.panel} aria-label={t('task.cost.title', { defaultValue: 'Token cost' })}>
      <header className={styles.header}>
        <div className={styles.titleGroup}>
          <Coins size={16} aria-hidden />
          <h3 className={styles.title}>{t('task.cost.title', { defaultValue: 'Token cost' })}</h3>
        </div>
        {cost.inProgress && (
          <span className={styles.provisional}>
            {t('task.cost.inProgress', { defaultValue: 'in progress' })}
          </span>
        )}
      </header>

      <div className={styles.summary}>
        <div className={styles.stat}>
          <span className={styles.statLabel}>{t('task.cost.spent', { defaultValue: 'Spent' })}</span>
          <span className={styles.statValue} data-tone={cost.exceeded ? 'danger' : undefined}>
            {formatUsd(cost.costUsd)}
          </span>
        </div>
        <div className={styles.stat}>
          <span className={styles.statLabel}>{t('task.cost.tokens', { defaultValue: 'Tokens' })}</span>
          <span className={styles.statValue}>{formatTokens(cost.usedTokens)}</span>
        </div>
        <div className={styles.stat}>
          <span className={styles.statLabel}>{t('task.cost.calls', { defaultValue: 'Calls' })}</span>
          <span className={styles.statValue}>{cost.calls}</span>
        </div>
        <div className={styles.stat}>
          <span className={styles.statLabel}>{t('task.cost.remaining', { defaultValue: 'Remaining' })}</span>
          <span className={styles.statValue} data-tone={barTone === 'ok' ? undefined : barTone}>
            {formatTokens(cost.remainingTokens)}
          </span>
        </div>
      </div>

      {cost.budgetTokens > 0 && (
        <div className={styles.meter}>
          <div
            className={styles.meterTrack}
            role="progressbar"
            aria-valuenow={Math.round(usedRatio(cost) * 100)}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-label={t('task.cost.budgetUsage', { defaultValue: 'Budget used' })}
          >
            <div
              className={styles.meterFill}
              data-tone={barTone === 'ok' ? undefined : barTone}
              style={{ width: `${usedRatio(cost) * 100}%` }}
            />
          </div>
          <div className={styles.meterCaption}>
            <span>
              {formatTokens(cost.usedTokens)} / {formatTokens(cost.budgetTokens)}
            </span>
            {cost.exceeded && (
              <span data-tone="danger">
                {t('task.cost.overBudget', { defaultValue: 'over budget' })}
              </span>
            )}
          </div>
        </div>
      )}

      {nodes.length === 0 ? (
        <p className={styles.empty}>
          {t('task.cost.noUsage', { defaultValue: 'No LLM calls recorded for this task yet.' })}
        </p>
      ) : (
        <ul className={styles.breakdown}>
          {nodes.map((node) => (
            <li key={node.nodeId} className={styles.breakdownRow}>
              <span className={styles.nodeId}>
                <span className={styles.nodeName} title={node.nodeId}>
                  {nodeLabel(node, t)}
                </span>
                {node.trimmed && (
                  <span className={styles.tag} data-tone="trimmed" title={t('task.cost.trimmedHint', { defaultValue: 'Prompt was trimmed to fit the remaining budget' })}>
                    <Scissors size={9} aria-hidden /> {t('task.cost.trimmed', { defaultValue: 'trimmed' })}
                  </span>
                )}
                {node.budgetExhausted && (
                  <span className={styles.tag} data-tone="exhausted">
                    <AlertTriangle size={9} aria-hidden /> {t('task.cost.exhausted', { defaultValue: 'budget' })}
                  </span>
                )}
              </span>
              <span className={styles.nodeMeta}>
                {formatTokens(node.totalTokens)} · {node.calls} {node.calls === 1
                  ? t('task.cost.call', { defaultValue: 'call' })
                  : t('task.cost.calls', { defaultValue: 'calls' })}
              </span>
              <span className={styles.cost}>{formatUsd(node.costUsd)}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
};

export default TaskCostPanel;
