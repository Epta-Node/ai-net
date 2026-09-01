/**
 * DAGPreview — interactive canvas tests (Issue #408)
 *
 * Covers:
 *  1. Empty-state renders correctly
 *  2. Nodes + edges render with labels
 *  3. Selecting a node shows the capability-card tooltip
 *  4. Clicking the pane deselects (tooltip hidden)
 *  5. Controls panel is present
 *  6. MiniMap is present
 *  7. Fit-view button is present and accessible
 *  8. Capability / cost data appears in tooltip
 *  9. Node aria-selected attribute reflects selection
 * 10. Deselecting with a second click on the same node
 */

import { act, render, screen, fireEvent } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { DAGPreview } from "./DAGPreview";

// ─── ReactFlow mock ──────────────────────────────────────────────────────────

type MockNode = {
  id: string;
  type?: string;
  data: Record<string, unknown>;
  selected?: boolean;
};

type MockEdge = { source: string; target: string };

let lastOnNodeClick: ((e: React.MouseEvent, node: MockNode) => void) | undefined;
let lastOnPaneClick: (() => void) | undefined;

vi.mock("reactflow", () => {
  const Controls = ({ "data-testid": testId }: { "data-testid"?: string }) => (
    <div data-testid={testId ?? "dag-controls"} aria-label="Canvas controls" />
  );

  const MiniMap = ({ "data-testid": testId }: { "data-testid"?: string }) => (
    <div data-testid={testId ?? "dag-minimap"} aria-label="Minimap" />
  );

  const Background = () => <div data-testid="dag-background" />;

  const ReactFlowMock = ({
    nodes,
    edges,
    onNodeClick,
    onPaneClick,
    children,
  }: {
    nodes: MockNode[];
    edges: MockEdge[];
    onNodeClick?: (e: React.MouseEvent, node: MockNode) => void;
    onPaneClick?: () => void;
    children?: React.ReactNode;
  }) => {
    lastOnNodeClick = onNodeClick;
    lastOnPaneClick = onPaneClick;

    return (
      <div data-testid="dag-flow">
        {nodes.map((node) => (
          <div
            key={node.id}
            data-testid={`dag-node-${node.id}`}
            data-selected={String(node.selected ?? false)}
            aria-selected={node.selected ?? false}
            aria-label={`${String(node.data.label ?? node.id)} node`}
            onClick={(e) => onNodeClick?.(e, node)}
          >
            <span data-testid={`dag-node-label-${node.id}`}>{String(node.data.label ?? "")}</span>
            {node.data.capability && (
              <span data-testid={`dag-node-cap-${node.id}`}>{String(node.data.capability)}</span>
            )}
            {/* Tooltip rendered when selected */}
            {node.selected && (
              <div data-testid="dag-node-tooltip" role="tooltip">
                <span data-testid="tooltip-label">{String(node.data.label ?? "")}</span>
                {node.data.capability && (
                  <span data-testid="tooltip-capability">{String(node.data.capability)}</span>
                )}
                {node.data.cost !== undefined && (
                  <span data-testid="tooltip-cost">{node.data.cost} XLM</span>
                )}
              </div>
            )}
          </div>
        ))}
        {edges.map((edge) => (
          <div key={`${edge.source}-${edge.target}`} data-testid="dag-edge">
            {edge.source} → {edge.target}
          </div>
        ))}
        {children}
      </div>
    );
  };

  const useReactFlow = () => ({ fitView: vi.fn() });
  const ReactFlowProvider = ({ children }: { children: React.ReactNode }) => (
    <>{children}</>
  );

  return {
    default: ReactFlowMock,
    Controls,
    MiniMap,
    Background,
    useReactFlow,
    ReactFlowProvider,
    ConnectionLineType: { SmoothStep: "smoothstep" },
    MarkerType: { ArrowClosed: "arrowclosed" },
    Position: { Left: "left", Right: "right" },
    Handle: () => null,
    BackgroundVariant: { Dots: "dots" },
  };
});

// ─── Fixture data ─────────────────────────────────────────────────────────────

const THREE_NODES = [
  { id: "research", label: "Research Agent", capability: "research", cost: 0.25 },
  { id: "risk",     label: "Risk Agent",     capability: "risk",     cost: 0.5  },
  { id: "report",   label: "Report Agent",   capability: "report",   cost: 0.1  },
];

const TWO_EDGES = [
  { source: "research", target: "risk" },
  { source: "risk",     target: "report" },
];

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("DAGPreview — empty state", () => {
  it("renders the empty-state message when no dagPreview is supplied", () => {
    render(<DAGPreview />);
    expect(screen.getByTestId("dag-preview-empty")).toBeInTheDocument();
    expect(screen.getByText(/no dag preview/i)).toBeInTheDocument();
  });

  it("renders the empty-state message when nodes array is empty", () => {
    render(<DAGPreview dagPreview={{ nodes: [], edges: [] }} />);
    expect(screen.getByTestId("dag-preview-empty")).toBeInTheDocument();
  });

  it("does not render the canvas when empty", () => {
    render(<DAGPreview />);
    expect(screen.queryByTestId("dag-flow")).not.toBeInTheDocument();
  });
});

describe("DAGPreview — nodes and edges", () => {
  beforeEach(() => {
    lastOnNodeClick = undefined;
    lastOnPaneClick = undefined;
  });

  it("renders all node labels", () => {
    render(<DAGPreview dagPreview={{ nodes: THREE_NODES, edges: TWO_EDGES }} />);
    expect(screen.getByText("Research Agent")).toBeInTheDocument();
    expect(screen.getByText("Risk Agent")).toBeInTheDocument();
    expect(screen.getByText("Report Agent")).toBeInTheDocument();
  });

  it("renders edges for each connection", () => {
    render(<DAGPreview dagPreview={{ nodes: THREE_NODES, edges: TWO_EDGES }} />);
    const edges = screen.getAllByTestId("dag-edge");
    expect(edges).toHaveLength(2);
  });

  it("renders the ReactFlow canvas wrapper", () => {
    render(<DAGPreview dagPreview={{ nodes: THREE_NODES, edges: TWO_EDGES }} />);
    expect(screen.getByTestId("dag-flow")).toBeInTheDocument();
  });
});

describe("DAGPreview — Controls and MiniMap", () => {
  it("renders the Controls panel", () => {
    render(<DAGPreview dagPreview={{ nodes: THREE_NODES, edges: TWO_EDGES }} />);
    expect(screen.getByTestId("dag-controls")).toBeInTheDocument();
  });

  it("renders the MiniMap", () => {
    render(<DAGPreview dagPreview={{ nodes: THREE_NODES, edges: TWO_EDGES }} />);
    expect(screen.getByTestId("dag-minimap")).toBeInTheDocument();
  });

  it("renders the fit-view button", () => {
    render(<DAGPreview dagPreview={{ nodes: THREE_NODES, edges: TWO_EDGES }} />);
    expect(screen.getByTestId("dag-fit-view-btn")).toBeInTheDocument();
  });

  it("fit-view button has an accessible aria-label", () => {
    render(<DAGPreview dagPreview={{ nodes: THREE_NODES, edges: TWO_EDGES }} />);
    const btn = screen.getByTestId("dag-fit-view-btn");
    expect(btn).toHaveAttribute("aria-label");
    expect(btn.getAttribute("aria-label")).not.toBe("");
  });
});

describe("DAGPreview — node click-to-select and tooltip", () => {
  beforeEach(() => {
    lastOnNodeClick = undefined;
    lastOnPaneClick = undefined;
  });

  it("onNodeClick callback is registered and fires without error", () => {
    render(<DAGPreview dagPreview={{ nodes: THREE_NODES, edges: TWO_EDGES }} />);

    expect(lastOnNodeClick).toBeDefined();

    const mockNode: MockNode = {
      id: "research",
      data: { label: "Research Agent", capability: "research", cost: 0.25, selected: false },
      selected: false,
    };

    act(() => {
      lastOnNodeClick?.({} as React.MouseEvent, mockNode);
    });

    // No error thrown — callback accepted
    expect(lastOnNodeClick).toBeDefined();
  });

  it("shows tooltip for a node when it becomes selected", () => {
    render(<DAGPreview dagPreview={{ nodes: THREE_NODES, edges: TWO_EDGES }} />);

    // Simulate a click via fireEvent on the mock node div — this triggers
    // onNodeClick in DAGPreviewInner, setting selectedNodeId to "research"
    act(() => {
      fireEvent.click(screen.getByTestId("dag-node-research"));
    });

    // After the click, the node's selected prop becomes true in the re-render,
    // causing the mock to render the tooltip
    expect(screen.getByTestId("dag-node-tooltip")).toBeInTheDocument();
  });

  it("tooltip disappears after pane click deselects the node", () => {
    render(<DAGPreview dagPreview={{ nodes: THREE_NODES, edges: TWO_EDGES }} />);

    // Select a node
    act(() => {
      fireEvent.click(screen.getByTestId("dag-node-research"));
    });
    expect(screen.getByTestId("dag-node-tooltip")).toBeInTheDocument();

    // Deselect by calling the pane click handler
    act(() => {
      lastOnPaneClick?.();
    });
    expect(screen.queryByTestId("dag-node-tooltip")).not.toBeInTheDocument();
  });

  it("tooltip shows capability label when node has capability data", () => {
    render(<DAGPreview dagPreview={{ nodes: THREE_NODES, edges: TWO_EDGES }} />);

    act(() => {
      fireEvent.click(screen.getByTestId("dag-node-research"));
    });

    expect(screen.getByTestId("tooltip-capability")).toBeInTheDocument();
    expect(screen.getByTestId("tooltip-capability").textContent).toBe("research");
  });

  it("tooltip shows cost in XLM when node has cost data", () => {
    render(<DAGPreview dagPreview={{ nodes: THREE_NODES, edges: TWO_EDGES }} />);

    act(() => {
      fireEvent.click(screen.getByTestId("dag-node-research"));
    });

    expect(screen.getByTestId("tooltip-cost").textContent).toContain("XLM");
  });

  it("pane click handler is registered and callable without error", () => {
    render(<DAGPreview dagPreview={{ nodes: THREE_NODES, edges: TWO_EDGES }} />);
    expect(lastOnPaneClick).toBeDefined();
    act(() => {
      expect(() => lastOnPaneClick?.()).not.toThrow();
    });
  });

  it("all nodes start with aria-selected=false", () => {
    render(<DAGPreview dagPreview={{ nodes: THREE_NODES, edges: TWO_EDGES }} />);
    const researchNode = screen.getByTestId("dag-node-research");
    expect(researchNode).toHaveAttribute("aria-selected", "false");
  });

  it("clicking the same node twice deselects it (toggles selection off)", () => {
    render(<DAGPreview dagPreview={{ nodes: THREE_NODES, edges: TWO_EDGES }} />);

    // First click — selects
    act(() => { fireEvent.click(screen.getByTestId("dag-node-research")); });
    expect(screen.getByTestId("dag-node-tooltip")).toBeInTheDocument();

    // Second click — deselects
    act(() => { fireEvent.click(screen.getByTestId("dag-node-research")); });
    expect(screen.queryByTestId("dag-node-tooltip")).not.toBeInTheDocument();
  });
});

describe("DAGPreview — accessibility", () => {
  it("canvas wrapper has an accessible label", () => {
    render(<DAGPreview dagPreview={{ nodes: THREE_NODES, edges: TWO_EDGES }} />);
    const canvas = screen.getByTestId("dag-preview-canvas");
    expect(canvas).toHaveAttribute("aria-label");
  });

  it("each node has an aria-label containing its label text", () => {
    render(<DAGPreview dagPreview={{ nodes: THREE_NODES, edges: TWO_EDGES }} />);
    const researchNode = screen.getByTestId("dag-node-research");
    expect(researchNode).toHaveAttribute("aria-label");
    expect(researchNode.getAttribute("aria-label")).toContain("Research Agent");
  });

  it("empty-state uses aria-live for screen readers", () => {
    render(<DAGPreview />);
    const empty = screen.getByTestId("dag-preview-empty");
    expect(empty).toHaveAttribute("aria-live");
  });
});

describe("DAGPreview — single-node graph", () => {
  it("renders a single node without edges", () => {
    render(
      <DAGPreview
        dagPreview={{
          nodes: [{ id: "solo", label: "Solo Agent" }],
          edges: [],
        }}
      />,
    );
    expect(screen.getByText("Solo Agent")).toBeInTheDocument();
    expect(screen.queryAllByTestId("dag-edge")).toHaveLength(0);
  });
});
