import type { DAGNode } from "../types/task";

/**
 * Deterministically decomposes a prompt into a DAG of agent nodes.
 * No external calls — pure heuristic for now.
 */
export function decompose(taskId: string, prompt: string): DAGNode[] {
  const lower = prompt.toLowerCase();

  const nodes: DAGNode[] = [];

  const research: DAGNode = {
    nodeId: "node_research",
    type: "research",
    prompt: `Research background information for: ${prompt}`,
    description: `Research background information for: ${prompt}`,
    status: "pending",
    dependencies: [],
  };
  nodes.push(research);

  if (lower.includes("risk") || lower.includes("market") || lower.includes("financial")) {
    nodes.push({
      nodeId: "node_risk",
      type: "risk",
      prompt: "Analyse risks and regulatory landscape",
      description: "Analyse risks and regulatory landscape",
      status: "pending",
      dependencies: ["node_research"],
    });
  }

  if (lower.includes("code") || lower.includes("software") || lower.includes("implement")) {
    nodes.push({
      nodeId: "node_coding",
      type: "coding",
      prompt: "Implement required code components",
      description: "Implement required code components",
      status: "pending",
      dependencies: ["node_research"],
    });
  }

  if (lower.includes("design") || lower.includes("ui") || lower.includes("visual")) {
    nodes.push({
      nodeId: "node_design",
      type: "design",
      prompt: "Create design assets",
      description: "Create design assets",
      status: "pending",
      dependencies: ["node_research"],
    });
  }

  const deps = nodes.filter(n => n.nodeId !== "node_research").map(n => n.nodeId);
  nodes.push({
    nodeId: "node_report",
    type: "report",
    prompt: "Compile and format the final report",
    description: "Compile and format the final report",
    status: "pending",
    dependencies: deps.length ? deps : ["node_research"],
  });

  return nodes;
}
