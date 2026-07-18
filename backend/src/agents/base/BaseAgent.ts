import { z } from 'zod';
import { VeniceClient, type AgentType } from '../../venice/index.js';
import { createLogger } from '../../utils/logger.js';
import type { Logger } from 'pino';

export interface BaseAgentConfig {
  veniceClient?: VeniceClient;
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
  protected readonly venice: VeniceClient;
  protected readonly apiBaseUrl: string;
  protected readonly agentId: string;
  protected readonly log: Logger;

  constructor(config: BaseAgentConfig = {}) {
    this.apiBaseUrl = config.apiBaseUrl ?? 'http://127.0.0.1:3001';
    this.agentId = config.agentId ?? `${this.getCapability()}-agent-1`;
    
    // Create a context-aware child logger for this agent instance
    this.log = createLogger({
      module: 'agent',
      agentClass: this.constructor.name,
      agentId: this.agentId,
      capability: this.getCapability(),
    });

    if (config.veniceClient) {
      this.venice = config.veniceClient;
    } else {
      const apiKey = process.env['VENICE_API_KEY'];
      if (!apiKey) {
        this.log.warn(
          'VENICE_API_KEY is not set. Venice calls will fail. Set this env var before running in production.'
        );
      }
      this.venice = new VeniceClient({ apiKey: apiKey ?? '' });
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
    } catch (error) {
      this.log.error({ error }, 'Health check failed');
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
        this.log.warn({ statusCode: response.status }, 'Registration returned non-2xx status');
      } else {
        this.log.info('Successfully registered agent capability');
      }
    } catch (err) {
      this.log.warn(
        { error: err instanceof Error ? err.message : 'unknown' },
        'Could not reach registry to self-register'
      );
    }
  }

  protected validateOutput(raw: unknown): unknown | null {
    const result = this.getOutputSchema().safeParse(raw);
    if (!result.success) {
      this.log.debug({ errors: result.error.errors }, 'Output schema validation failed');
    }
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
      this.log.debug({ rawText: raw }, 'Failed to parse raw text as JSON');
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
      this.log.debug('Executing primary Venice completion call');
      rawText = await this.venice.complete(fullPrompt, this.getAgentType());
    } catch (error) {
      this.log.error({ error }, 'Primary Venice connection unavailable');
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
      this.log.warn('Primary response failed validation. Executing JSON-mode fallback retry...');
      const retryPrompt = `${systemPrompt}\n\n${userContent}${jsonModeAddendum}`;
      const retryText = await this.venice.complete(retryPrompt, this.getAgentType());

      const retryParsed = this.parseJsonResponse(retryText);
      if (retryParsed !== null) {
        const retryValidated = this.validateOutput(retryParsed);
        if (retryValidated !== null) {
          return retryValidated;
        }
      }
    } catch (error) {
      this.log.error({ error }, 'Venice retry completion call unavailable');
      return { error: 'VENICE_UNAVAILABLE' };
    }

    this.log.error('Venice returned a malformed response across both primary and retry attempts');
    return { error: 'VENICE_MALFORMED_RESPONSE' };
  }
}
