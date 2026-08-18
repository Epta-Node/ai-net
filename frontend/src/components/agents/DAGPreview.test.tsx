import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { DAGPreview } from "./DAGPreview";

type FlowNode = {
  id: string;
  data: {
    label: string;
  };
};

type FlowEdge = {
  source: string;
  target: string;
};

vi.mock("reactflow", () => ({
  default: ({ nodes, edges }: { nodes: FlowNode[]; edges: FlowEdge[] }) => (
    <div data-testid="dag-flow">
      {nodes.map((node) => (
        <div key={node.id}>{node.data.label}</div>
      ))}
      {edges.map((edge) => (
        <div key={`${edge.source}-${edge.target}`} data-testid="dag-edge">
          {edge.source} depends on {edge.target}
        </div>
      ))}
    </div>
  ),
  ConnectionLineType: {
    SmoothStep: "smoothstep",
  },
  MarkerType: {
    ArrowClosed: "arrowclosed",
  },
  Position: {
    Left: "left",
    Right: "right",
  },
  Controls: () => null,
  Background: () => null,
  Handle: () => null,
}));

describe("DAGPreview", () => {
  it("renders nodes with agent labels and dependency edges", () => {
    render(
      <DAGPreview
        dagPreview={{
          nodes: [
            { id: "research", label: "Research Agent" },
            { id: "risk", label: "Risk Agent" },
            { id: "report", label: "Report Agent" },
          ],
          edges: [
            { source: "research", target: "risk" },
            { source: "risk", target: "report" },
          ],
        }}
      />,
    );

    expect(screen.getByText("Research Agent")).toBeInTheDocument();
    expect(screen.getByText("Risk Agent")).toBeInTheDocument();
    expect(screen.getByText("Report Agent")).toBeInTheDocument();
    expect(screen.getByText("research depends on risk")).toBeInTheDocument();
    expect(screen.getByText("risk depends on report")).toBeInTheDocument();
  });
});
