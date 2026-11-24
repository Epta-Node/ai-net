// Issue #727: On-chain agent reputation from agent_registry contract

import { Contract, SorobanRpc } from '@stellar/stellar-sdk';

export interface AgentReputation {
  score: number;
  totalTasks: number;
  successfulTasks: number;
  trend: 'up' | 'down' | 'stable';
  lastUpdated: string;
}

export interface ReputationConfig {
  minScore: number;
  maxScore: number;
  decayRate: number;
}

/**
 * Fetch agent reputation from on-chain agent_registry contract
 * Network driven by VITE_SOROBAN_NETWORK_PASSPHRASE env config
 */
export async function getOnChainReputation(
  agentId: string
): Promise<AgentReputation | null> {
  try {
    const networkPassphrase = import.meta.env.VITE_SOROBAN_NETWORK_PASSPHRASE;
    const rpcUrl = import.meta.env.VITE_SOROBAN_RPC_URL;
    const contractId = import.meta.env.VITE_AGENT_REGISTRY_CONTRACT_ID;

    if (!networkPassphrase || !rpcUrl || !contractId) {
      console.warn('On-chain reputation config missing, falling back to backend');
      return null;
    }

    const server = new SorobanRpc.Server(rpcUrl);
    const contract = new Contract(contractId);

    // Call get_reputation(agent_id) on contract
    const result = await server.getContractData(
      contract.address(),
      contract.call('get_reputation', agentId),
      'persistent'
    );

    if (!result) {
      return null;
    }

    // Parse contract response (structure depends on contract implementation)
    const reputationData = result.val;
    
    return {
      score: Number(reputationData.score || 0),
      totalTasks: Number(reputationData.total_tasks || 0),
      successfulTasks: Number(reputationData.successful_tasks || 0),
      trend: calculateTrend(reputationData),
      lastUpdated: new Date().toISOString(),
    };
  } catch (error) {
    console.error('Failed to fetch on-chain reputation:', error);
    return null;
  }
}

/**
 * Fetch reputation configuration from contract
 */
export async function getReputationConfig(): Promise<ReputationConfig | null> {
  try {
    const networkPassphrase = import.meta.env.VITE_SOROBAN_NETWORK_PASSPHRASE;
    const rpcUrl = import.meta.env.VITE_SOROBAN_RPC_URL;
    const contractId = import.meta.env.VITE_AGENT_REGISTRY_CONTRACT_ID;

    if (!networkPassphrase || !rpcUrl || !contractId) {
      return null;
    }

    const server = new SorobanRpc.Server(rpcUrl);
    const contract = new Contract(contractId);

    const result = await server.getContractData(
      contract.address(),
      contract.call('get_reputation_config'),
      'persistent'
    );

    if (!result) {
      return null;
    }

    const config = result.val;
    
    return {
      minScore: Number(config.min_score || 0),
      maxScore: Number(config.max_score || 100),
      decayRate: Number(config.decay_rate || 0),
    };
  } catch (error) {
    console.error('Failed to fetch reputation config:', error);
    return null;
  }
}

/**
 * Calculate reputation trend from historical data
 */
function calculateTrend(reputationData: any): 'up' | 'down' | 'stable' {
  const currentScore = Number(reputationData.score || 0);
  const previousScore = Number(reputationData.previous_score || currentScore);

  if (currentScore > previousScore) return 'up';
  if (currentScore < previousScore) return 'down';
  return 'stable';
}

/**
 * Graceful fallback to backend stats when on-chain unavailable
 */
export async function getReputationWithFallback(
  agentId: string
): Promise<AgentReputation> {
  // Try on-chain first
  const onChainRep = await getOnChainReputation(agentId);
  
  if (onChainRep) {
    return onChainRep;
  }

  // Fallback to backend stats
  try {
    const response = await fetch(`/api/agents/${agentId}/stats`);
    const stats = await response.json();

    return {
      score: stats.reputation || 0,
      totalTasks: stats.totalTasks || 0,
      successfulTasks: stats.successfulTasks || 0,
      trend: 'stable',
      lastUpdated: new Date().toISOString(),
    };
  } catch (error) {
    console.error('Failed to fetch backend reputation:', error);
    
    // Return default values
    return {
      score: 0,
      totalTasks: 0,
      successfulTasks: 0,
      trend: 'stable',
      lastUpdated: new Date().toISOString(),
    };
  }
}
