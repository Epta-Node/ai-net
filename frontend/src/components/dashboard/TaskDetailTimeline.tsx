import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Terminal, Clock, CheckCircle2, XCircle, ChevronDown, ChevronRight, Copy, Check, Loader2 } from 'lucide-react';
import type { DAGNode } from '../../types/api';

interface TaskDetailTimelineProps {
  nodes: DAGNode[];
  outputs: Record<string, string>;
}

export const TaskDetailTimeline: React.FC<TaskDetailTimelineProps> = ({ nodes, outputs }) => {
  const { t } = useTranslation();
  const [expandedNodes, setExpandedNodes] = useState<Set<string>>(new Set([nodes[0]?.nodeId]));
  const [copiedId, setCopiedId] = useState<string | null>(null);

  const toggleNode = (nodeId: string) => {
    setExpandedNodes(prev => {
      const next = new Set(prev);
      if (next.has(nodeId)) {
        next.delete(nodeId);
      } else {
        next.add(nodeId);
      }
      return next;
    });
  };

  const handleCopy = async (e: React.MouseEvent, output: string, id: string) => {
    e.stopPropagation();
    try {
      await navigator.clipboard.writeText(output);
      setCopiedId(id);
      setTimeout(() => setCopiedId(null), 2000);
    } catch (err) {
      console.error('Failed to copy text', err);
    }
  };

  if (!nodes || nodes.length === 0) {
    return (
      <div className="glass-panel text-center py-8 text-slate-500">
        {t('page.task.dagEmpty', 'No steps available.')}
      </div>
    );
  }

  return (
    <div className="glass-panel">
      <div className="flex items-center gap-2 pb-4 border-b border-[var(--panel-border)] mb-4">
        <Terminal className="text-indigo-400" size={18} />
        <h3 className="text-md font-semibold text-[var(--text-primary)]">Task Timeline</h3>
      </div>
      
      <div className="relative border-l-2 border-slate-700/60 ml-4 pl-6 space-y-6 py-2">
        {nodes.map((node, index) => {
          const isExpanded = expandedNodes.has(node.nodeId);
          const hasOutput = !!outputs[node.nodeId];
          const isLast = index === nodes.length - 1;

          // Status colors
          let statusColor = 'bg-slate-500 text-slate-400 border-slate-500/50';
          let StatusIcon = Clock;
          let isPulsing = false;
          let connectorClass = 'bg-slate-700/60';

          if (node.status === 'completed') {
            statusColor = 'bg-emerald-500/20 text-emerald-400 border-emerald-500/50';
            StatusIcon = CheckCircle2;
            connectorClass = 'bg-emerald-500/60';
          } else if (node.status === 'running') {
            statusColor = 'bg-indigo-500/20 text-indigo-400 border-indigo-500/50';
            StatusIcon = Loader2;
            isPulsing = true;
            connectorClass = 'bg-indigo-500/60 animate-pulse';
          } else if (node.status === 'failed') {
            statusColor = 'bg-rose-500/20 text-rose-400 border-rose-500/50';
            StatusIcon = XCircle;
            connectorClass = 'bg-rose-500/60';
          }

          return (
            <div key={node.nodeId} className="relative group">
              {/* Connector line (if not last) - absolute positioned to override default border color if active */}
              {!isLast && node.status !== 'pending' && (
                <div 
                  className={`absolute -left-[26px] top-6 w-[2px] h-[calc(100%+8px)] ${connectorClass} transition-colors duration-300`} 
                  aria-hidden="true"
                />
              )}

              {/* Timeline dot */}
              <span className={`absolute -left-[35px] top-1.5 flex items-center justify-center w-6 h-6 rounded-full ring-4 ring-[#0f172a] border transition-colors duration-300 ${statusColor} ${isPulsing ? 'animate-pulse' : ''}`}>
                <StatusIcon size={12} className={isPulsing ? 'animate-spin' : ''} />
              </span>

              {/* Node Card */}
              <div 
                className={`p-4 bg-slate-800/40 rounded-xl border transition duration-200 cursor-pointer ${
                  node.status === 'failed' ? 'border-rose-500/40 hover:border-rose-500/60' : 'border-slate-700/40 hover:border-slate-600/60'
                }`}
                onClick={() => toggleNode(node.nodeId)}
              >
                <div className="flex justify-between items-center">
                  <div className="flex items-center gap-3">
                    {isExpanded ? <ChevronDown size={18} className="text-slate-400" /> : <ChevronRight size={18} className="text-slate-400" />}
                    <div>
                      <h4 className="text-sm font-bold text-slate-200 capitalize">
                        {node.nodeId.replace('node_', '').replace('node-', '')}
                      </h4>
                      <div className="text-[10px] text-slate-500 mt-0.5">
                        <span className="uppercase font-bold tracking-wider">{node.status}</span>
                        {node.agentType && <span className="ml-2 px-1.5 py-0.5 bg-slate-900 rounded">{node.agentType}</span>}
                      </div>
                    </div>
                  </div>
                  
                  <div className="flex flex-col items-end gap-2">
                    {hasOutput && (
                      <button
                        onClick={(e) => handleCopy(e, outputs[node.nodeId], node.nodeId)}
                        className="flex items-center gap-1.5 px-2 py-1 text-xs rounded bg-slate-900/80 hover:bg-slate-700 border border-slate-700 transition"
                      >
                        {copiedId === node.nodeId ? <Check size={12} className="text-emerald-400" /> : <Copy size={12} className="text-slate-400" />}
                        <span>{copiedId === node.nodeId ? 'Copied' : 'Copy'}</span>
                      </button>
                    )}
                  </div>
                </div>

                {/* Error message */}
                {node.status === 'failed' && node.error && (
                  <div className="mt-3 p-3 bg-rose-950/40 border border-rose-900/50 rounded-lg text-xs text-rose-300 font-mono">
                    {node.error}
                  </div>
                )}

                {/* Agent Output Log */}
                {isExpanded && (
                  <div className="mt-3 border-t border-slate-700/50 pt-3">
                    {hasOutput ? (
                      <div className="bg-[#0b0f19] p-3 rounded-lg border border-slate-800">
                        <pre className="text-xs font-mono text-slate-300 whitespace-pre-wrap break-words">
                          {outputs[node.nodeId]}
                        </pre>
                      </div>
                    ) : (
                      <div className="flex items-center gap-2 text-xs text-slate-500 italic p-2">
                        {node.status === 'running' ? (
                          <><Loader2 size={12} className="animate-spin" /> Waiting for output...</>
                        ) : (
                          'No output available for this step.'
                        )}
                      </div>
                    )}
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
};
