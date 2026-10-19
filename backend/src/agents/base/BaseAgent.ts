import { z } from 'zod';
import {
  VeniceClient,
  CircuitOpenError,
  TokenBudgetExceededError,
  type AgentType,
  type CompleteOptions,
  type VeniceBudgetContext,
  type VeniceClientLike,
} from '../../services/venice/index.js';
import { estimateTokens, trimToTokenBudget } from '../../services/budget';
import { HeartbeatClient } from '../heartbeat.js';
import { signAgentRequest } from '../agentAuthClient.js';
import { getConfig } from '../../config/index.js';
import { createLogger } from '../../utils/logger';
import { fetchWithTimeout } from '../../utils/timeout';

/**
 * Fraction of a node's token allowance its prompt may consume. The remainder is
 * left for the completion — a prompt that eats the whole allowance guarantees
 * a truncated or empty answer.
 */
const PROMPT_SHARE_OF_ALLOWANCE = 0.75;

/** Stand-in task used by callers that predate per-task budget context. */
const FALLBACK_TASK: AgentTask = { taskId: 'unknown', nodeId: 'unknown', prompt: '' };

export interface BaseAgentConfig {
  veniceClient?: VeniceClientLike;
  apiBaseUrl?: string;
  agentId?: string;
  /**
   * Stellar public key this agent registers under (#557). Used to request and
   * sign the ownership challenge for registration and heartbeats.
   */
  stellarPublicKey?: string;
  /**
   * Stellar secret backing {@link BaseAgentConfig.stellarPublicKey} (#557, #558).
   * Kept in memory only — never logged and never sent to the coordinator.
   */
  stellarSecret?: string;
}

export interface AgentTask {
  taskId: string;
  nodeId: string;
  prompt: string;
  context?: string;
  upstreamResults?: unknown[];
  /**
   * Token allowance for this node, sent by the coordinator (Issue #390).
   * Absent for older coordinators, in which case the agent falls back to the
   * client defaults.
   */
  budget?: {
    maxTokens?: number;
  };
}

export interface AgentError {
  error: string;
}

/** Token counts the agent reports back so the coordinator can bill the task. */
export interface AgentUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export abstract class BaseAgent {
  protected readonly venice: VeniceClientLike;
  protected readonly apiBaseUrl: string;
  protected readonly agentId: string;
  /**
   * Stellar account this agent registers under (#557). Resolved from the
   * explicit config first so a caller can impersonate a specific account, then
   * from STELLAR_PUBLIC_KEY for the single-agent deployment case.
   */
  protected readonly stellarPublicKey: string;
  /**
   * Secret backing {@link stellarPublicKey} (#558). Held in memory only — never
   * logged and never sent to the coordinator.
   */
  protected readonly stellarSecret?: string;
  protected readonly log = createLogger({ component: 'agent' });
  private readonly heartbeatClient: HeartbeatClient | null = null;
  /** Token counters for the task currently executing, reset per execute(). */
  private taskUsage: AgentUsage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };

  constructor(config: BaseAgentConfig = {}) {
    if (config.veniceClient) {
      this.venice = config.veniceClient;
    } else {
      this.venice = new VeniceClient({ apiKey: getConfig().VENICE_API_KEY });
    }
    this.apiBaseUrl = config.apiBaseUrl ?? 'http://127.0.0.1:3001';
    this.agentId = config.agentId ?? `${this.getCapability()}-agent-1`;
    this.stellarPublicKey = config.stellarPublicKey ?? getConfig().STELLAR_PUBLIC_KEY ?? '';
    this.stellarSecret = config.stellarSecret ?? getConfig().STELLAR_TEST_SECRET;

    if (config.apiBaseUrl) {
      this.heartbeatClient = new HeartbeatClient({
        apiBaseUrl: this.apiBaseUrl,
        agentId: this.agentId,
        publicKey: this.stellarPublicKey,
        secret: this.stellarSecret,
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
    const body = {
      agentId: this.agentId,
      capabilities: [this.getCapability()],
      pricingXLM: 0.5,
      endpoint: `${this.apiBaseUrl}/agents/${this.getCapability()}`,
      stellarPublicKey: this.stellarPublicKey,
    };

    // Registration is only accepted with proof that we control the claimed
    // Stellar account (#557); fall back to unsigned only if we cannot sign.
    const signed = this.stellarPublicKey
      ? await signAgentRequest({
          apiBaseUrl: this.apiBaseUrl,
          purpose: 'register',
          publicKey: this.stellarPublicKey,
          secret: this.stellarSecret,
          payload: body,
        })
      : null;

    try {
      const response = await fetchWithTimeout(
        `${this.apiBaseUrl}/api/agents/register`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(signed ?? {}),
          },
          body: JSON.stringify(body),
        },
        getConfig().TIMEOUT_BUDGET_READ_MS
      );
      if (!response.ok) {
        console.warn(
          `[${this.constructor.name}] Registration returned non-2xx status: ${response.status}`
        );
      } else {
        console.info(
          `[${this.constructor.name}] Successfully registered with capability "${this.getCapability()}".`
        );
      }
    } catch (err) {
      console.warn(
        `[${this.constructor.name}] Could not reach registry to self-register:`,
        err instanceof Error ? err.message : 'unknown'
      );
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
    const trimmed = raw
      .trim()
      .replace(/^```(?:json)?\s*/i, '')
      .replace(/\s*```$/, '');
    try {
      return JSON.parse(trimmed);
    } catch {
      return null;
    }
  }

  /**
   * Total tokens consumed by this agent's calls for the current task.
   *
   * Populated from provider-reported usage via `onUsage`, and returned in the
   * execute envelope so the coordinator can bill the task (Issue #390).
   */
  protected usageForCurrentTask(): AgentUsage {
    return { ...this.taskUsage };
  }

  /** Reset the per-task usage counters. Called at the start of each execute. */
  protected resetUsage(): void {
    this.taskUsage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
  }

  /**
   * Build the `CompleteOptions` for a call, wiring in the node's token
   * allowance and the usage callback.
   *
   * `trimmed` records whether the prompt was shortened, which is worth
   * surfacing: a silently truncated context is the kind of thing that looks
   * like a model quality problem when it is really a budget decision.
   */
  private callOptions(
    task: AgentTask,
    maxTokens?: number
  ): { options: CompleteOptions; budgetContext: VeniceBudgetContext } {
    const agentType = this.getAgentType();
    const budgetContext: VeniceBudgetContext = {
      taskId: task.taskId,
      nodeId: task.nodeId,
      agentId: this.agentId,
      agentType,
      maxTokens: task.budget?.maxTokens,
    };

    return {
      budgetContext,
      options: {
        maxTokens,
        budget: budgetContext,
        onUsage: (usage) => {
          this.taskUsage.promptTokens += usage.prompt_tokens;
          this.taskUsage.completionTokens += usage.completion_tokens;
          this.taskUsage.totalTokens += usage.total_tokens;
        },
      },
    };
  }

  /**
   * Fit a prompt into the node's allowance before it goes upstream.
   *
   * The completion needs room too, so the prompt is capped below the full
   * allowance; otherwise a maximum-size prompt would leave nothing for the
   * answer and come back empty.
   */
  private preparePrompt(task: AgentTask, prompt: string): string {
    const allowance = task.budget?.maxTokens;
    if (!allowance || allowance <= 0) return prompt;

    const promptCeiling = Math.max(1, Math.floor(allowance * PROMPT_SHARE_OF_ALLOWANCE));
    if (estimateTokens(prompt) <= promptCeiling) return prompt;

    const trimmed = trimToTokenBudget(prompt, promptCeiling);
    this.log.info(
      {
        taskId: task.taskId,
        nodeId: task.nodeId,
        agentId: this.agentId,
        originalChars: prompt.length,
        trimmedChars: trimmed.length,
        promptCeiling,
      },
      'prompt trimmed to fit node token allowance'
    );
    return trimmed;
  }

  protected async callVeniceWithRetry(
    systemPrompt: string,
    userContent: string,
    jsonModeAddendum: string,
    task?: AgentTask
  ): Promise<unknown | AgentError> {
    const { options, budgetContext } = this.callOptions(task ?? FALLBACK_TASK);
    const fullPrompt = this.preparePrompt(
      task ?? FALLBACK_TASK,
      `${systemPrompt}\n\n${userContent}`
    );

    let rawText: string;
    try {
      rawText = await this.venice.complete(fullPrompt, this.getAgentType(), options);
    } catch (err) {
      return { error: this.describeVeniceFailure(err) };
    }

    const parsed = this.parseJsonResponse(rawText);
    if (parsed !== null) {
      const validated = this.validateOutput(parsed);
      if (validated !== null) {
        return validated;
      }
    }

    const retryPrompt = this.preparePrompt(
      task ?? FALLBACK_TASK,
      `${systemPrompt}\n\n${userContent}${jsonModeAddendum}`
    );

    try {
      const retryText = await this.venice.complete(retryPrompt, this.getAgentType(), {
        ...options,
        budget: { ...budgetContext },
      });

      const retryParsed = this.parseJsonResponse(retryText);
      if (retryParsed !== null) {
        const retryValidated = this.validateOutput(retryParsed);
        if (retryValidated !== null) {
          return retryValidated;
        }
      }
    } catch (err) {
      return { error: this.describeVeniceFailure(err) };
    }

    return { error: 'VENICE_MALFORMED_RESPONSE' };
  }

  /**
   * Map a Venice failure onto the agent's error vocabulary.
   *
   * A budget rejection is its own code because it is not transient: retrying
   * would just fail again, and the coordinator needs to see the difference to
   * halt the task rather than treating it as a provider blip.
   */
  private describeVeniceFailure(err: unknown): string {
    if (err instanceof TokenBudgetExceededError) return 'BUDGET_EXHAUSTED';
    if (err instanceof CircuitOpenError) return 'VENICE_UNAVAILABLE';
    return 'VENICE_UNAVAILABLE';
  }
}
