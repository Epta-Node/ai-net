import { z } from 'zod';
import { VeniceClient, type VeniceClientLike } from '../../services/venice/index.js';
import type { AgentTask, AgentResult, AgentError, Source } from './types';

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

  constructor(config: ResearchAgentConfig = {}) {
    if (config.veniceClient) {
      this.venice = config.veniceClient;
    } else {
      const apiKey = process.env['VENICE_API_KEY'];
      if (!apiKey) {
        console.warn(
          '[ResearchAgent] WARNING: VENICE_API_KEY is not set. ' +
            'Venice calls will fail. Set this env var before running in production.'
        );
      }
      this.venice = new VeniceClient({ apiKey: apiKey ?? '' });
    }
    this.apiBaseUrl = config.apiBaseUrl ?? 'http://127.0.0.1:3001';
    this.agentId = config.agentId ?? 'research-agent-1';
  }

  async execute(task: AgentTask): Promise<AgentResult | AgentError> {
    const { taskId, nodeId, prompt, context } = task;

    const userContent = context
      ? `${prompt}\n\nAdditional context:\n${context}`
      : prompt;

    const fullPrompt = `${SYSTEM_PROMPT}\n\n${userContent}`;

    let rawText: string;
    try {
      rawText = await this.venice.complete(fullPrompt, 'research');
    } catch {
      return { error: 'VENICE_UNAVAILABLE' };
    }

    const parsed = this.parseVeniceResponse(rawText);
    if (parsed !== null) {
      return this.buildResult(taskId, nodeId, parsed);
    }

    let retryText: string;
    try {
      const retryPrompt = `${SYSTEM_PROMPT}\n\n${userContent}${JSON_MODE_ADDENDUM}`;
      retryText = await this.venice.complete(retryPrompt, 'research');
    } catch {
      return { error: 'VENICE_UNAVAILABLE' };
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
          `[ResearchAgent] Registration returned non-2xx status: ${response.status}`
        );
      } else {
        console.info('[ResearchAgent] Successfully registered with capability "research".');
      }
    } catch (err) {
      console.warn('[ResearchAgent] Could not reach registry to self-register:', err instanceof Error ? err.message : 'unknown');
    }
  }

  private parseVeniceResponse(raw: string): VeniceResearchResponse | null {
    const trimmed = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
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

  private buildResult(
    taskId: string,
    nodeId: string,
    data: VeniceResearchResponse
  ): AgentResult {
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
