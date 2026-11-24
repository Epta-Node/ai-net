import { CodingAgent, CodingOutput } from '../src/agents/coding/coding';
import { clearRegistry, getAgent } from '../src/registry/registry';
import { VeniceClient } from '../src/venice/venice';

jest.mock('../src/venice/venice');

const MockVeniceClient = VeniceClient as jest.MockedClass<typeof VeniceClient>;

const baseCodeResponse = {
  language: 'TypeScript',
  code: 'const add = (a: number, b: number): number => a + b;',
  explanation: 'A simple function that adds two numbers.',
};

beforeEach(() => {
  clearRegistry();
  jest.clearAllMocks();
});

describe('CodingAgent (coding.test.ts)', () => {
  it('returns valid CodingOutput for a code generation prompt', async () => {
    MockVeniceClient.prototype.complete = jest
      .fn()
      .mockResolvedValue(JSON.stringify(baseCodeResponse));

    const venice = new MockVeniceClient();
    const agent = new CodingAgent(venice);
    const result = await agent.execute({
      prompt: 'Write a TypeScript function to add two numbers',
    });
    const output = result.data as CodingOutput;

    expect(output.language).toBeTruthy();
    expect(output.code).toBeTruthy();
    expect(output.explanation).toBeTruthy();
  });

  it('uses the venice-code model', async () => {
    MockVeniceClient.prototype.complete = jest
      .fn()
      .mockResolvedValue(JSON.stringify(baseCodeResponse));

    const venice = new MockVeniceClient();
    const agent = new CodingAgent(venice);
    await agent.execute({ prompt: 'Write a TypeScript function' });

    expect(MockVeniceClient.prototype.complete).toHaveBeenCalledWith(
      expect.any(String),
      'venice-code',
    );
  });

  it('rejects response missing required fields gracefully', async () => {
    // Missing code field — parseModelResponse falls back to raw text
    MockVeniceClient.prototype.complete = jest
      .fn()
      .mockResolvedValue(JSON.stringify({ language: 'ts', explanation: '' }));

    const venice = new MockVeniceClient();
    const agent = new CodingAgent(venice);
    const result = await agent.execute({ prompt: 'test' });
    // Should still return an AgentResult (may have empty code or raw fallback)
    expect(result.agentId).toBe('coding-agent-default');
  });

  it('registers with capability "coding" after start() is called', () => {
    const venice = new MockVeniceClient();
    const agent = new CodingAgent(venice);
    agent.start();
    const meta = getAgent(agent.agentId);
    expect(meta?.capability).toBe('coding');
  });
});
