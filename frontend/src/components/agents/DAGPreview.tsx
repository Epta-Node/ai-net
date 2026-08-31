import { useCallback, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import ReactFlow, {
  Background,
  BackgroundVariant,
  Controls,
  MiniMap,
  ConnectionLineType,
  Edge,
  MarkerType,
  MiniMapNodeProps,
  Node,
  NodeProps,
  Position,
  Handle,
  useReactFlow,
  ReactFlowProvider,
} from 'reactflow';
import 'reactflow/dist/style.css';
import type { DagEdge, DagNode } from '../../services/taskService';
import styles from './DAGPreview.module.css';

// ─── Types ─────────────────────────────────────────────────────────────────

export type DAGPreviewProps = {
  dagPreview?: {
    nodes: DagNode[];
    edges: DagEdge[];
  };
};

/**
 * Data attached to every ReactFlow node.
 * `capability` and `cost` are optional enrichment fields — callers may supply
 * them via the extended `DagNode` type; we gracefully omit them when absent.
 */
export interface PreviewNodeData {
  label: string;
  /** Agent capability type, e.g. "research", "risk". */
  capability?: string;
  /** Cost in XLM. */
  cost?: number;
  /** Execution status forwarded from real-time data when available. */
  status?: 'pending' | 'running' | 'completed' | 'failed';
  /** Whether this node is currently selected. */
  selected?: boolean;
}

// ─── Capability colour map ──────────────────────────────────────────────────

const CAPABILITY_COLORS: Record<string, string> = {
  research: '#38bdf8',
  risk:     '#f59e0b',
  coding:   '#a78bfa',
  design:   '#34d399',
  report:   '#fb7185',
};

function capabilityColor(capability?: string): string {
  if (!capability) return '#8b5cf6';
  return CAPABILITY_COLORS[capability.toLowerCase()] ?? '#8b5cf6';
}

// ─── Tooltip component ──────────────────────────────────────────────────────

interface TooltipProps {
  data: PreviewNodeData;
  nodeId: string;
}

function NodeTooltip({ data, nodeId }: TooltipProps) {
  const { t } = useTranslation();
  const cap = data.capability ?? data.label.toLowerCase();

  return (
    <div
      className={styles.tooltip}
      role="tooltip"
      aria-label={t('agent.dag.tooltip.selected')}
      data-testid="dag-node-tooltip"
    >
      <div className={styles.tooltipHeader} style={{ borderColor: capabilityColor(cap) }}>
        <span
          className={styles.tooltipDot}
          style={{ background: capabilityColor(cap) }}
          aria-hidden="true"
        />
        <span className={styles.tooltipTitle}>{data.label}</span>
      </div>

      <dl className={styles.tooltipBody}>
        {data.capability && (
          <div className={styles.tooltipRow}>
            <dt>{t('agent.dag.tooltip.capability')}</dt>
            <dd style={{ color: capabilityColor(cap) }}>{data.capability}</dd>
          </div>
        )}
        {data.cost !== undefined && (
          <div className={styles.tooltipRow}>
            <dt>{t('agent.dag.tooltip.cost')}</dt>
            <dd>{data.cost} XLM</dd>
          </div>
        )}
        {data.status && (
          <div className={styles.tooltipRow}>
            <dt>{t('agent.dag.tooltip.status')}</dt>
            <dd className={styles[`status_${data.status}`]}>{data.status}</dd>
          </div>
        )}
        <div className={styles.tooltipRow}>
          <dt>{t('agent.dag.tooltip.nodeId')}</dt>
          <dd className={styles.tooltipMono}>{nodeId}</dd>
        </div>
      </dl>
    </div>
  );
}

// ─── Custom node ────────────────────────────────────────────────────────────

function PreviewNode({ id, data, selected }: NodeProps<PreviewNodeData>) {
  const [hovered, setHovered] = useState(false);
  const accentColor = capabilityColor(data.capability ?? data.label);

  const showTooltip = selected || hovered;

  return (
    <div
      className={`${styles.node} ${selected ? styles.nodeSelected : ''}`}
      style={{ '--node-accent': accentColor } as React.CSSProperties}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      aria-selected={selected}
      aria-label={`${data.label} node`}
      data-testid={`dag-node-${id}`}
    >
      <Handle
        type="target"
        position={Position.Left}
        className={styles.handle}
        aria-hidden="true"
      />

      <div className={styles.nodeCapBadge} style={{ background: accentColor }}>
        {(data.capability ?? data.label).slice(0, 2).toUpperCase()}
      </div>

      <div className={styles.nodeLabel}>{data.label}</div>

      {data.status && (
        <div className={`${styles.nodeStatus} ${styles[`status_${data.status}`]}`}>
          {data.status}
        </div>
      )}

      <Handle
        type="source"
        position={Position.Right}
        className={styles.handle}
        aria-hidden="true"
      />

      {showTooltip && (
        <NodeTooltip data={data} nodeId={id} />
      )}
    </div>
  );
}

const nodeTypes = { previewNode: PreviewNode };

// ─── Fit-view button (uses ReactFlow context) ───────────────────────────────

function FitViewButton() {
  const { t } = useTranslation();
  const { fitView } = useReactFlow();
  const handleFit = useCallback(() => {
    fitView({ padding: 0.25, duration: 300 });
  }, [fitView]);
  return (
    <button
      className={styles.fitViewBtn}
      onClick={handleFit}
      aria-label={t('agent.dag.fitView')}
      data-testid="dag-fit-view-btn"
      type="button"
    >
      ⊡
    </button>
  );
}

// ─── MiniMap node coloring ──────────────────────────────────────────────────

function miniMapNodeColor(node: MiniMapNodeProps): string {
  const data = node.data as PreviewNodeData | undefined;
  return capabilityColor(data?.capability ?? data?.label);
}

// ─── Main component (needs Provider for useReactFlow) ───────────────────────

interface InnerProps {
  nodes: DagNode[];
  edges: DagEdge[];
}

function DAGPreviewInner({ nodes, edges }: InnerProps) {
  const { t } = useTranslation();
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);

  const flowNodes = useMemo<Node<PreviewNodeData>[]>(
    () =>
      nodes.map((node, index) => {
        // Support extended DagNode fields if present (capability / cost)
        const ext = node as DagNode & { capability?: string; cost?: number; status?: string };
        const isSelected = selectedNodeId === node.id;

        return {
          id: node.id,
          type: 'previewNode',
          data: {
            label: node.label,
            capability: ext.capability,
            cost: ext.cost,
            status: ext.status as PreviewNodeData['status'],
            selected: isSelected,
          },
          // Lay out horizontally; if only 1 node vertically centre it
          position: { x: index * 230, y: 60 },
          selected: isSelected,
          // Nodes are not draggable in preview — only in full task detail view
          draggable: false,
        };
      }),
    [nodes, selectedNodeId],
  );

  const flowEdges = useMemo<Edge[]>(
    () =>
      edges.map((edge, index) => ({
        id: `edge-${index}-${edge.source}-${edge.target}`,
        source: edge.source,
        target: edge.target,
        animated: true,
        type: 'smoothstep',
        style: { stroke: '#4b5563', strokeWidth: 2 },
        markerEnd: {
          type: MarkerType.ArrowClosed,
          color: '#4b5563',
        },
      })),
    [edges],
  );

  const handleNodeClick = useCallback(
    (_: React.MouseEvent, node: Node) => {
      setSelectedNodeId((prev) => (prev === node.id ? null : node.id));
    },
    [],
  );

  const handlePaneClick = useCallback(() => {
    setSelectedNodeId(null);
  }, []);

  return (
    <div
      className={styles.container}
      aria-label={t('agent.dag.controls')}
      data-testid="dag-preview-canvas"
    >
      <ReactFlow
        nodes={flowNodes}
        edges={flowEdges}
        nodeTypes={nodeTypes}
        onNodeClick={handleNodeClick}
        onPaneClick={handlePaneClick}
        fitView
        fitViewOptions={{ padding: 0.25 }}
        connectionLineType={ConnectionLineType.SmoothStep}
        // ── Interaction toggles ─────────────────────────────────────────────
        zoomOnScroll
        zoomOnPinch
        zoomOnDoubleClick={false}
        panOnDrag
        panOnScroll={false}
        nodesConnectable={false}
        nodesDraggable={false}
        preventScrolling
        // ── Attribution ─────────────────────────────────────────────────────
        attributionPosition="bottom-left"
        proOptions={{ hideAttribution: false }}
      >
        {/* Dot-grid background matching dark theme */}
        <Background
          variant={BackgroundVariant.Dots}
          color="#1e293b"
          gap={20}
          size={1}
        />

        {/* Built-in zoom / fit controls */}
        <Controls
          aria-label={t('agent.dag.controls')}
          showInteractive={false}
          data-testid="dag-controls"
        />

        {/* Mini-map for large graphs */}
        <MiniMap
          nodeColor={miniMapNodeColor}
          maskColor="rgba(10, 14, 20, 0.8)"
          className={styles.minimap}
          aria-label={t('agent.dag.minimap')}
          data-testid="dag-minimap"
        />

        {/* Custom fit-view button overlaid top-right */}
        <FitViewButton />
      </ReactFlow>

      {/* Hint line */}
      <p className={styles.hint} aria-hidden="true">
        {t('agent.dag.hint')}
      </p>
    </div>
  );
}

// ─── Public export (wrapped in Provider) ────────────────────────────────────

export function DAGPreview({ dagPreview }: DAGPreviewProps) {
  const { t } = useTranslation();
  const nodes = dagPreview?.nodes ?? [];
  const edges = dagPreview?.edges ?? [];

  if (!nodes.length) {
    return (
      <div
        aria-live="polite"
        className={styles.empty}
        data-testid="dag-preview-empty"
      >
        {t('agent.dag.empty')}
      </div>
    );
  }

  return (
    <ReactFlowProvider>
      <DAGPreviewInner nodes={nodes} edges={edges} />
    </ReactFlowProvider>
  );
}
