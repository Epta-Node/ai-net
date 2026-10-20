import { z } from 'zod';
import {
  VeniceClient,
  CircuitOpenError,
  TokenBudgetExceededError,
  type CompleteOptions,
  type VeniceClientLike,
} from '../../services/venice/index.js';
import { estimateTokens, trimToTokenBudget } from '../../services/budget';
import { fetchWithTimeout } from '../../utils/timeout.js';
import type { AgentTask, AgentResult, AgentError, AgentUsage, Source } from './types';
import { getConfig } from '../../config/index.js';

/**
 * Fraction of the node's token allowance the prompt may use; the rest is left
 * for the completion.
 */
const PROMPT_SHARE_OF_ALLOWANCE = 0.75;

/**
 * A budget rejection is not transient: retrying cannot help, and the
 * coordinator needs to distinguish it from a provider outage to halt the task
 * rather than burn retries.
 */
function describeVeniceFailure(err: unknown): string {
  if (err instanceof TokenBudgetExceededError) return 'BUDGET_EXHAUSTED';
  if (err instanceof CircuitOpenError) return 'VENICE_UNAVAILABLE';
  return 'VENICE_UNAVAILABLE';
}

const SourceSchema = z.object({
  url: z.string().url(),
  title: z.string().min(1),
});

const VeniceResearchResponseSchema = z.object({
  summary: z.string().min(1),
  keyFindings: z.array(z.string()).min(1),
  sources: z.array(SourceSchema),
  confidence: z.number().min(0).max(1).optional(),
});

type VeniceResearchResponse = z.infer<typeof VeniceResearchResponseSchema>;

/**
 * Canonical output shape returned by `execute()` and consumed by the
 * Coordinator. Exported for the quality scorer, which validates agent output
 * against this schema in its format dimension.
 */
export const ResearchOutputSchema = z.object({
  taskId: z.string(),
  nodeId: z.string(),
  summary: z.string().min(1),
  keyFindings: z.array(z.string().min(1)).min(1),
  sources: z.array(SourceSchema),
  confidence: z.number().min(0).max(1),
});

export function deriveConfidence(sourceCount: number): number {
  if (sourceCount === 0) return 0.3;
  if (sourceCount <= 3) return 0.6;
  return 0.9;
}

const SYSTEM_PROMPT = `You are an expert research analyst. Your task is to \
research the given topic thoroughly and return ONLY a valid JSON object — no \
markdown, no prose, no code fences — with the following structure:
{
  "summary": "<one-paragraph executive summary>",
  "keyFindings": ["<finding 1>", "<finding 2>", ...],
  "sources": [
    { "url": "<source URL>", "title": "<source title>" },
    ...
  ],
  "confidence": <float between 0 and 1>
}
Be precise, factual, and cite verifiable sources where possible.`;

const JSON_MODE_ADDENDUM = `\n\nCRITICAL: Your previous response was not valid \
JSON. You MUST respond with ONLY a raw JSON object that matches this schema — \
no explanation, no markdown, no code blocks:
{
  "summary": "string",
  "keyFindings": ["string"],
  "sources": [{"url": "string", "title": "string"}],
  "confidence": number
}`;

export interface ResearchAgentConfig {
  veniceClient?: VeniceClientLike;
  apiBaseUrl?: string;
  agentId?: string;
}

export class ResearchAgent {
  private readonly venice: VeniceClientLike;
  private readonly apiBaseUrl: string;
  private readonly agentId: string;
  private usage: AgentUsage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };

  constructor(config: ResearchAgentConfig = {}) {
    if (config.veniceClient) {
      this.venice = config.veniceClient;
    } else {
      this.venice = new VeniceClient({ apiKey: getConfig().VENICE_API_KEY });
    }
    this.apiBaseUrl = config.apiBaseUrl ?? 'http://127.0.0.1:3001';
    this.agentId = config.agentId ?? 'research-agent-1';
  }

  /** Token totals for the task just executed, for the coordinator's billing. */
  usageForCurrentTask(): AgentUsage {
    return { ...this.usage };
  }

  /**
   * Options for one Venice call: the node's token allowance plus a usage
   * callback, so this agent's spend is attributed to the task (Issue #390).
   */
  private callOptions(task: AgentTask): CompleteOptions {
    return {
      budget: {
        taskId: task.taskId,
        nodeId: task.nodeId,
        agentId: this.agentId,
        agentType: 'research',
        maxTokens: task.budget?.maxTokens,
      },
      onUsage: (reported) => {
        this.usage.promptTokens += reported.prompt_tokens;
        this.usage.completionTokens += reported.completion_tokens;
        this.usage.totalTokens += reported.total_tokens;
      },
    };
  }

  /**
   * Trim the prompt so it fits the node's allowance, leaving room for the
   * completion. Research prompts are the worst offenders for size — they carry
   * every upstream node's JSON — so this is where the cap usually bites.
   */
  private preparePrompt(task: AgentTask, prompt: string): string {
    const allowance = task.budget?.maxTokens;
    if (!allowance || allowance <= 0) return prompt;

    const promptCeiling = Math.max(1, Math.floor(allowance * PROMPT_SHARE_OF_ALLOWANCE));
    if (estimateTokens(prompt) <= promptCeiling) return prompt;
    return trimToTokenBudget(prompt, promptCeiling);
  }

  async execute(task: AgentTask): Promise<AgentResult | AgentError> {
    const { taskId, nodeId, prompt, context } = task;
    this.usage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };

    const userContent = context ? `${prompt}\n\nAdditional context:\n${context}` : prompt;

    const fullPrompt = this.preparePrompt(task, `${SYSTEM_PROMPT}\n\n${userContent}`);
    const options = this.callOptions(task);

    let rawText: string;
    try {
      rawText = await this.venice.complete(fullPrompt, 'research', options);
    } catch (err) {
      return { error: describeVeniceFailure(err) };
    }

    const parsed = this.parseVeniceResponse(rawText);
    if (parsed !== null) {
      return this.buildResult(taskId, nodeId, parsed);
    }

    let retryText: string;
    try {
      const retryPrompt = this.preparePrompt(
        task,
        `${SYSTEM_PROMPT}\n\n${userContent}${JSON_MODE_ADDENDUM}`
      );
      retryText = await this.venice.complete(retryPrompt, 'research', options);
    } catch (err) {
      return { error: describeVeniceFailure(err) };
    }

    const retryParsed = this.parseVeniceResponse(retryText);
    if (retryParsed !== null) {
      return this.buildResult(taskId, nodeId, retryParsed);
    }

    return { error: 'VENICE_MALFORMED_RESPONSE' };
  }

  async register(): Promise<void> {
    const body = JSON.stringify({
      agentId: this.agentId,
      capabilities: ['research'],
      pricingXLM: 0.5,
      endpoint: `${this.apiBaseUrl}/agents/research`,
      stellarPublicKey: getConfig().STELLAR_PUBLIC_KEY ?? '',
    });

    try {
      const response = await fetchWithTimeout(
        `${this.apiBaseUrl}/api/agents/register`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body,
        },
        getConfig().TIMEOUT_BUDGET_READ_MS
      );
      if (!response.ok) {
        console.warn(`[ResearchAgent] Registration returned non-2xx status: ${response.status}`);
      } else {
        console.info('[ResearchAgent] Successfully registered with capability "research".');
      }
    } catch (err) {
      console.warn(
        '[ResearchAgent] Could not reach registry to self-register:',
        err instanceof Error ? err.message : 'unknown'
      );
    }
  }

  private parseVeniceResponse(raw: string): VeniceResearchResponse | null {
    const trimmed = raw
      .trim()
      .replace(/^```(?:json)?\s*/i, '')
      .replace(/\s*```$/, '');
    let json: unknown;
    try {
      json = JSON.parse(trimmed);
    } catch {
      return null;
    }
    const result = VeniceResearchResponseSchema.safeParse(json);
    if (!result.success) {
      return null;
    }
    return result.data;
  }

  private buildResult(taskId: string, nodeId: string, data: VeniceResearchResponse): AgentResult {
    const sources: Source[] = data.sources;
    return {
      taskId,
      nodeId,
      summary: data.summary,
      keyFindings: data.keyFindings,
      sources,
      confidence: deriveConfidence(sources.length),
    };
  }
}
