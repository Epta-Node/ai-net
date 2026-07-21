import { ResearchAgent, deriveConfidence } from './research';
import type { VeniceClientLike } from '../../services/venice/index';
import type { AgentResult, AgentError } from './types';

function makeVeniceJson(sourceCount: number): string {
  const sources = Array.from({ length: sourceCount }, (_, i) => ({
    url: `https://example.com/source-${i + 1}`,
    title: `Source ${i + 1}`,
  }));
  return JSON.stringify({
    summary: 'Test summary of the research topic.',
    keyFindings: ['Finding one', 'Finding two'],
    sources,
    confidence: 0.8,
  });
}

function asResult(r: AgentResult | AgentError): AgentResult {
  if ('error' in r) throw new Error(`Expected AgentResult but got AgentError: ${r.error}`);
  return r;
}

function asError(r: AgentResult | AgentError): AgentError {
  if (!('error' in r)) throw new Error('Expected AgentError but got AgentResult');
  return r;
}

function createMockClient(): jest.Mocked<VeniceClientLike> {
  return {
    chat: jest.fn(),
    complete: jest.fn(),
    stream: jest.fn(),
    getModelFor: jest.fn().mockReturnValue('venice-xl'),
    getCircuitState: jest.fn().mockReturnValue('CLOSED'),
    getFailureCount: jest.fn().mockReturnValue(0),
  } as any;
}

describe('deriveConfidence', () => {
  it.each([
    [0, 0.3],
    [1, 0.6],
    [2, 0.6],
    [3, 0.6],
    [4, 0.9],
    [10, 0.9],
  ])('sourceCount=%i → confidence=%f', (sourceCount: number, expected: number) => {
    expect(deriveConfidence(sourceCount)).toBe(expected);
  });
});

describe('ResearchAgent.execute — normal path', () => {
  it('returns a valid AgentResult with all required fields for a non-empty prompt', async () => {
    const mock = createMockClient();
    mock.complete.mockResolvedValueOnce(makeVeniceJson(4));

    const agent = new ResearchAgent({ veniceClient: mock });
    const result = await agent.execute({
      taskId: 'task_abc',
      nodeId: 'node_1',
      prompt: 'Research the impact of AI on healthcare.',
    });

    const r = asResult(result);
    expect(r.taskId).toBe('task_abc');
    expect(r.nodeId).toBe('node_1');
    expect(typeof r.summary).toBe('string');
    expect(r.summary.length).toBeGreaterThan(0);
    expect(Array.isArray(r.keyFindings)).toBe(true);
    expect(r.keyFindings.length).toBeGreaterThan(0);
    expect(Array.isArray(r.sources)).toBe(true);
    expect(typeof r.confidence).toBe('number');
  });

  it('applies deterministic confidence scoring (4 sources → 0.9)', async () => {
    const mock = createMockClient();
    mock.complete.mockResolvedValueOnce(makeVeniceJson(4));

    const agent = new ResearchAgent({ veniceClient: mock });
    const result = asResult(await agent.execute({ taskId: 't1', nodeId: 'n1', prompt: 'AI in finance' }));

    expect(result.confidence).toBe(0.9);
    expect(result.sources).toHaveLength(4);
  });

  it('applies deterministic confidence scoring (0 sources → 0.3)', async () => {
    const mock = createMockClient();
    mock.complete.mockResolvedValueOnce(makeVeniceJson(0));

    const agent = new ResearchAgent({ veniceClient: mock });
    const result = asResult(await agent.execute({ taskId: 't2', nodeId: 'n2', prompt: 'Quantum computing' }));

    expect(result.confidence).toBe(0.3);
  });

  it('includes optional context in the prompt', async () => {
    const mock = createMockClient();
    mock.complete.mockResolvedValueOnce(makeVeniceJson(2));

    const agent = new ResearchAgent({ veniceClient: mock });
    await agent.execute({
      taskId: 't3',
      nodeId: 'n3',
      prompt: 'Summarise market trends',
      context: 'Focus on Southeast Asia.',
    });

    expect(mock.complete).toHaveBeenCalledWith(
      expect.stringContaining('Focus on Southeast Asia.'),
      'research'
    );
  });
});

describe('ResearchAgent.execute — malformed JSON retry', () => {
  it('retries exactly once when the first response is not valid JSON', async () => {
    const mock = createMockClient();
    mock.complete
      .mockResolvedValueOnce('This is NOT json at all.')
      .mockResolvedValueOnce(makeVeniceJson(2));

    const agent = new ResearchAgent({ veniceClient: mock });
    const result = asResult(await agent.execute({ taskId: 't4', nodeId: 'n4', prompt: 'Blockchain adoption' }));

    expect(mock.complete).toHaveBeenCalledTimes(2);
    expect(result.confidence).toBe(0.6);
  });

  it('retry call appends the JSON-mode instruction to the prompt', async () => {
    const mock = createMockClient();
    mock.complete
      .mockResolvedValueOnce('not json')
      .mockResolvedValueOnce(makeVeniceJson(1));

    const agent = new ResearchAgent({ veniceClient: mock });
    await agent.execute({ taskId: 't5', nodeId: 'n5', prompt: 'Climate change research' });

    const retryPrompt = mock.complete.mock.calls[1][0];
    expect(retryPrompt).toContain('CRITICAL: Your previous response was not valid JSON');
  });

  it('does NOT make a third call if both attempts fail', async () => {
    const mock = createMockClient();
    mock.complete.mockResolvedValue('still not valid json');

    const agent = new ResearchAgent({ veniceClient: mock });
    const result = await agent.execute({ taskId: 't6', nodeId: 'n6', prompt: 'Nanotechnology trends' });

    expect(mock.complete).toHaveBeenCalledTimes(2);
    expect(asError(result).error).toBe('VENICE_MALFORMED_RESPONSE');
  });

  it('retries once when the response is valid JSON but fails Zod schema validation', async () => {
    const badSchema = JSON.stringify({ wrong: 'shape' });
    const mock = createMockClient();
    mock.complete
      .mockResolvedValueOnce(badSchema)
      .mockResolvedValueOnce(makeVeniceJson(3));

    const agent = new ResearchAgent({ veniceClient: mock });
    const result = asResult(await agent.execute({ taskId: 't7', nodeId: 'n7', prompt: 'Robotics market' }));

    expect(mock.complete).toHaveBeenCalledTimes(2);
    expect(result.confidence).toBe(0.6);
  });
});

describe('ResearchAgent.execute — Venice unavailable', () => {
  it('returns { error: "VENICE_UNAVAILABLE" } when first call throws', async () => {
    const mock = createMockClient();
    mock.complete.mockRejectedValueOnce(new Error('Venice AI is unreachable'));

    const agent = new ResearchAgent({ veniceClient: mock });
    const result = await agent.execute({ taskId: 't8', nodeId: 'n8', prompt: 'Space exploration' });

    expect(asError(result).error).toBe('VENICE_UNAVAILABLE');
  });

  it('does NOT throw — returns a plain object', async () => {
    const mock = createMockClient();
    mock.complete.mockRejectedValue(new Error('down'));

    const agent = new ResearchAgent({ veniceClient: mock });

    await expect(
      agent.execute({ taskId: 't9', nodeId: 'n9', prompt: 'Fusion energy' })
    ).resolves.toEqual({ error: 'VENICE_UNAVAILABLE' });
  });

  it('returns { error: "VENICE_UNAVAILABLE" } when retry call also throws', async () => {
    const mock = createMockClient();
    mock.complete
      .mockResolvedValueOnce('bad json')
      .mockRejectedValueOnce(new Error('down on retry'));

    const agent = new ResearchAgent({ veniceClient: mock });
    const result = await agent.execute({ taskId: 't10', nodeId: 'n10', prompt: 'Renewables' });

    expect(asError(result).error).toBe('VENICE_UNAVAILABLE');
    expect(mock.complete).toHaveBeenCalledTimes(2);
  });
});
