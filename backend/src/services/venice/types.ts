import type { CircuitBreaker } from '../../venice/circuitBreaker.js';

export type AgentType = 'research' | 'risk' | 'coding' | 'design' | 'report';

export interface CompleteOptions {
  maxTokens?: number;
  temperature?: number;
}

export interface VeniceMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface VeniceChatOptions extends CompleteOptions {
  model?: string;
}

export interface VeniceClientConfig {
  apiKey: string;
  baseUrl?: string;
  circuitBreaker?: CircuitBreaker;
}

export interface VeniceClientLike {
  getModelFor(agentType: AgentType): string;
  getCircuitState(): unknown;
  getFailureCount(): number;
  chat(messages: VeniceMessage[], options?: VeniceChatOptions): Promise<string>;
  complete(prompt: string, agentType: AgentType, options?: CompleteOptions): Promise<string>;
  stream(
    prompt: string,
    agentType: AgentType,
    onChunk: (chunk: string) => void,
    options?: CompleteOptions
  ): Promise<void>;
}
