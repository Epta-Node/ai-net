import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import ReactFlow, { Background, Controls, ConnectionLineType, Edge, MarkerType, Node, NodeProps, Position, Handle } from 'reactflow';
import 'reactflow/dist/style.css';
import type { DagEdge, DagNode } from '../../services/taskService';
import styles from './DAGPreview.module.css';

export type DAGPreviewProps = {
  dagPreview?: {
    nodes: DagNode[];
    edges: DagEdge[];
  };
};

interface PreviewNodeData {
  label: string;
}

const PreviewNode = ({ id, data }: NodeProps<PreviewNodeData>) => {
  const { t } = useTranslation();

  return (
    <div id={id} className="dag-node p-3 rounded-xl border border-slate-700 bg-slate-800 text-slate-100 min-w-[140px] text-center font-semibold shadow-md">
      <Handle type="target" position={Position.Left} style={{ background: '#475569', width: 6, height: 6 }} />
      <div className="text-[10px] uppercase tracking-wider opacity-65 mb-0.5">{t('agent.dagPreview')}</div>
      <div className="text-sm font-bold truncate">{data.label}</div>
      <Handle type="source" position={Position.Right} style={{ background: '#475569', width: 6, height: 6 }} />
    </div>
  );
};

const nodeTypes = {
  previewNode: PreviewNode,
};

export function DAGPreview({ dagPreview }: DAGPreviewProps) {
  const { t } = useTranslation();
  const nodes = dagPreview?.nodes ?? [];
  const edges = dagPreview?.edges ?? [];

  const flowNodes = useMemo<Node[]>(
    () =>
      nodes.map((node, index) => ({
        id: node.id,
        type: 'previewNode',
        data: { label: node.label },
        position: { x: index * 220, y: 50 },
      })),
    [nodes],
  );

  const flowEdges = useMemo<Edge[]>(
    () =>
      edges.map((edge, index) => ({
        id: `edge-${index}-${edge.source}-${edge.target}`,
        source: edge.source,
        target: edge.target,
        animated: true,
        style: { stroke: '#4b5563', strokeWidth: 2 },
        markerEnd: {
          type: MarkerType.ArrowClosed,
          color: '#4b5563',
        },
      })),
    [edges],
  );

  if (!nodes.length) {
    return (
      <div
        aria-live="polite"
        style={{
          padding: '24px',
          borderRadius: '12px',
          border: '1px dashed #cbd5e1',
          color: '#475569',
          background: '#f8fafc',
          minHeight: 180,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        {t('agent.dag.empty')}
      </div>
    );
  }

  return (
    <div className={styles.container}>
      <ReactFlow
        nodes={flowNodes}
        edges={flowEdges}
        nodeTypes={nodeTypes}
        fitView
        connectionLineType={ConnectionLineType.SmoothStep}
        attributionPosition="bottom-left"
      >
        <Controls showInteractive={false} />
        <Background color="#f8fafc" gap={16} />
      </ReactFlow>
    </div>
  );
}
