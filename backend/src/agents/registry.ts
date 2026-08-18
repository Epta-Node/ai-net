/**
 * Agent startup and registration manager.
 *
 * Instantiates all agents and handles their self-registration on startup.
 * This class is distinct from the {@link AgentRegistry} interface in
 * `types/agent.ts`, which is the look-up interface used by the coordinator
 * to resolve agents by type.
 */

import { ResearchAgent } from './research/research';
import { RiskAgent } from './risk';
import { CodingAgent } from './coding';
import { DesignAgent } from './design';
import { ReportAgent } from './report';

export interface AgentRegistryConfig {
  apiBaseUrl?: string;
  autoRegister?: boolean;

}

export class AgentStartupRegistry {
  private readonly agents: Array<{
    instance: any;
    capability: string;
  }> = [];

  constructor(private config: AgentRegistryConfig = {}) {}

  /**
   * Initialize all agents and optionally register them.
   */
  async initialize(): Promise<void> {
    const apiBaseUrl = this.config.apiBaseUrl ?? 'http://127.0.0.1:3001';
    const autoRegister = this.config.autoRegister ?? true;

    // Instantiate all agents
    const researchAgent = new ResearchAgent({ apiBaseUrl });
    const riskAgent = new RiskAgent({ apiBaseUrl });
    const codingAgent = new CodingAgent({ apiBaseUrl });
    const designAgent = new DesignAgent({ apiBaseUrl });
    const reportAgent = new ReportAgent({ apiBaseUrl });

    this.agents.push(
      { instance: researchAgent, capability: 'research' },
      { instance: riskAgent, capability: 'risk' },
      { instance: codingAgent, capability: 'coding' },
      { instance: designAgent, capability: 'design' },
      { instance: reportAgent, capability: 'report' }
    );

    if (autoRegister) {
      console.log('[AgentRegistry] Registering all agents...');
      
      const registrations = this.agents.map(async ({ instance, capability }) => {
        try {
          await instance.register();
          instance.startHeartbeat();
        } catch (error) {
          console.error(`[AgentRegistry] Failed to register ${capability} agent:`, error instanceof Error ? error.message : 'unknown');
        }
      });

      await Promise.all(registrations);
      console.log(`[AgentRegistry] Registration complete. ${this.agents.length} agents initialized.`);
    }
  }

  /**
   * Stop heartbeats for all agents.
   */
  async shutdown(): Promise<void> {
    for (const { instance } of this.agents) {
      try {
        instance.stopHeartbeat();
      } catch {
        // ignore shutdown errors
      }
    }
  }

  /**
   * Get all registered agents.
   */
  getAgents() {
    return this.agents.map(({ instance, capability }) => ({
      capability,
      agentId: instance.agentId || `${capability}-agent-1`,
      instance,
    }));
  }

  /**
   * Get agent by capability.
   */
  getAgentByCapability(capability: string) {
    const agent = this.agents.find(a => a.capability === capability);
    return agent?.instance;
  }

  /**
   * Perform health checks on all agents.
   */
  async healthCheck(): Promise<Record<string, boolean>> {
    const results: Record<string, boolean> = {};

    for (const { instance, capability } of this.agents) {
      try {
        if (typeof instance.healthCheck === 'function') {
          results[capability] = await instance.healthCheck();
        } else {
          results[capability] = true; // Assume healthy if no health check method
        }
      } catch (error) {
        console.error(`[AgentRegistry] Health check failed for ${capability}:`, error);
        results[capability] = false;
      }
    }

    return results;
  }
}

// Default singleton instance for easy usage
export const globalAgentRegistry = new AgentStartupRegistry();

/**
 * Initialize all agents - call this on app startup.
 */
export async function initializeAgents(config?: AgentRegistryConfig): Promise<void> {
  const registry = config ? new AgentStartupRegistry(config) : globalAgentRegistry;
  await registry.initialize();
}
