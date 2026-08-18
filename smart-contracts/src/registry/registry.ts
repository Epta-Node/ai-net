export interface Agent {
  id: string;
  name: string;
  capability: string;
  priceXLM: number;
  stellarAddress: string;
}

const TTL_MS = 30_000;

interface CacheEntry {
  agent: Agent;
  registeredAt: number;
}

const agents = new Map<string, CacheEntry>();

function isExpired(entry: CacheEntry): boolean {
  return Date.now() - entry.registeredAt > TTL_MS;
}

function pruneExpired(): void {
  for (const [id, entry] of agents) {
    if (isExpired(entry)) {
      agents.delete(id);
    }
  }
}

export function registerAgent(agent: Agent): Agent {
  agents.set(agent.id, { agent, registeredAt: Date.now() });
  return agent;
}

export function discoverAgents(capability: string): Agent[] {
  pruneExpired();
  return Array.from(agents.values())
    .filter((e) => e.agent.capability === capability)
    .map((e) => e.agent);
}

export function getAgent(id: string): Agent | undefined {
  pruneExpired();
  const entry = agents.get(id);
  if (!entry) return undefined;
  if (isExpired(entry)) {
    agents.delete(id);
    return undefined;
  }
  return entry.agent;
}

export function lookupAgent(id: string): Agent | undefined {
  return getAgent(id);
}

export function deregisterAgent(id: string): boolean {
  return agents.delete(id);
}

export function updatePricing(id: string, priceXLM: number): Agent | undefined {
  pruneExpired();
  const entry = agents.get(id);
  if (!entry) return undefined;
  const updated = { ...entry.agent, priceXLM };
  agents.set(id, { ...entry, agent: updated });
  return updated;
}

export function clearRegistry(): void {
  agents.clear();
}

export const clearCache = clearRegistry;
