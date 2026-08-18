import { z } from 'zod';
import { registerAgent } from '../../registry/registry';
import { Agent, AgentResult, SubTask } from '../../types/agent';
import { VeniceClient } from '../../venice/venice';

const VeniceResponseSchema = z.object({
  summary: z.string().min(100, 'summary must be at least 100 characters'),
  keyFindings: z.array(z.string()).min(1, 'keyFindings cannot be empty'),
  dataSources: z.array(z.string()),
});

export interface ResearchOutput {
  summary: string;
  keyFindings: string[];
  dataSources: string[];
  generatedAt: number;
}

const AGENT_ID = 'research-agent-1';
const AGENT_NAME = 'Research Agent';
const AGENT_CAPABILITY = 'research';

export class ResearchAgent implements Agent {
  constructor(private readonly venice: VeniceClient) {}

  start(): void {
    // registration happens on module load
  }

  async healthCheck(): Promise<boolean> {
    return Boolean(process.env.VENICE_API_KEY);
  }

  async execute(task: SubTask): Promise<AgentResult> {
    // Research is always the first node in a DAG, so there is normally no
    // upstream context. We still forward it when present to stay consistent
    // with downstream agents.
    const upstreamContext = task.upstreamResults?.length
      ? `\n\nUpstream context:\n${JSON.stringify(task.upstreamResults, null, 2)}`
      : '';

    const prompt = [
      'You are a research assistant. Respond with valid JSON only, no markdown.',
      'Format: {"summary":"string","keyFindings":["string"],"dataSources":["string"]}',
      'The summary must be a thorough paragraph of at least 100 characters.',
      upstreamContext,
      `\nTask: ${task.prompt}`,
    ].join('\n');

    const model = this.venice.getModelForAgent(AGENT_CAPABILITY);
    const content = await this.venice.complete(prompt, model);

    const parsed = VeniceResponseSchema.parse(JSON.parse(content));

    const output: ResearchOutput = {
      summary: parsed.summary,
      keyFindings: parsed.keyFindings,
      dataSources: parsed.dataSources,
      generatedAt: Date.now(),
    };

    return {
      agentId: AGENT_ID,
      agentName: AGENT_NAME,
      capability: AGENT_CAPABILITY,
      data: output,
    };
  }
}

registerAgent({
  id: AGENT_ID,
  name: AGENT_NAME,
  capability: AGENT_CAPABILITY,
  priceXLM: 1,
  stellarAddress: '',
});
