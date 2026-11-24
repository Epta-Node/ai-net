export interface AgentRegistration {
  id: string;
  type: string;
  endpoint: string;
  cost: number;
  status: 'online' | 'offline';
  reputation?: number;
}

export interface AgentRegistry {
  getAgents(agentType?: string): AgentRegistration[] | Promise<AgentRegistration[]>;
  registerAgent?(agent: AgentRegistration): void | Promise<void>;
  markOffline?(agentId: string): void | Promise<void>;
  markOnline?(agentId: string): void | Promise<void>;
}

