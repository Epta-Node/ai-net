/**
 * Agent registry.
 *
 * Minimal in-memory implementation of the on-chain agent registry. It backs
 * the registry tests and gives the rest of the system a stable interface to
 * build against; the on-chain (Soroban) backing store is a follow-up.
 */

export interface Agent {
  /** Unique agent identifier. */
  id: string;
  /** Human-readable agent name. */
  name: string;
  /** Capability the agent advertises, e.g. "research" or "risk". */
  capability: string;
  /** Price per task, denominated in XLM. */
  priceXLM: number;
  /** Stellar address that receives payments for this agent. */
  stellarAddress: string;
}

const agents = new Map<string, Agent>();

/** Register (or overwrite) an agent in the registry. */
export function registerAgent(agent: Agent): void {
  agents.set(agent.id, agent);
}

/** Return all registered agents advertising the given capability. */
export function discoverAgents(capability: string): Agent[] {
  return Array.from(agents.values()).filter((a) => a.capability === capability);
}

/** Look up a single agent by id, or `undefined` if not registered. */
export function getAgent(id: string): Agent | undefined {
  return agents.get(id);
}

/** Remove all agents. Primarily useful for isolating tests. */
export function clearRegistry(): void {
  agents.clear();
}
