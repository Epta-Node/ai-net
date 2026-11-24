/**
 * Local-dev seed data: a handful of sample agents and one sample task, so a
 * fresh `payments.db` / `agents.db` / `tasks.db` isn't empty. Safe to run
 * repeatedly — agents are upserted by id, and the task is only inserted if
 * it doesn't already exist.
 */

import { getAgentDb, createAgentDb, type AgentRecord } from "./agents";
import { getTaskDb, createTaskDb } from "./tasks";
import type { Task } from "../types/task";

const SEED_AGENTS: AgentRecord[] = [
  {
    id: "seed-research-agent",
    capabilities: ["research"],
    pricingXLM: 2.5,
    endpoint: "http://localhost:4001",
    stellarPublicKey: "GSEEDRESEARCH0000000000000000000000000000000000000",
    reputationScore: 4.8,
    lastSeenAt: new Date().toISOString(),
    status: "offline",
  },
  {
    id: "seed-coding-agent",
    capabilities: ["coding"],
    pricingXLM: 5,
    endpoint: "http://localhost:4002",
    stellarPublicKey: "GSEEDCODING00000000000000000000000000000000000000",
    reputationScore: 4.6,
    lastSeenAt: new Date().toISOString(),
    status: "offline",
  },
  {
    id: "seed-report-agent",
    capabilities: ["report"],
    pricingXLM: 1.5,
    endpoint: "http://localhost:4003",
    stellarPublicKey: "GSEEDREPORT000000000000000000000000000000000000000",
    reputationScore: 4.9,
    lastSeenAt: new Date().toISOString(),
    status: "offline",
  },
];

const SEED_TASK: Task = {
  id: "seed-task-market-entry-report",
  prompt: "Generate a market-entry report for solar energy in Southeast Asia.",
  walletPublicKey: "GSEEDWALLET00000000000000000000000000000000000000",
  status: "completed",
  dag: [],
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};

export function seed(): void {
  const agentDb = createAgentDb(getAgentDb());
  for (const agent of SEED_AGENTS) {
    agentDb.upsert(agent);
  }
  console.log(`seeded ${SEED_AGENTS.length} agent(s)`);

  const taskDb = createTaskDb(getTaskDb());
  if (!taskDb.findById(SEED_TASK.id)) {
    taskDb.insert(SEED_TASK);
    console.log(`seeded task ${SEED_TASK.id}`);
  } else {
    console.log(`task ${SEED_TASK.id} already seeded`);
  }
}
