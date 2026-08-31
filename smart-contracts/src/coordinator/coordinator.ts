import * as fs from "fs";
import * as path from "path";
import { createHash } from "crypto";
import { deflateSync, inflateSync } from "zlib";
import axios from "axios";
import { discoverAgents } from "../registry/registry";

export interface DAGNode {
  id: string;
  taskType: string;
  dependsOn: string[];
  assignedAgent?: string;
  status: "pending" | "running" | "done" | "failed";
  result?: unknown;
}

export enum TaskStatus {
  Pending = 0,
  Running = 1,
  Completed = 2,
  Failed = 3,
}

export interface OnChainTaskMetadata {
  taskId: Uint8Array;
  promptHash: Uint8Array;
  assignedAgents: string[];
  dag: DAGNode[];
  status: TaskStatus;
  createdAt: bigint;
  expiresAt: bigint;
}

export interface TaskMetadataContractClient {
  store_task_metadata(args: {
    submitter: string;
    task_id: Uint8Array;
    prompt_hash: Uint8Array;
    assigned_agents: string[];
    compressed_dag: Uint8Array;
    ttl_days: number;
  }): AssembledContractTransaction<void>;
  get_task_metadata(task_id: Uint8Array): AssembledContractTransaction<{
    taskId: Uint8Array;
    promptHash: Uint8Array;
    assignedAgents: string[];
    compressedDag: Uint8Array;
    status: TaskStatus;
    createdAt: bigint;
    expiresAt: bigint;
  }>;
  get_task_status(task_id: Uint8Array): AssembledContractTransaction<TaskStatus>;
  update_task_status(args: {
    task_id: Uint8Array;
    agent: string;
    new_status: TaskStatus;
  }): AssembledContractTransaction<void>;
}

export interface AssembledContractTransaction<T> {
  signAndSend(): Promise<T>;
  simulate(): Promise<T>;
}

export interface StoreTaskMetadataInput {
  taskId: string;
  prompt: string;
  submitter: string;
  assignedAgents: string[];
  dag: DAGNode[];
  ttlDays?: number;
}

export class CyclicDAGError extends Error {
  constructor() {
    super("Cyclic dependency detected in task DAG");
    this.name = "CyclicDAGError";
  }
}

function hashTaskValue(value: string): Uint8Array {
  return createHash("sha256").update(value, "utf8").digest();
}

export async function storeTaskMetadata(
  client: TaskMetadataContractClient,
  input: StoreTaskMetadataInput,
): Promise<void> {
  const compressedDag = deflateSync(Buffer.from(JSON.stringify(input.dag)));

  await client.store_task_metadata({
    submitter: input.submitter,
    task_id: hashTaskValue(input.taskId),
    prompt_hash: hashTaskValue(input.prompt),
    assigned_agents: input.assignedAgents,
    compressed_dag: compressedDag,
    ttl_days: input.ttlDays ?? 0,
  }).signAndSend();
}

export async function getTaskMetadata(
  client: TaskMetadataContractClient,
  taskId: string,
): Promise<OnChainTaskMetadata> {
  const metadata = await client.get_task_metadata(hashTaskValue(taskId)).simulate();
  const dag = JSON.parse(
    inflateSync(Buffer.from(metadata.compressedDag)).toString("utf8"),
  ) as DAGNode[];

  return {
    taskId: metadata.taskId,
    promptHash: metadata.promptHash,
    assignedAgents: metadata.assignedAgents,
    dag,
    status: metadata.status,
    createdAt: metadata.createdAt,
    expiresAt: metadata.expiresAt,
  };
}

export function getTaskStatus(
  client: TaskMetadataContractClient,
  taskId: string,
): Promise<TaskStatus> {
  return client.get_task_status(hashTaskValue(taskId)).simulate();
}

export function updateTaskStatus(
  client: TaskMetadataContractClient,
  taskId: string,
  agent: string,
  newStatus: TaskStatus,
): Promise<void> {
  return client.update_task_status({
    task_id: hashTaskValue(taskId),
    agent,
    new_status: newStatus,
  }).signAndSend();
}

// ── Venice AI ────────────────────────────────────────────────────────────────

const VENICE_API = "https://api.venice.ai/api/v1/chat/completions";

export async function decomposeTask(userPrompt: string): Promise<DAGNode[]> {
  const response = await axios.post(
    VENICE_API,
    {
      model: "llama-3.3-70b",
      messages: [
        {
          role: "system",
          content:
            "You decompose a user task into sub-tasks. " +
            "Return ONLY a JSON array of objects with keys: id (string), taskType (one of: research, risk, coding, design, report), dependsOn (array of ids). " +
            "Ensure at least 3 nodes. No markdown, no explanation.",
        },
        { role: "user", content: userPrompt },
      ],
    },
    { headers: { Authorization: `Bearer ${process.env.VENICE_API_KEY}` } },
  );

  const raw: Array<{ id: string; taskType: string; dependsOn: string[] }> =
    JSON.parse(response.data.choices[0].message.content);

  return raw.map((n) => ({ ...n, status: "pending" }));
}

// ── Agent assignment ──────────────────────────────────────────────────────────

export function assignAgents(dag: DAGNode[]): void {
  for (const node of dag) {
    const agents = discoverAgents(node.taskType).sort(
      (a, b) => a.priceXLM - b.priceXLM,
    );
    if (agents.length) node.assignedAgent = agents[0].id;
  }
}

// ── Topological sort ──────────────────────────────────────────────────────────

function topologicalSort(dag: DAGNode[]): DAGNode[] {
  const nodeMap = new Map(dag.map((n) => [n.id, n]));
  const visited = new Set<string>();
  const inStack = new Set<string>();
  const order: DAGNode[] = [];

  function visit(id: string): void {
    if (inStack.has(id)) throw new CyclicDAGError();
    if (visited.has(id)) return;
    inStack.add(id);
    const node = nodeMap.get(id)!;
    for (const dep of node.dependsOn) visit(dep);
    inStack.delete(id);
    visited.add(id);
    order.push(node);
  }

  for (const node of dag) visit(node.id);
  return order;
}

// ── DAG execution ─────────────────────────────────────────────────────────────

const MAX_RETRIES = 3;

export async function executeDAG(
  dag: DAGNode[],
  taskId: string,
  runNode: (
    node: DAGNode,
    context: Record<string, unknown>,
  ) => Promise<unknown> = defaultRunNode,
): Promise<Record<string, unknown>> {
  const sorted = topologicalSort(dag);
  const nodeMap = new Map(dag.map((n) => [n.id, n]));
  const results: Record<string, unknown> = {};

  for (const node of sorted) {
    const context: Record<string, unknown> = {};
    for (const dep of node.dependsOn) context[dep] = results[dep];

    node.status = "running";
    await handleAgentFailure(node, context, runNode);

    const status: string = node.status;
    if (status === "failed") {
      for (const n of dag) {
        if (n.dependsOn.includes(node.id)) {
          nodeMap.get(n.id)!.status = "failed";
        }
      }
    } else {
      results[node.id] = node.result;
    }
  }

  persistTrace(taskId, dag);
  return results;
}

// ── Failure handling ──────────────────────────────────────────────────────────

export async function handleAgentFailure(
  node: DAGNode,
  context: Record<string, unknown>,
  runNode: (
    node: DAGNode,
    context: Record<string, unknown>,
  ) => Promise<unknown>,
): Promise<void> {
  const agents = discoverAgents(node.taskType).sort(
    (a, b) => a.priceXLM - b.priceXLM,
  );

  if (agents.length === 0) {
    node.status = "failed";
    return;
  }

  let attempts = 0;

  for (const agent of agents) {
    if (attempts >= MAX_RETRIES) break;
    try {
      node.assignedAgent = agent.id;
      node.result = await runNode(node, context);
      node.status = "done";
      return;
    } catch {
      attempts++;
    }
  }

  node.status = "failed";
}

// ── Persistence ───────────────────────────────────────────────────────────────

// Trace files accumulate in logs/tasks/. Clean up stale files with a cron or CI step:
//   find logs/tasks -mtime +7 -delete
function persistTrace(taskId: string, dag: DAGNode[]): void {
  const dir = path.join("logs", "tasks");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, `${taskId}.json`),
    JSON.stringify(dag, null, 2),
  );
}

// ── Default node runner ───────────────────────────────────────────────────────

async function defaultRunNode(
  node: DAGNode,
  context: Record<string, unknown>,
): Promise<unknown> {
  void context;
  return { nodeId: node.id, agentId: node.assignedAgent };
}
