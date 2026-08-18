import { ResearchAgent, ResearchOutput } from '../src/agents/research/research';
import { getAgent } from '../src/registry/registry';
import { VeniceClient } from '../src/venice/venice';

const longSummary =
  'The decentralized AI agent market is expanding rapidly, driven by demand for ' +
  'autonomous coordination, on-chain payments, and composable agent networks built on Stellar.';

const baseResearchResponse = {
  summary: longSummary,
  keyFindings: [
    'Demand for agent-to-agent payments is growing',
    'Stellar offers low-cost settlement',
  ],
  dataSources: ['https://example.com/report', 'internal-analysis'],
};

const makeVenice = (response: object) => ({
  complete: jest.fn().mockResolvedValue(JSON.stringify(response)),
  getModelForAgent: jest.fn().mockReturnValue('venice-xl'),
  stream: jest.fn(),
});

describe('ResearchAgent', () => {
  it('returns a valid ResearchOutput for a substantive prompt', async () => {
    const venice = makeVenice(baseResearchResponse);
    const agent = new ResearchAgent(venice as unknown as VeniceClient);
    const result = await agent.execute({
      prompt: 'Research the decentralized AI agent market',
    });
    const output = result.data as ResearchOutput;

    expect(result.capability).toBe('research');
    expect(output.summary).toBe(longSummary);
    expect(Array.isArray(output.keyFindings)).toBe(true);
    expect(output.keyFindings.length).toBeGreaterThan(0);
    expect(Array.isArray(output.dataSources)).toBe(true);
    expect(typeof output.generatedAt).toBe('number');
  });

  it('produces a summary that is at least 100 characters', async () => {
    const venice = makeVenice(baseResearchResponse);
    const agent = new ResearchAgent(venice as unknown as VeniceClient);
    const result = await agent.execute({ prompt: 'Research the market' });
    const output = result.data as ResearchOutput;

    expect(output.summary.length).toBeGreaterThanOrEqual(100);
  });

  it('uses venice-xl model via getModelForAgent', async () => {
    const venice = makeVenice(baseResearchResponse);
    const agent = new ResearchAgent(venice as unknown as VeniceClient);
    await agent.execute({ prompt: 'Research the market' });

    expect(venice.getModelForAgent).toHaveBeenCalledWith('research');
    expect(venice.complete).toHaveBeenCalledWith(expect.any(String), 'venice-xl');
  });

  it('Zod rejects a response missing keyFindings', async () => {
    const venice = makeVenice({
      summary: longSummary,
      dataSources: [],
    });
    const agent = new ResearchAgent(venice as unknown as VeniceClient);
    await expect(agent.execute({ prompt: 'test' })).rejects.toThrow();
  });

  it('Zod rejects a summary shorter than 100 characters', async () => {
    const venice = makeVenice({
      summary: 'Too short.',
      keyFindings: ['a finding'],
      dataSources: [],
    });
    const agent = new ResearchAgent(venice as unknown as VeniceClient);
    await expect(agent.execute({ prompt: 'test' })).rejects.toThrow();
  });

  it('registers with capability "research" on module load (via getAgent)', () => {
    const meta = getAgent('research-agent-1');
    expect(meta?.capability).toBe('research');
  });

  it('sends an empty upstream context when none is provided (research is first)', async () => {
    const venice = makeVenice(baseResearchResponse);
    const agent = new ResearchAgent(venice as unknown as VeniceClient);
    await agent.execute({ prompt: 'Research the market' });

    const promptArg = venice.complete.mock.calls[0][0] as string;
    expect(promptArg).not.toContain('Upstream context:');
    expect(promptArg).toContain('Research the market');
  });

  it('forwards upstream context when upstreamResults are provided', async () => {
    const venice = makeVenice(baseResearchResponse);
    const agent = new ResearchAgent(venice as unknown as VeniceClient);
    await agent.execute({
      prompt: 'Research the market',
      upstreamResults: [
        {
          agentId: 'seed-1',
          agentName: 'Seed Agent',
          capability: 'seed',
          data: { note: 'prior context payload' },
        },
      ],
    });

    const promptArg = venice.complete.mock.calls[0][0] as string;
    expect(promptArg).toContain('Upstream context:');
    expect(promptArg).toContain('prior context payload');
  });

  it('healthCheck returns false when VENICE_API_KEY is not set', async () => {
    const original = process.env.VENICE_API_KEY;
    delete process.env.VENICE_API_KEY;
    const venice = makeVenice(baseResearchResponse);
    const agent = new ResearchAgent(venice as unknown as VeniceClient);

    expect(await agent.healthCheck()).toBe(false);

    if (original !== undefined) process.env.VENICE_API_KEY = original;
  });
});
