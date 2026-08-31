import React, { useState, useMemo } from 'react';
import { useTranslation, Trans } from 'react-i18next';
import { useParams } from 'react-router-dom';
import ReactFlow, { Background, Controls, Handle, Position, MarkerType, Node, Edge } from 'reactflow';
import 'reactflow/dist/style.css';
import { useTaskMonitor } from '../hooks/useTaskMonitor';
import { AgentOutputPanel } from '../components/dashboard/AgentOutputPanel';
import { PaymentTimeline } from '../components/dashboard/PaymentTimeline';
import { Skeleton, SkeletonText } from '../components/common/Skeleton';
import { AlertCircle, CheckCircle2, Play, RefreshCw } from 'lucide-react';

const CustomNode: React.FC<{ id: string; data: { label: string; status: string } }> = ({ id, data }) => {
  const { t } = useTranslation();

  return (
    <div id={id} className={`dag-node ${data.status} h-full flex flex-col justify-between`}>
      <Handle type="target" position={Position.Left} style={{ background: 'var(--text-muted)', width: 8, height: 8 }} />
      <div>
        <div className="text-[10px] uppercase font-extrabold tracking-wider opacity-60 mb-0.5">
          {t('page.task.agentNode')}
        </div>
        <div className="text-sm font-bold truncate capitalize">{data.label}</div>
      </div>
      <div className="node-status text-[9px] font-mono font-bold uppercase tracking-widest mt-2 px-1.5 py-0.5 rounded bg-black/25 inline-block mx-auto">
        {data.status}
      </div>
      <Handle type="source" position={Position.Right} style={{ background: 'var(--text-muted)', width: 8, height: 8 }} />
    </div>
  );
};

const nodeTypes = {
  custom: CustomNode,
};

/**
 * Context-aware skeleton that mirrors the task detail layout (header, DAG
 * panel, output/payment panels) so there is no layout shift on load.
 */
export const TaskDetailSkeleton: React.FC = () => {
  const { t } = useTranslation();

  return (
    <div className="space-y-6" data-testid="task-detail-skeleton" aria-busy="true" aria-label={t('a11y.loadingTaskDetails')}>
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

      {/* DAG Graph Panel */}
      <div className="glass-panel relative flex flex-col">
        <div className="flex items-center gap-2 mb-3">
          <Skeleton width="12rem" height="1rem" />
        </div>
        <Skeleton variant="rectangular" width="100%" height="280px" className="rounded-xl" />
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
  const { task, loading, error, wsStatus, nodes, payments, outputs, refetch } = useTaskMonitor(id);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);

  // Check if any node is failed
  const failedNode = useMemo(() => {
    return nodes.find(n => n.status === 'failed');
  }, [nodes]);

  // Construct React Flow nodes dynamically based on node state
  const flowNodes = useMemo<Node[]>(() => {
    return nodes.map((node, index) => {
      let background = 'var(--surface-panel-translucent)';
      let borderColor = 'var(--white-alpha-08)';
      let boxShadow = 'none';
      let color = 'var(--text-muted)';

      if (node.status === 'completed') {
        background = 'var(--status-success-surface)';
        borderColor = 'var(--success)';
        boxShadow = 'var(--glow-success)';
        color = 'var(--status-success-text)';
      } else if (node.status === 'running') {
        background = 'var(--accent-surface-strong)';
        borderColor = 'var(--primary)';
        boxShadow = 'var(--glow-info)';
        color = 'var(--accent-text)';
      } else if (node.status === 'failed') {
        background = 'var(--status-danger-surface-strong)';
        borderColor = 'var(--danger)';
        boxShadow = 'var(--glow-danger)';
        color = 'var(--status-danger-text)';
      }

      const cleanLabel = node.nodeId.replace('node_', '').replace('node-', '');

      return {
        id: node.nodeId,
        type: 'custom',
        data: { 
          label: cleanLabel, 
          status: node.status 
        },
        position: { x: index * 240 + 60, y: 110 },
        style: {
          padding: '12px 16px',
          borderRadius: 'var(--radius-2xl)',
          border: '2px solid',
          backgroundColor: background,
          borderColor: borderColor,
          color: color,
          boxShadow: boxShadow,
          minWidth: '160px',
          height: '92px',
          textAlign: 'center',
          fontWeight: 'bold',
          transition: 'all 0.3s ease',
          cursor: 'pointer',
        },
      };
    });
  }, [nodes]);

  // Construct React Flow edges dynamically based on dependency state
  const flowEdges = useMemo<Edge[]>(() => {
    const edges: Edge[] = [];
    nodes.forEach(node => {
      if (node.dependsOn && node.dependsOn.length > 0) {
        node.dependsOn.forEach(depId => {
          let strokeColor = 'var(--border-strong)';
          let animated = false;
          
          if (node.status === 'completed') {
            strokeColor = 'var(--status-success)'; // green for completed paths
          } else if (node.status === 'running') {
            strokeColor = 'var(--accent-secondary)'; // blue animated for active paths
            animated = true;
          } else if (node.status === 'failed') {
            strokeColor = 'var(--status-danger)'; // red for failed paths
          }

          edges.push({
            id: `edge-${depId}-${node.nodeId}`,
            source: depId,
            target: node.nodeId,
            animated,
            style: { stroke: strokeColor, strokeWidth: 2.5 },
            markerEnd: {
              type: MarkerType.ArrowClosed,
              color: strokeColor,
            },
          });
        });
      }
    });
    return edges;
  }, [nodes]);

  if (loading && !nodes.length) {
    return <TaskDetailSkeleton />;
  }

  if (error) {
    return (
      <div className="glass-panel border-rose-500/30 text-center py-12">
        <AlertCircle className="text-rose-500 mx-auto mb-4" size={48} />
        <h2 className="text-xl font-bold text-[var(--text-primary)] mb-2">{t('page.task.errorTitle')}</h2>
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
        <div className="p-4 bg-rose-950/60 border border-rose-500/50 rounded-xl flex items-start gap-3 text-rose-200 animate-fadeIn" role="alert">
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
        <div className="p-4 bg-emerald-950/60 border border-emerald-500/50 rounded-xl flex items-start gap-3 text-emerald-200 animate-fadeIn" role="alert">
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
            <h1 className="text-xl md:text-2xl font-bold tracking-tight">{t('nav.taskMonitoring')}</h1>
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
            <div className="text-[10px] uppercase font-bold text-[var(--text-secondary)]">{t('common.status')}</div>
            <div className={`text-xs font-extrabold capitalize mt-0.5 ${
              task?.status === 'completed' ? 'text-[var(--status-success)]' :
              task?.status === 'failed' ? 'text-[var(--status-danger)]' : 'text-[var(--accent-secondary)]'
            }`}>
              {task?.status || 'queued'}
            </div>
          </div>
          <button onClick={refetch} className="flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-lg bg-[var(--surface-elevated)] hover:bg-[var(--surface-muted)] border border-[var(--border-strong)] transition">
            <RefreshCw size={12} />
            <span>{t('page.task.sync')}</span>
          </button>
        </div>
      </div>

      {/* DAG Graph Panel */}
      <div className="glass-panel relative flex flex-col">
        <div className="flex items-center gap-2 mb-3">
          <Play size={16} className="text-[var(--accent-secondary)]" />
          <h3 className="text-md font-semibold text-[var(--text-primary)]">{t('page.task.dagTitle')}</h3>
          <span className="text-[10px] text-[var(--text-muted)] ml-auto">{t('page.task.dagHint')}</span>
        </div>
        
        <div 
          id="dag-preview"
          className="w-full bg-[var(--surface-glass-subtle)] rounded-xl border border-[var(--panel-border)] overflow-hidden relative"
          style={{ height: '280px' }}
        >
          {flowNodes.length > 0 ? (
            <ReactFlow
              nodes={flowNodes}
              edges={flowEdges}
              nodeTypes={nodeTypes}
              onNodeClick={(_event, node) => setSelectedNodeId(node.id)}
              fitView
              fitViewOptions={{ padding: 0.2 }}
              nodesConnectable={false}
              nodesDraggable={false}
              zoomOnScroll={false}
              zoomOnPinch={false}
              zoomOnDoubleClick={false}
              panOnDrag={true}
              preventScrolling={true}
              attributionPosition="bottom-left"
            >
              <Background color="var(--surface-elevated)" gap={16} size={1} />
              <Controls showInteractive={false} />
            </ReactFlow>
          ) : (
            <div className="flex items-center justify-center h-full text-[var(--text-muted)]">
              {t('page.task.dagEmpty')}
            </div>
          )}
        </div>
      </div>

      {/* Combined Panels */}
      <div className="grid grid-cols-1 lg:grid-cols-5 gap-6">
        <div className="lg:col-span-3">
          <AgentOutputPanel
            outputs={outputs}
            nodes={nodes}
            selectedNodeId={selectedNodeId}
            onSelectNode={setSelectedNodeId}
          />
        </div>
        <div className="lg:col-span-2">
          <PaymentTimeline payments={payments} />
        </div>
      </div>
    </div>
  );
};

export default TaskDetailPage;
