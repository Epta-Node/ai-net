import React, { useState, useMemo } from 'react';
import { useParams } from 'react-router-dom';
import ReactFlow, { Background, Controls, Handle, Position, MarkerType, Node, Edge } from 'reactflow';
import 'reactflow/dist/style.css';
import { useTaskMonitor } from '../hooks/useTaskMonitor';
import { AgentOutputPanel } from '../components/dashboard/AgentOutputPanel';
import { PaymentTimeline } from '../components/dashboard/PaymentTimeline';
import { AlertCircle, CheckCircle2, Loader2, Play, RefreshCw } from 'lucide-react';

const CustomNode: React.FC<{ id: string; data: { label: string; status: string } }> = ({ id, data }) => {
  return (
    <div id={id} className={`dag-node ${data.status} h-full flex flex-col justify-between`}>
      <Handle type="target" position={Position.Left} style={{ background: '#64748b', width: 8, height: 8 }} />
      <div>
        <div className="text-[10px] uppercase font-extrabold tracking-wider opacity-60 mb-0.5">
          Agent Node
        </div>
        <div className="text-sm font-bold truncate capitalize">{data.label}</div>
      </div>
      <div className="node-status text-[9px] font-mono font-bold uppercase tracking-widest mt-2 px-1.5 py-0.5 rounded bg-black/25 inline-block mx-auto">
        {data.status}
      </div>
      <Handle type="source" position={Position.Right} style={{ background: '#64748b', width: 8, height: 8 }} />
    </div>
  );
};

const nodeTypes = {
  custom: CustomNode,
};

const TaskDetailPage: React.FC = () => {
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
      let background = 'rgba(30, 41, 59, 0.7)';
      let borderColor = 'rgba(255, 255, 255, 0.08)';
      let boxShadow = 'none';
      let color = '#94a3b8';

      if (node.status === 'completed') {
        background = 'rgba(6, 78, 59, 0.8)';
        borderColor = 'var(--success)';
        boxShadow = '0 0 15px rgba(16, 185, 129, 0.35)';
        color = '#a7f3d0';
      } else if (node.status === 'running') {
        background = 'rgba(30, 27, 75, 0.8)';
        borderColor = 'var(--primary)';
        boxShadow = '0 0 15px rgba(99, 102, 241, 0.45)';
        color = '#e0e7ff';
      } else if (node.status === 'failed') {
        background = 'rgba(76, 5, 25, 0.8)';
        borderColor = 'var(--danger)';
        boxShadow = '0 0 15px rgba(239, 68, 68, 0.35)';
        color = '#fecdd3';
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
          borderRadius: '16px',
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
          let strokeColor = '#475569';
          let animated = false;
          
          if (node.status === 'completed') {
            strokeColor = '#10b981'; // green for completed paths
          } else if (node.status === 'running') {
            strokeColor = '#6366f1'; // blue animated for active paths
            animated = true;
          } else if (node.status === 'failed') {
            strokeColor = '#ef4444'; // red for failed paths
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
    return (
      <div className="flex flex-col items-center justify-center min-h-[400px]">
        <Loader2 className="animate-spin text-indigo-500 mb-4" size={40} />
        <p className="text-slate-400">Loading live task execution status...</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="glass-panel border-rose-500/30 text-center py-12">
        <AlertCircle className="text-rose-500 mx-auto mb-4" size={48} />
        <h2 className="text-xl font-bold text-slate-100 mb-2">Error Loading Task</h2>
        <p className="text-rose-300/80 mb-6">{error.message}</p>
        <button onClick={refetch} className="flex items-center gap-2 mx-auto">
          <RefreshCw size={16} />
          <span>Retry</span>
        </button>
      </div>
    );
  }

  // Get current WS status color/label
  const getWsStatusBadge = () => {
    switch (wsStatus) {
      case 'connected':
        return {
          bg: 'rgba(16, 185, 129, 0.15)',
          border: 'rgba(16, 185, 129, 0.3)',
          color: '#a7f3d0',
          label: 'connected',
        };
      case 'connecting':
        return {
          bg: 'rgba(245, 158, 11, 0.15)',
          border: 'rgba(245, 158, 11, 0.3)',
          color: '#fde68a',
          label: 'connecting',
        };
      case 'error':
      case 'disconnected':
      default:
        return {
          bg: 'rgba(239, 68, 68, 0.15)',
          border: 'rgba(239, 68, 68, 0.3)',
          color: '#fca5a5',
          label: 'disconnected',
        };
    }
  };

  const wsBadge = getWsStatusBadge();

  return (
    <div className="space-y-6">
      {/* Task failed banner */}
      {failedNode && (
        <div className="p-4 bg-rose-950/60 border border-rose-500/50 rounded-xl flex items-start gap-3 text-rose-200 animate-fadeIn" role="alert">
          <AlertCircle className="text-rose-400 mt-0.5 shrink-0" size={20} />
          <div>
            <h4 className="font-bold text-sm">Task Execution Failed</h4>
            <p className="text-xs text-rose-300 mt-0.5">
              Node <span className="font-mono font-bold capitalize">{failedNode.nodeId.replace('node_', '').replace('node-', '')}</span> failed: {failedNode.error || 'Unknown execution error'}
            </p>
          </div>
        </div>
      )}

      {/* Task completed banner */}
      {task?.status === 'completed' && !failedNode && (
        <div className="p-4 bg-emerald-950/60 border border-emerald-500/50 rounded-xl flex items-start gap-3 text-emerald-200 animate-fadeIn" role="alert">
          <CheckCircle2 className="text-emerald-400 mt-0.5 shrink-0" size={20} />
          <div>
            <h4 className="font-bold text-sm">Task Completed Successfully</h4>
            <p className="text-xs text-emerald-300 mt-0.5">
              All agent execution steps finished and payments have been released to respective providers.
            </p>
          </div>
        </div>
      )}

      {/* Details Header */}
      <div className="glass-panel flex flex-col md:flex-row justify-between items-start md:items-center gap-4">
        <div>
          <div className="flex items-center gap-3">
            <h1 className="text-xl md:text-2xl font-bold tracking-tight">Task Monitoring</h1>
            <span
              id="ws-status"
              className="chip text-[10px] tracking-wider uppercase"
              style={{
                background: wsBadge.bg,
                borderColor: wsBadge.border,
                color: wsBadge.color,
              }}
            >
              WS: {wsBadge.label}
            </span>
          </div>
          <p className="text-xs text-[var(--text-secondary)] font-mono mt-1">
            Task ID: {id}
          </p>
          {task?.prompt && (
            <p className="text-sm text-slate-300 mt-3 italic border-l-2 border-indigo-500 pl-3">
              "{task.prompt}"
            </p>
          )}
        </div>

        <div className="flex items-center gap-3 self-stretch md:self-auto justify-between">
          <div className="text-right hidden sm:block">
            <div className="text-[10px] uppercase font-bold text-[var(--text-secondary)]">Status</div>
            <div className={`text-xs font-extrabold capitalize mt-0.5 ${
              task?.status === 'completed' ? 'text-emerald-400' :
              task?.status === 'failed' ? 'text-rose-400' : 'text-indigo-400'
            }`}>
              {task?.status || 'queued'}
            </div>
          </div>
          <button onClick={refetch} className="flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-lg bg-slate-800 hover:bg-slate-700 border border-slate-700 transition">
            <RefreshCw size={12} />
            <span>Sync</span>
          </button>
        </div>
      </div>

      {/* DAG Graph Panel */}
      <div className="glass-panel relative flex flex-col">
        <div className="flex items-center gap-2 mb-3">
          <Play size={16} className="text-indigo-400" />
          <h3 className="text-md font-semibold text-[var(--text-primary)]">Execution DAG Status</h3>
          <span className="text-[10px] text-slate-500 ml-auto">Click node to inspect logs</span>
        </div>
        
        <div 
          id="dag-preview"
          className="w-full bg-slate-950/40 rounded-xl border border-[var(--panel-border)] overflow-hidden relative"
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
              <Background color="#1e293b" gap={16} size={1} />
              <Controls showInteractive={false} />
            </ReactFlow>
          ) : (
            <div className="flex items-center justify-center h-full text-slate-500">
              No nodes configured in the DAG
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
