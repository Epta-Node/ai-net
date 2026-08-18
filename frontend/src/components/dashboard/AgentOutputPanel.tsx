import React, { useState, useEffect, useRef } from 'react';
import { ChevronDown, ChevronUp, Terminal, Copy, Check } from 'lucide-react';

interface AgentOutputPanelProps {
  outputs: Record<string, string>;
  nodes: Array<{ nodeId: string; agentType: string; status: string }>;
  selectedNodeId: string | null;
  onSelectNode: (nodeId: string) => void;
}

export const AgentOutputPanel: React.FC<AgentOutputPanelProps> = ({
  outputs,
  nodes,
  selectedNodeId,
  onSelectNode,
}) => {
  const [isOpen, setIsOpen] = useState(true);
  const [copied, setCopied] = useState(false);
  const outputContainerRef = useRef<HTMLDivElement>(null);

  // Default to first active or completed node if none selected
  useEffect(() => {
    if (!selectedNodeId && nodes.length > 0) {
      const activeNode = nodes.find(n => n.status === 'running' || n.status === 'completed') || nodes[0];
      onSelectNode(activeNode.nodeId);
    }
  }, [nodes, selectedNodeId, onSelectNode]);

  // Scroll to bottom when output updates
  const activeOutput = selectedNodeId ? outputs[selectedNodeId] || '' : '';
  
  useEffect(() => {
    if (outputContainerRef.current) {
      outputContainerRef.current.scrollTop = outputContainerRef.current.scrollHeight;
    }
  }, [activeOutput, isOpen]);

  const handleCopy = async () => {
    if (!activeOutput) return;
    try {
      await navigator.clipboard.writeText(activeOutput);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      console.error('Failed to copy text', err);
    }
  };

  return (
    <div className="glass-panel mt-6 overflow-hidden flex flex-col transition-all duration-300" style={{ minHeight: isOpen ? '380px' : '64px', height: isOpen ? '420px' : '64px' }}>
      {/* Header */}
      <div 
        className="flex justify-between items-center pb-3 border-b border-[var(--panel-border)] cursor-pointer select-none"
        onClick={() => setIsOpen(!isOpen)}
        style={{ height: '40px' }}
      >
        <div className="flex items-center gap-2">
          <Terminal size={18} className="text-indigo-400" />
          <h3 className="text-md font-semibold text-[var(--text-primary)]">Agent Execution Output</h3>
        </div>
        <div className="flex items-center gap-4">
          {isOpen && activeOutput && (
            <button 
              onClick={(e) => {
                e.stopPropagation();
                handleCopy();
              }}
              className="flex items-center gap-1.5 px-2.5 py-1 text-xs rounded bg-slate-800 hover:bg-slate-700 border border-slate-700 transition"
              title="Copy Output"
            >
              {copied ? <Check size={13} className="text-emerald-400" /> : <Copy size={13} className="text-slate-400" />}
              <span>{copied ? 'Copied' : 'Copy'}</span>
            </button>
          )}
          {isOpen ? <ChevronUp size={20} className="text-slate-400" /> : <ChevronDown size={20} className="text-slate-400" />}
        </div>
      </div>

      {isOpen && (
        <div className="flex flex-1 overflow-hidden mt-3" style={{ height: 'calc(100% - 60px)' }}>
          {/* Node Selector Sidebar */}
          <div className="w-1/4 border-r border-[var(--panel-border)] pr-3 flex flex-col gap-1.5 overflow-y-auto">
            <div className="text-[10px] uppercase font-bold text-[var(--text-secondary)] tracking-wider mb-1">Nodes</div>
            {nodes.map((node) => {
              const isActive = selectedNodeId === node.nodeId;
              const hasOutput = !!outputs[node.nodeId];
              return (
                <button
                  key={node.nodeId}
                  onClick={() => onSelectNode(node.nodeId)}
                  className={`w-full text-left px-3 py-2 rounded-lg text-xs font-medium transition flex flex-col gap-0.5 ${
                    isActive 
                      ? 'bg-indigo-600/30 text-indigo-200 border border-indigo-500/50' 
                      : 'hover:bg-slate-800/50 text-[var(--text-secondary)] border border-transparent'
                  } ${hasOutput ? 'text-slate-100' : ''}`}
                >
                  <div className="truncate font-semibold capitalize">
                    {node.nodeId.replace('node_', '').replace('node-', '')} Agent
                  </div>
                  <div className="flex items-center gap-1.5 mt-1">
                    <span className={`w-1.5 h-1.5 rounded-full ${
                      node.status === 'completed' ? 'bg-emerald-500' :
                      node.status === 'running' ? 'bg-indigo-400 animate-pulse' :
                      node.status === 'failed' ? 'bg-rose-500' : 'bg-slate-500'
                    }`} />
                    <span className="text-[9px] uppercase tracking-wider opacity-80">{node.status}</span>
                  </div>
                </button>
              );
            })}
          </div>

          {/* Terminal Console Output */}
          <div className="flex-1 pl-4 flex flex-col bg-slate-950/80 rounded-lg border border-slate-900 overflow-hidden relative">
            <div 
              ref={outputContainerRef}
              className="flex-1 overflow-y-auto p-4 font-mono text-xs leading-relaxed text-slate-300"
              style={{ contentVisibility: 'auto' }}
            >
              {activeOutput ? (
                <pre className="whitespace-pre-wrap break-words">{activeOutput}</pre>
              ) : (
                <div className="flex flex-col items-center justify-center h-full text-slate-500">
                  <Terminal size={32} className="opacity-20 mb-2" />
                  <div>
                    {selectedNodeId ? (
                      nodes.find(n => n.nodeId === selectedNodeId)?.status === 'pending'
                        ? 'Waiting for node to start...'
                        : 'Agent executing, waiting for output chunks...'
                    ) : (
                      'Select a node to view its execution output.'
                    )}
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
