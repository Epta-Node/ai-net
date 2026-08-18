import { z } from 'zod';
import { VeniceClient, type AgentType, type VeniceClientLike } from '../../venice/index.js';
import { HeartbeatClient } from '../heartbeat.js';

export interface BaseAgentConfig {
  veniceClient?: VeniceClientLike;
  apiBaseUrl?: string;
  agentId?: string;
}

export interface AgentTask {
  taskId: string;
  nodeId: string;
  prompt: string;
  context?: string;
  upstreamResults?: unknown[];
}

export interface AgentError {
  error: string;
}

export abstract class BaseAgent {
  protected readonly venice: VeniceClientLike;
  protected readonly apiBaseUrl: string;
  protected readonly agentId: string;
  private readonly heartbeatClient: HeartbeatClient | null = null;

  constructor(config: BaseAgentConfig = {}) {
    if (config.veniceClient) {
      this.venice = config.veniceClient;
    } else {
      const apiKey = process.env['VENICE_API_KEY'];
      if (!apiKey) {
        console.warn(
          `[${this.constructor.name}] WARNING: VENICE_API_KEY is not set. ` +
            'Venice calls will fail. Set this env var before running in production.'
        );
      }
      this.venice = new VeniceClient({ apiKey: apiKey ?? '' });
    }
    this.apiBaseUrl = config.apiBaseUrl ?? 'http://127.0.0.1:3001';
    this.agentId = config.agentId ?? `${this.getCapability()}-agent-1`;

    if (config.apiBaseUrl) {
      this.heartbeatClient = new HeartbeatClient({
        apiBaseUrl: this.apiBaseUrl,
        agentId: this.agentId,
      });
    }
  }

  abstract execute(task: AgentTask): Promise<unknown | AgentError>;
  abstract getCapability(): string;
  abstract getOutputSchema(): z.ZodSchema;

  protected getAgentType(): AgentType {
    return this.getCapability() as AgentType;
  }

  async healthCheck(): Promise<boolean> {
    try {
      await this.venice.complete('Hello', this.getAgentType());
      return true;
    } catch {
      return false;
    }
  }

  async register(): Promise<void> {
    const body = JSON.stringify({
      agentId: this.agentId,
      capabilities: [this.getCapability()],
      pricingXLM: 0.5,
      endpoint: `${this.apiBaseUrl}/agents/${this.getCapability()}`,
      stellarPublicKey: process.env['STELLAR_PUBLIC_KEY'] ?? '',
    });

    try {
      const response = await fetch(`${this.apiBaseUrl}/api/agents/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
      });
      if (!response.ok) {
        console.warn(
          `[${this.constructor.name}] Registration returned non-2xx status: ${response.status}`
        );
      } else {
        console.info(`[${this.constructor.name}] Successfully registered with capability "${this.getCapability()}".`);
      }
    } catch (err) {
      console.warn(`[${this.constructor.name}] Could not reach registry to self-register:`, err instanceof Error ? err.message : 'unknown');
    }
  }

  startHeartbeat(): void {
    this.heartbeatClient?.start();
  }

  stopHeartbeat(): void {
    this.heartbeatClient?.stop();
  }

  protected validateOutput(raw: unknown): unknown | null {
    const result = this.getOutputSchema().safeParse(raw);
    return result.success ? result.data : null;
  }

  protected parseJsonResponse(raw: string): unknown | null {
    if (typeof raw !== 'string') {
      return null;
    }
    const trimmed = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
    try {
      return JSON.parse(trimmed);
    } catch {
      return null;
    }
  }

  protected async callVeniceWithRetry(
    systemPrompt: string,
    userContent: string,
    jsonModeAddendum: string
  ): Promise<unknown | AgentError> {
    const fullPrompt = `${systemPrompt}\n\n${userContent}`;

    let rawText: string;
    try {
      rawText = await this.venice.complete(fullPrompt, this.getAgentType());
    } catch {
      return { error: 'VENICE_UNAVAILABLE' };
    }

    const parsed = this.parseJsonResponse(rawText);
    if (parsed !== null) {
      const validated = this.validateOutput(parsed);
      if (validated !== null) {
        return validated;
      }
    }

    try {
      const retryPrompt = `${systemPrompt}\n\n${userContent}${jsonModeAddendum}`;
      const retryText = await this.venice.complete(retryPrompt, this.getAgentType());

      const retryParsed = this.parseJsonResponse(retryText);
      if (retryParsed !== null) {
        const retryValidated = this.validateOutput(retryParsed);
        if (retryValidated !== null) {
          return retryValidated;
        }
      }
    } catch {
      return { error: 'VENICE_UNAVAILABLE' };
    }

    return { error: 'VENICE_MALFORMED_RESPONSE' };
  }
}
