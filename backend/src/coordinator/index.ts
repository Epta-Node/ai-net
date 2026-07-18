import type { DagNode } from "../types/task";
import { createLogger } from "../utils/logger";

const log = createLogger({ module: 'coordinator' });

/**
 * Deterministically decomposes a prompt into a DAG of agent nodes.
 * No external calls — pure heuristic for now.
 */
export function decompose(prompt: string): DagNode[] {
  const lower = prompt.toLowerCase();

  const nodes: DagNode[] = [];

  const research: DagNode = {
    id: "node_research",
    agentType: "research",
    description: `Research background information for: ${prompt}`,
    status: "queued",
    dependencies: [],
  };
  nodes.push(research);

  if (lower.includes("risk") || lower.includes("market") || lower.includes("financial")) {
    nodes.push({
      id: "node_risk",
      agentType: "risk",
      description: "Analyse risks and regulatory landscape",
      status: "queued",
      dependencies: ["node_research"],
    });
  }

  if (lower.includes("code") || lower.includes("software") || lower.includes("implement")) {
    nodes.push({
      id: "node_coding",
      agentType: "coding",
      description: "Implement required code components",
      status: "queued",
      dependencies: ["node_research"],
    });
  }

  if (lower.includes("design") || lower.includes("ui") || lower.includes("visual")) {
    nodes.push({
      id: "node_design",
      agentType: "design",
      description: "Create design assets",
      status: "queued",
      dependencies: ["node_research"],
    });
  }

  const deps = nodes.filter(n => n.id !== "node_research").map(n => n.id);
  nodes.push({
    id: "node_report",
    agentType: "report",
    description: "Compile and format the final report",
    status: "queued",
    dependencies: deps.length ? deps : ["node_research"],
  });

  log.debug(
    { 
      promptLength: prompt.length, 
      nodeIds: nodes.map(n => n.id),
      agentTypes: nodes.map(n => n.agentType)
    }, 
    "Prompt decomposed into task DAG"
  );

  return nodes;
}
