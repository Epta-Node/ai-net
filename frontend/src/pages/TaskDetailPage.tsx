import React, { useEffect, useState, useMemo } from 'react';
import { useTranslation, Trans } from 'react-i18next';
import { useParams } from 'react-router-dom';

import { useTaskMonitor } from '../hooks/useTaskMonitor';
import ReactFlow, { Background, Controls, Handle, Position } from 'reactflow';
import 'reactflow/dist/style.css';
import { TaskDetailTimeline } from '../components/dashboard/TaskDetailTimeline';
import { PaymentTimeline } from '../components/dashboard/PaymentTimeline';
import { TaskCostPanel } from '../components/tasks/TaskCostPanel';
import { getTaskCost } from '../services/api';
import type { TaskCost } from '../types/api';
import { Skeleton, SkeletonText } from '../components/common/Skeleton';
import { DAGPreview } from '../components/agents/DAGPreview';
import { NodeDetailPanel, type NodeDetailData } from '../components/agents/NodeDetailPanel';
import { AlertCircle, CheckCircle2, Play, RefreshCw } from 'lucide-react';

/**
 * Context-aware skeleton that mirrors the task detail layout (header, DAG
 * panel, output/payment panels) so there is no layout shift on load.
 */
export const TaskDetailSkeleton: React.FC = () => {
  const { t } = useTranslation();

  return (
    <div
      className="space-y-6"
      data-testid="task-detail-skeleton"
      aria-busy="true"
      aria-label={t('a11y.loadingTaskDetails')}
    >
      {/* Details Header */}
      <div className="glass-panel flex flex-col md:flex-row justify-between items-start md:items-center gap-4">
        <div className="w-full md:w-2/3">
          <div className="flex items-center gap-3">
            <Skeleton width="12rem" height="1.75rem" />
            <Skeleton variant="pill" width="6rem" height="1.25rem" />
          </div>
          <Skeleton width="16rem" height="0.75rem" className="mt-2" />
          <Skeleton width="80%" height="1rem" className="mt-3" />
        </div>
        <div className="flex items-center gap-3">
          <Skeleton width="6rem" height="2.5rem" />
          <Skeleton width="4rem" height="2.5rem" />
        </div>
      </div>

      {/* Timeline Panel */}
      <div className="glass-panel relative flex flex-col">
        <Skeleton width="12rem" height="1.5rem" className="mb-4" />
        <div className="space-y-4">
          <Skeleton height="80px" />
          <Skeleton height="80px" />
          <Skeleton height="80px" />
        </div>
        <div
          className="w-full bg-slate-950/40 rounded-xl border border-[var(--panel-border)] overflow-hidden flex items-center gap-8 px-8"
          style={{ height: '280px' }}
        >
          {Array.from({ length: 3 }, (_, index) => (
            <Skeleton
              key={index}
              variant="rect"
              width="160px"
              height="92px"
              className="shrink-0 rounded-xl"
            />
          ))}
        </div>
      </div>

      {/* Combined Panels */}
      <div className="grid grid-cols-1 lg:grid-cols-5 gap-6">
        <div className="glass-panel lg:col-span-3">
          <SkeletonText lines={6} />
        </div>
        <div className="glass-panel lg:col-span-2">
          <SkeletonText lines={4} />
        </div>
      </div>
    </div>
  );
};

const TaskDetailPage: React.FC = () => {
  const { t } = useTranslation();
  const { id } = useParams<{ id: string }>();
  const { task, loading, error, wsStatus, reconnectStream, nodes, payments, outputs, refetch } =
    useTaskMonitor(id);

  // Token cost (Issue #390). Fetched separately from the task monitor because
  // the backend owns the ledger: while the task runs, cost only exists in the
  // in-memory ledger plus periodic flushes, not in the task payload.
  const [cost, setCost] = useState<TaskCost | null>(null);
  const [costLoading, setCostLoading] = useState(true);

  useEffect(() => {
    if (!id) return;
    let cancelled = false;
    setCostLoading(true);

    getTaskCost(id)
      .then((res) => {
        if (!cancelled) setCost(res);
      })
      .catch(() => {
        // Cost is supplementary: a task whose spend cannot be read (older
        // backend, wrong wallet) should still render its results.
        if (!cancelled) setCost(null);
      })
      .finally(() => {
        if (!cancelled) setCostLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [id, task?.status]);

  // Check if any node is failed
  const failedNode = useMemo(() => {
    return nodes.find((n) => n.status === 'failed');
  }, [nodes]);

  // ── Interactive DAG: node selection with ESC dismissal ───────────────────
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);

  // Reset selection when navigating between tasks.
  useEffect(() => {
    setSelectedNodeId(null);
  }, [id]);

  // ESC dismisses the node detail panel.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setSelectedNodeId(null);
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);

  // Bridge live DAGNode[] state into the DAGPreview shape. Topology (ids +
  // dependency edges) is stable; per-event status changes flow through
  // `liveStatuses` so DAGPreview updates node data in place without
  // re-running layout or resetting pan/zoom.
  const dagPreview = useMemo(() => {
    if (!nodes.length) return undefined;
    return {
      nodes: nodes.map((node) => ({
        id: node.nodeId,
        label: node.nodeId.replace('node_', '').replace('node-', ''),
      })),
      edges: nodes.flatMap((node) =>
        (node.dependsOn ?? []).map((depId) => ({
          source: depId,
          target: node.nodeId,
        }))
      ),
    };
  }, [nodes]);

  const liveStatuses = useMemo(() => {
    const map: Record<string, string> = {};
    nodes.forEach((node) => {
      map[node.nodeId] = node.status;
    });
    return map;
  }, [nodes]);

  // Detail-panel model for the selected node. Timing / retry fields are not
  // part of DAGNode yet — left undefined so the panel shows clean fallbacks.
  const selectedNode: NodeDetailData | null = useMemo(() => {
    if (!selectedNodeId) return null;
    const node = nodes.find((n) => n.nodeId === selectedNodeId);
    if (!node) return null;
    return {
      id: node.nodeId,
      label: node.nodeId.replace('node_', '').replace('node-', ''),
      agentName: node.agentType,
      capability: node.agentType,
      status: node.status,
      timing: undefined,
      retries: undefined,
      error: node.error,
    };
  }, [selectedNodeId, nodes]);

  if (loading && !nodes.length) {
    return <TaskDetailSkeleton />;
  }

  if (error) {
    return (
      <div className="glass-panel border-rose-500/30 text-center py-12">
        <AlertCircle className="text-rose-500 mx-auto mb-4" size={48} />
        <h2 className="text-xl font-bold text-[var(--text-primary)] mb-2">
          {t('page.task.errorTitle')}
        </h2>
        <p className="text-rose-300/80 mb-6">{error.message}</p>
        <button onClick={refetch} className="flex items-center gap-2 mx-auto">
          <RefreshCw size={16} />
          <span>{t('common.retry')}</span>
        </button>
      </div>
    );
  }

  // Get current WS status color/label
  const getWsStatusBadge = () => {
    switch (wsStatus) {
      case 'connected':
        return {
          bg: 'var(--status-success-surface)',
          border: 'var(--status-success-border)',
          color: 'var(--status-success-text)',
          label: t('page.task.ws.connected'),
        };
      case 'connecting':
        return {
          bg: 'var(--status-warning-surface)',
          border: 'var(--status-warning-border)',
          color: 'var(--status-warning-text)',
          label: t('page.task.ws.connecting'),
        };
      case 'authentication-required':
        return {
          bg: 'var(--status-warning-surface)',
          border: 'var(--status-warning-border)',
          color: 'var(--status-warning-text)',
          label: t('page.task.ws.authenticationRequired'),
        };
      case 'error':
      case 'disconnected':
      default:
        return {
          bg: 'var(--status-danger-surface)',
          border: 'var(--status-danger-border)',
          color: 'var(--status-danger-text)',
          label: t('page.task.ws.disconnected'),
        };
    }
  };

  const wsBadge = getWsStatusBadge();

  return (
    <div className="space-y-6 fade-in">
      {/* Task failed banner */}
      {failedNode && (
        <div
          className="p-4 bg-rose-950/60 border border-rose-500/50 rounded-xl flex items-start gap-3 text-rose-200 animate-fadeIn"
          role="alert"
        >
          <AlertCircle className="text-rose-400 mt-0.5 shrink-0" size={20} />
          <div>
            <h4 className="font-bold text-sm">{t('page.task.failedTitle')}</h4>
            <p className="text-xs text-[var(--status-danger-text)] mt-0.5">
              <Trans
                i18nKey="page.task.failedBody"
                values={{
                  node: failedNode.nodeId.replace('node_', '').replace('node-', ''),
                  error: failedNode.error || t('page.task.unknownError'),
                }}
                components={[<span key="node" className="font-mono font-bold capitalize" />]}
              />
            </p>
          </div>
        </div>
      )}

      {/* Task completed banner */}
      {task?.status === 'completed' && !failedNode && (
        <div
          className="p-4 bg-emerald-950/60 border border-emerald-500/50 rounded-xl flex items-start gap-3 text-emerald-200 animate-fadeIn"
          role="alert"
        >
          <CheckCircle2 className="text-emerald-400 mt-0.5 shrink-0" size={20} />
          <div>
            <h4 className="font-bold text-sm">{t('page.task.completedTitle')}</h4>
            <p className="text-xs text-[var(--status-success-text)] mt-0.5">
              {t('page.task.completedBody')}
            </p>
          </div>
        </div>
      )}

      {/* Details Header */}
      <div className="glass-panel flex flex-col md:flex-row justify-between items-start md:items-center gap-4">
        <div>
          <div className="flex items-center gap-3">
            <h1 className="text-xl md:text-2xl font-bold tracking-tight">
              {t('nav.taskMonitoring')}
            </h1>
            <span
              id="ws-status"
              // The raw state, so tests can assert the connection without
              // depending on the translated label inside the badge.
              data-ws-state={wsStatus}
              className="chip text-[10px] tracking-wider uppercase"
              style={{
                background: wsBadge.bg,
                borderColor: wsBadge.border,
                color: wsBadge.color,
              }}
            >
              {t('page.task.wsStatus', { status: wsBadge.label })}
            </span>
            {(wsStatus === 'disconnected' || wsStatus === 'error') && (
              <button
                type="button"
                onClick={reconnectStream}
                className="inline-flex items-center gap-1 rounded-md border border-[var(--border-strong)] px-2 py-1 text-xs hover:bg-[var(--surface-muted)]"
                aria-label={t('page.task.ws.reconnect')}
              >
                <RefreshCw size={12} />
                {t('page.task.ws.reconnect')}
              </button>
            )}
          </div>
          <p className="text-xs text-[var(--text-secondary)] font-mono mt-1">
            {t('page.task.taskId', { id })}
          </p>
          {task?.prompt && (
            <p className="text-sm text-[var(--text-muted)] mt-3 italic border-l-2 border-[var(--accent-secondary)] pl-3">
              "{task.prompt}"
            </p>
          )}
        </div>

        <div className="flex items-center gap-3 self-stretch md:self-auto justify-between">
          <div className="text-right hidden sm:block">
            <div className="text-[10px] uppercase font-bold text-[var(--text-secondary)]">
              {t('common.status')}
            </div>
            <div
              className={`text-xs font-extrabold capitalize mt-0.5 ${
                task?.status === 'completed'
                  ? 'text-[var(--status-success)]'
                  : task?.status === 'failed'
                    ? 'text-[var(--status-danger)]'
                    : 'text-[var(--accent-secondary)]'
              }`}
            >
              {task?.status || 'queued'}
            </div>
          </div>
          {/* The visible status is hidden on small screens; this live region
              announces every task / stream status change regardless (#726). */}
          <span className="sr-only" role="status" aria-live="polite" aria-atomic="true">
            {`${t('common.status')}: ${task?.status || 'queued'}. ${t('page.task.wsStatus', { status: wsBadge.label })}`}
          </span>
          <button
            onClick={refetch}
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-lg bg-[var(--surface-elevated)] hover:bg-[var(--surface-muted)] border border-[var(--border-strong)] transition"
          >
            <RefreshCw size={12} />
            <span>{t('page.task.sync')}</span>
          </button>
        </div>
      </div>

      {/* DAG Graph Panel */}
      <div className="glass-panel relative flex flex-col">
        <div className="flex items-center gap-2 mb-3">
          <Play size={16} className="text-[var(--accent-secondary)]" />
          <h3 className="text-md font-semibold text-[var(--text-primary)]">
            {t('page.task.dagTitle')}
          </h3>
          <span className="text-[10px] text-[var(--text-muted)] ml-auto">
            {t('page.task.dagHint')}
          </span>
        </div>

        <div
          id="dag-preview"
          className="w-full bg-[var(--surface-glass-subtle)] rounded-xl border border-[var(--panel-border)] overflow-hidden relative"
          style={{ minHeight: '280px' }}
        >
          {dagPreview && dagPreview.nodes.length > 0 ? (
            <div className="flex flex-col md:flex-row gap-3 p-3">
              <div className="flex-1 min-w-0">
                <DAGPreview
                  dagPreview={dagPreview}
                  liveStatuses={liveStatuses}
                  selectedNodeId={selectedNodeId}
                  onNodeSelect={setSelectedNodeId}
                />
              </div>
              {selectedNode && (
                <NodeDetailPanel node={selectedNode} onClose={() => setSelectedNodeId(null)} />
              )}
            </div>
          ) : (
            <div
              className="flex items-center justify-center h-full text-[var(--text-muted)]"
              style={{ minHeight: '280px' }}
            >
              {t('page.task.dagEmpty')}
            </div>
          )}
        </div>
      </div>

      {/* Token cost (Issue #390) */}
      <TaskCostPanel cost={cost} loading={costLoading} />

      {/* Combined Panels */}
      <div className="grid grid-cols-1 lg:grid-cols-5 gap-6">
        <div className="lg:col-span-3">
          <TaskDetailTimeline nodes={nodes} outputs={outputs} />
        </div>
        <div className="lg:col-span-2">
          <PaymentTimeline payments={payments} />
        </div>
      </div>
    </div>
  );
};

export default TaskDetailPage;
