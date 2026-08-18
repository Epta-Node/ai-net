export interface AgentRegistration {
  id: string;
  type: string;
  endpoint: string;
  cost: number;
  status: 'online' | 'offline';
}

export interface AgentRegistry {
  getAgents(agentType: string): AgentRegistration[] | Promise<AgentRegistration[]>;
}

