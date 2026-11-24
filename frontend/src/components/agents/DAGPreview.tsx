import { useCallback, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import ReactFlow, {
  Background,
  BackgroundVariant,
  Controls,
  MiniMap,
  ConnectionLineType,
  Edge,
  MarkerType,
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
// Local extensions only — `types/api.ts` is intentionally left untouched.
// `capability`, `cost`, `status` and edge `label` are optional enrichment
// fields; we gracefully omit them when absent.

export type NodeExecutionStatus = 'pending' | 'running' | 'completed' | 'failed';

export type DAGPreviewProps = {
  dagPreview?: {
    nodes: Array<DagNode & { capability?: string; cost?: number; status?: string }>;
    edges: Array<DagEdge & { label?: string }>;
  };
  /** Live execution statuses keyed by node id (e.g. from WebSocket state). */
  liveStatuses?: Record<string, string>;
  /** Controlled selection — when omitted the canvas manages selection itself. */
  selectedNodeId?: string | null;
  onNodeSelect?: (nodeId: string | null) => void;
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
  status?: NodeExecutionStatus;
  /** Whether this node is currently selected. */
  selected?: boolean;
}

/** Normalise caller-supplied status strings to the four rendered states. */
function normalizeStatus(raw?: string): NodeExecutionStatus | undefined {
  if (!raw) return undefined;
  const s = raw.toLowerCase();
  if (s === 'pending' || s === 'queued') return 'pending';
  if (s === 'running' || s === 'in_progress' || s === 'active') return 'running';
  if (s === 'completed' || s === 'complete' || s === 'success') return 'completed';
  if (s === 'failed' || s === 'failure' || s === 'error') return 'failed';
  return undefined;
}

function statusClassName(status?: NodeExecutionStatus): string {
  switch (status) {
    case 'pending':
      return styles.nodePending;
    case 'running':
      return styles.nodeRunning;
    case 'completed':
      return styles.nodeCompleted;
    case 'failed':
      return styles.nodeFailed;
    default:
      return '';
  }
}

// ─── Capability colour map ──────────────────────────────────────────────────

const CAPABILITY_COLORS: Record<string, string> = {
  research: 'var(--agent-research)',
  risk:     'var(--agent-risk)',
  coding:   'var(--agent-coding)',
  design:   'var(--agent-design)',
  report:   'var(--agent-report)',
};

function capabilityColor(capability?: string): string {
  if (!capability) return 'var(--accent)';
  return CAPABILITY_COLORS[capability.toLowerCase()] ?? 'var(--accent)';
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
      className={`${styles.node} ${statusClassName(data.status)} ${selected ? styles.nodeSelected : ''}`}
      style={{ '--node-accent': accentColor } as React.CSSProperties}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      aria-selected={selected}
      aria-label={`${data.label} node`}
      data-testid={`dag-node-${id}`}
      data-status={data.status ?? 'none'}
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
        <div className={`${styles.nodeStatus} ${styles[`status_${data.status}`]}`} data-testid={`dag-node-status-${id}`}>
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

// ─── PNG export (Canvas serialization — reactflow@11 has no toPng export) ───

const STATUS_FILL: Record<NodeExecutionStatus, string> = {
  pending: '#1e293b',
  running: '#0e7490',
  completed: '#065f46',
  failed: '#7f1d1d',
};

function ExportButton() {
  const { getNodes, getEdges } = useReactFlow();
  const handleExport = useCallback(() => {
    try {
      const rfNodes = getNodes();
      if (!rfNodes.length) return;

      let minX = Infinity;
      let minY = Infinity;
      let maxX = -Infinity;
      let maxY = -Infinity;
      rfNodes.forEach((n) => {
        const w = 170;
        const h = 76;
        minX = Math.min(minX, n.position.x);
        minY = Math.min(minY, n.position.y);
        maxX = Math.max(maxX, n.position.x + w);
        maxY = Math.max(maxY, n.position.y + h);
      });

      const pad = 48;
      const width = Math.max(1, Math.ceil(maxX - minX + pad * 2));
      const height = Math.max(1, Math.ceil(maxY - minY + pad * 2));

      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext('2d');
      if (!ctx) return;

      ctx.fillStyle = '#0a0e14';
      ctx.fillRect(0, 0, width, height);

      const center = (x: number, y: number) => ({ x: x - minX + pad, y: y - minY + pad });

      // Edges under nodes
      const rfEdges = getEdges();
      ctx.strokeStyle = '#4b5563';
      ctx.lineWidth = 2;
      ctx.font = '11px sans-serif';
      rfEdges.forEach((e) => {
        const s = rfNodes.find((n) => n.id === e.source);
        const tg = rfNodes.find((n) => n.id === e.target);
        if (!s || !tg) return;
        const p1 = center(s.position.x + 170, s.position.y + 38);
        const p2 = center(tg.position.x, tg.position.y + 38);
        ctx.beginPath();
        ctx.moveTo(p1.x, p1.y);
        ctx.lineTo(p2.x, p2.y);
        ctx.stroke();
        if (typeof e.label === 'string' && e.label) {
          ctx.fillStyle = '#94a3b8';
          ctx.fillText(e.label.slice(0, 48), (p1.x + p2.x) / 2 - 20, (p1.y + p2.y) / 2 - 6);
        }
      });

      // Nodes
      rfNodes.forEach((n) => {
        const data = n.data as PreviewNodeData | undefined;
        const status = data?.status;
        const p = center(n.position.x, n.position.y);
        const w = 170;
        const h = 64;
        ctx.fillStyle = status ? STATUS_FILL[status] : '#1e293b';
        ctx.fillRect(p.x, p.y, w, h);
        ctx.strokeStyle =
          status === 'completed' ? '#34d399'
          : status === 'running' ? '#22d3ee'
          : status === 'failed' ? '#f87171'
          : '#475569';
        ctx.lineWidth = 2;
        ctx.strokeRect(p.x, p.y, w, h);
        ctx.fillStyle = '#f1f5f9';
        ctx.font = 'bold 12px sans-serif';
        ctx.fillText(String(data?.label ?? n.id).slice(0, 26), p.x + 10, p.y + 24);
        if (status) {
          ctx.fillStyle = '#cbd5e1';
          ctx.font = '10px sans-serif';
          ctx.fillText(status.toUpperCase(), p.x + 10, p.y + 46);
        }
      });

      const url = canvas.toDataURL('image/png');
      const link = document.createElement('a');
      link.href = url;
      link.download = 'dag.png';
      document.body.appendChild(link);
      link.click();
      link.remove();
    } catch {
      // Canvas unavailable (e.g. jsdom) — export is a no-op there.
    }
  }, [getNodes, getEdges]);

  return (
    <button
      className={styles.exportBtn}
      onClick={handleExport}
      aria-label="Export DAG as PNG"
      title="Export DAG as PNG"
      data-testid="dag-export-btn"
      type="button"
    >
      ⤓ PNG
    </button>
  );
}

// ─── MiniMap node coloring ──────────────────────────────────────────────────

function miniMapNodeColor(node: Node): string {
  const data = node.data as PreviewNodeData | undefined;
  return capabilityColor(data?.capability ?? data?.label);
}

// ─── Main component (needs Provider for useReactFlow) ───────────────────────

interface InnerProps {
  nodes: Array<DagNode & { capability?: string; cost?: number; status?: string }>;
  edges: Array<DagEdge & { label?: string }>;
  liveStatuses?: Record<string, string>;
  controlledSelectedId?: string | null;
  onNodeSelect?: (nodeId: string | null) => void;
}

function DAGPreviewInner({ nodes, edges, liveStatuses, controlledSelectedId, onNodeSelect }: InnerProps) {
  const { t } = useTranslation();
  const [internalSelectedId, setInternalSelectedId] = useState<string | null>(null);

  const isControlled = controlledSelectedId !== undefined || onNodeSelect !== undefined;
  const selectedNodeId = isControlled ? (controlledSelectedId ?? null) : internalSelectedId;

  // ── Stable topology: positions are derived from node identity ONCE and
  // cached. WebSocket status updates change `liveStatuses` / node data only
  // and never re-run layout, so active pan/zoom viewport stays stable.
  const topologyKey = useMemo(() => nodes.map((n) => n.id).join('|'), [nodes]);
  const positionsRef = useRef(new Map<string, { x: number; y: number }>());
  const positions = useMemo(() => {
    const known = new Set(nodes.map((n) => n.id));
    // Drop removed nodes so long-lived sessions don't leak entries.
    positionsRef.current.forEach((_, key) => {
      if (!known.has(key)) positionsRef.current.delete(key);
    });
    nodes.forEach((n) => {
      if (!positionsRef.current.has(n.id)) {
        positionsRef.current.set(n.id, { x: positionsRef.current.size * 230, y: 60 });
      }
    });
    return positionsRef.current;
    // Topology only — status-only updates must not re-run layout.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [topologyKey]);

  const flowNodes = useMemo<Node<PreviewNodeData>[]>(
    () =>
      nodes.map((node) => {
        // Support extended DagNode fields if present (capability / cost)
        const ext = node as DagNode & { capability?: string; cost?: number; status?: string };
        const liveRaw = liveStatuses?.[node.id];
        const status = normalizeStatus(liveRaw ?? ext.status);
        const isSelected = selectedNodeId === node.id;

        return {
          id: node.id,
          type: 'previewNode',
          data: {
            label: node.label,
            capability: ext.capability,
            cost: ext.cost,
            status,
            selected: isSelected,
          },
          // Stable horizontal layout; positions cached by topology, untouched
          // by in-place data updates so pan/zoom never jumps on WS events.
          position: positions.get(node.id) ?? { x: 0, y: 60 },
          selected: isSelected,
          // Nodes are not draggable in preview — only in full task detail view
          draggable: false,
        };
      }),
    [nodes, liveStatuses, selectedNodeId, positions],
  );

  const flowEdges = useMemo<Edge[]>(
    () =>
      edges.map((edge, index) => {
        const ext = edge as DagEdge & { label?: string };
        const label = typeof ext.label === 'string' ? ext.label : undefined;
        return {
          id: `edge-${index}-${edge.source}-${edge.target}`,
          source: edge.source,
          target: edge.target,
          animated: true,
          type: 'smoothstep',
          style: { stroke: '#4b5563', strokeWidth: 2 },
          markerEnd: {
            type: MarkerType.ArrowClosed,
            color: 'var(--text-secondary)',
          },
          // Data-flow label between nodes; omitted when the caller supplies
          // a plain { source, target } edge (clean fallback: arrow only).
          ...(label
            ? {
                label,
                labelBgPadding: [6, 4] as [number, number],
                labelBgBorderRadius: 6,
                labelBgStyle: { fill: '#0f172a', fillOpacity: 0.9 },
                labelStyle: { fill: '#94a3b8', fontSize: 11 },
              }
            : {}),
        };
      }),
    [edges],
  );

  const handleNodeClick = useCallback(
    (_: React.MouseEvent, node: Node) => {
      const next = selectedNodeId === node.id ? null : node.id;
      if (isControlled) {
        onNodeSelect?.(next);
      } else {
        setInternalSelectedId(next);
      }
    },
    [isControlled, onNodeSelect, selectedNodeId],
  );

  const handlePaneClick = useCallback(() => {
    if (isControlled) {
      onNodeSelect?.(null);
    } else {
      setInternalSelectedId(null);
    }
  }, [isControlled, onNodeSelect]);

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

        {/* Built-in zoom (+/-) / fit-to-view controls */}
        <Controls
          aria-label={t('agent.dag.controls')}
          showZoom
          showFitView
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

        {/* PNG export (Canvas serialization) */}
        <ExportButton />
      </ReactFlow>

      {/* Hint line */}
      <p className={styles.hint} aria-hidden="true">
        {t('agent.dag.hint')}
      </p>
    </div>
  );
}

// ─── Public export (wrapped in Provider) ────────────────────────────────────

export function DAGPreview({ dagPreview, liveStatuses, selectedNodeId, onNodeSelect }: DAGPreviewProps) {
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
      <DAGPreviewInner
        nodes={nodes}
        edges={edges}
        liveStatuses={liveStatuses}
        controlledSelectedId={selectedNodeId}
        onNodeSelect={onNodeSelect}
      />
    </ReactFlowProvider>
  );
}
