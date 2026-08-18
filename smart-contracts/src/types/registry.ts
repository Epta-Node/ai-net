/** Supported agent capability identifiers */
export type Capability =
  | 'research'
  | 'risk'
  | 'coding'
  | 'design'
  | 'report'
  | string;

/** On-chain agent record */
export interface AgentRecord {
  id: string;
  name: string;
  capability: Capability;
  priceXLM: number;
  stellarAddress: string;
  endpoint?: string;
  reputation?: number;
  registeredAt?: number;
}

/** Soroban event emitted by registry contract */
export interface RegistryEvent {
  type: 'registered' | 'deregistered' | 'price_updated';
  agentId: string;
  timestamp: number;
  data?: Record<string, unknown>;
}
