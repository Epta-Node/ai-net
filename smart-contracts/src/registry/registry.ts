/**
 * In-memory Agent Registry.
 *
 * Provides register / discover / lookup / deregister helpers used by all
 * agents on startup. The on-chain Soroban version will replace this later
 * (see Issue #1) while keeping the same public API.
 */

import { AgentRecord, Capability } from '../types/types';

// Module-level in-memory store — isolated per test via clearRegistry()
const store = new Map<string, AgentRecord>();

/**
 * Register an agent in the registry.
 * Overwrites any existing record with the same id.
 */
export function registerAgent(agent: AgentRecord): void {
  store.set(agent.id, agent);
}

/**
 * Discover all agents that match a given capability.
 * Returns an empty array when none are found.
 */
export function discoverAgents(capability: Capability | string): AgentRecord[] {
  const results: AgentRecord[] = [];
  for (const agent of store.values()) {
    if (agent.capability === capability) {
      results.push(agent);
    }
  }
  return results;
}

/**
 * Retrieve a single agent by its unique id.
 * Returns undefined when the agent is not found.
 */
export function getAgent(id: string): AgentRecord | undefined {
  return store.get(id);
}

/**
 * Remove an agent from the registry.
 * Returns true if the agent existed and was removed.
 */
export function deregisterAgent(id: string): boolean {
  return store.delete(id);
}

/**
 * Clear all agents from the registry.
 * Exposed for test isolation — do NOT call in production code.
 */
export function clearRegistry(): void {
  store.clear();
}
