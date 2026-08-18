import { ReportAgent, InsufficientContextError } from '../../../src/agents/report/report';
import type { VeniceClientLike } from '../../../src/services/venice/index';

describe('ReportAgent', () => {
  let mockVeniceClient: jest.Mocked<VeniceClientLike>;
  let agent: ReportAgent;

  beforeEach(() => {
    mockVeniceClient = {
      chat: jest.fn(),
      complete: jest.fn(),
      stream: jest.fn(),
      getModelFor: jest.fn().mockReturnValue('venice-xl'),
      getCircuitState: jest.fn().mockReturnValue('CLOSED'),
      getFailureCount: jest.fn().mockReturnValue(0),
    } as any;

    agent = new ReportAgent({
      veniceClient: mockVeniceClient,
      apiBaseUrl: 'http://test.local',
      agentId: 'test-report-agent',
    });
  });

  const mockUpstreamResults = [
    {
      agentId: 'research-1',
      capability: 'research',
      data: { summary: 'Market research findings' },
    },
    {
      agentId: 'risk-1',
      capability: 'risk',
      data: { overallRiskScore: 3.2 },
    },
  ];

  describe('execute - normal path', () => {
    it('should generate report with all mandatory sections', async () => {
      const mockResponse = {
        title: 'Market Analysis Report',
        sections: [
          {
            heading: 'Executive Summary',
            content: '## Key Insights\n\nThis analysis covers...',
            sourceAgents: ['research-1'],
          },
          {
            heading: 'Findings',
            content: '## Research Results\n\nThe market shows...',
            sourceAgents: ['research-1'],
          },
          {
            heading: 'Risk Analysis',
            content: '## Risk Assessment\n\nOverall risk score is 3.2...',
            sourceAgents: ['risk-1'],
          },
          {
            heading: 'Recommendations',
            content: '## Strategic Recommendations\n\nWe recommend...',
            sourceAgents: ['research-1', 'risk-1'],
          },
          {
            heading: 'Conclusion',
            content: '## Final Thoughts\n\nIn conclusion...',
            sourceAgents: ['research-1', 'risk-1'],
          },
        ],
        wordCount: 50,
        generatedAt: '2025-01-01T00:00:00.000Z',
      };

      mockVeniceClient.complete.mockResolvedValueOnce(JSON.stringify(mockResponse));

      const result = await agent.execute({
        taskId: 'task-1',
        nodeId: 'report-node',
        prompt: 'Generate comprehensive market report',
        upstreamResults: mockUpstreamResults,
      });

      expect('error' in result).toBe(false);
      if (!('error' in result)) {
        expect(result.title).toBe('Market Analysis Report');
        expect(result.sections).toHaveLength(5);
        expect(result.sections.map(s => s.heading)).toEqual([
          'Executive Summary',
          'Findings',
          'Risk Analysis',
          'Recommendations',
          'Conclusion',
        ]);
        expect(result.generatedAt).toBeDefined();
        expect(result.wordCount).toBeGreaterThan(0);
      }
    });

    it('should calculate word count correctly', async () => {
      const mockResponse = {
        title: 'Test Report',
        sections: [
          {
            heading: 'Executive Summary',
            content: 'This is a five word summary.',
            sourceAgents: ['test-1'],
          },
          {
            heading: 'Findings',
            content: 'These are three words.',
            sourceAgents: ['test-1'],
          },
          {
            heading: 'Risk Analysis',
            content: 'Two words.',
            sourceAgents: ['test-1'],
          },
          {
            heading: 'Recommendations',
            content: 'One word: recommendation.',
            sourceAgents: ['test-1'],
          },
          {
            heading: 'Conclusion',
            content: 'Final.',
            sourceAgents: ['test-1'],
          },
        ],
        wordCount: 14,
        generatedAt: '2025-01-01T00:00:00.000Z',
      };

      mockVeniceClient.complete.mockResolvedValueOnce(JSON.stringify(mockResponse));

      const result = await agent.execute({
        taskId: 'task-1',
        nodeId: 'report-node',
        prompt: 'Generate test report',
        upstreamResults: mockUpstreamResults,
      });

      expect('error' in result).toBe(false);
      if (!('error' in result)) {
        expect(result.wordCount).toBe(16);
      }
    });

    it('should include upstream results in Venice prompt', async () => {
      const mockResponse = {
        title: 'Test Report',
        sections: [
          { heading: 'Executive Summary', content: 'Summary', sourceAgents: [] },
          { heading: 'Findings', content: 'Findings', sourceAgents: [] },
          { heading: 'Risk Analysis', content: 'Risk', sourceAgents: [] },
          { heading: 'Recommendations', content: 'Recommendations', sourceAgents: [] },
          { heading: 'Conclusion', content: 'Conclusion', sourceAgents: [] },
        ],
        wordCount: 0,
        generatedAt: '',
      };

      mockVeniceClient.complete.mockResolvedValueOnce(JSON.stringify(mockResponse));

      await agent.execute({
        taskId: 'task-1',
        nodeId: 'report-node',
        prompt: 'Generate report',
        upstreamResults: mockUpstreamResults,
      });

      expect(mockVeniceClient.complete).toHaveBeenCalledWith(
        expect.stringContaining('Upstream Results:'),
        'report'
      );
    });
  });

  describe('execute - InsufficientContextError', () => {
    it('should throw InsufficientContextError when upstreamResults is undefined', async () => {
      await expect(
        agent.execute({
          taskId: 'task-1',
          nodeId: 'report-node',
          prompt: 'Generate report',
        })
      ).rejects.toThrow(InsufficientContextError);
    });

    it('should throw InsufficientContextError when upstreamResults is empty', async () => {
      await expect(
        agent.execute({
          taskId: 'task-1',
          nodeId: 'report-node',
          prompt: 'Generate report',
          upstreamResults: [],
        })
      ).rejects.toThrow(InsufficientContextError);
    });
  });

  describe('execute - mandatory sections validation', () => {
    it('should return VENICE_MALFORMED_RESPONSE when missing mandatory sections', async () => {
      const incompleteResponse = {
        title: 'Incomplete Report',
        sections: [
          {
            heading: 'Executive Summary',
            content: 'Summary only',
            sourceAgents: [],
          },
        ],
        wordCount: 2,
        generatedAt: '2025-01-01T00:00:00.000Z',
      };

      mockVeniceClient.complete
        .mockResolvedValueOnce(JSON.stringify(incompleteResponse))
        .mockResolvedValueOnce(JSON.stringify(incompleteResponse));

      const result = await agent.execute({
        taskId: 'task-1',
        nodeId: 'report-node',
        prompt: 'Generate incomplete report',
        upstreamResults: mockUpstreamResults,
      });

      expect(result).toEqual({ error: 'VENICE_MALFORMED_RESPONSE' });
    });

    it('should return VENICE_MALFORMED_RESPONSE when section headings are incorrect', async () => {
      const wrongHeadingsResponse = {
        title: 'Wrong Headings Report',
        sections: [
          { heading: 'Wrong Summary', content: 'Content', sourceAgents: [] },
          { heading: 'Wrong Findings', content: 'Content', sourceAgents: [] },
          { heading: 'Wrong Risk', content: 'Content', sourceAgents: [] },
          { heading: 'Wrong Recommendations', content: 'Content', sourceAgents: [] },
          { heading: 'Wrong Conclusion', content: 'Content', sourceAgents: [] },
        ],
        wordCount: 5,
        generatedAt: '2025-01-01T00:00:00.000Z',
      };

      mockVeniceClient.complete
        .mockResolvedValueOnce(JSON.stringify(wrongHeadingsResponse))
        .mockResolvedValueOnce(JSON.stringify(wrongHeadingsResponse));

      const result = await agent.execute({
        taskId: 'task-1',
        nodeId: 'report-node',
        prompt: 'Generate report with wrong headings',
        upstreamResults: mockUpstreamResults,
      });

      expect(result).toEqual({ error: 'VENICE_MALFORMED_RESPONSE' });
    });
  });

  describe('execute - Zod validation failure', () => {
    it('should return VENICE_MALFORMED_RESPONSE on invalid schema', async () => {
      const invalidResponse = {
        invalidField: 'invalid data',
      };

      mockVeniceClient.complete
        .mockResolvedValueOnce(JSON.stringify(invalidResponse))
        .mockResolvedValueOnce(JSON.stringify(invalidResponse));

      const result = await agent.execute({
        taskId: 'task-1',
        nodeId: 'report-node',
        prompt: 'Test invalid response',
        upstreamResults: mockUpstreamResults,
      });

      expect(result).toEqual({ error: 'VENICE_MALFORMED_RESPONSE' });
    });
  });

  describe('execute - Venice failure', () => {
    it('should return VENICE_UNAVAILABLE on error', async () => {
      mockVeniceClient.complete.mockRejectedValueOnce(
        new Error('Service unavailable')
      );

      const result = await agent.execute({
        taskId: 'task-1',
        nodeId: 'report-node',
        prompt: 'Test Venice failure',
        upstreamResults: mockUpstreamResults,
      });

      expect(result).toEqual({ error: 'VENICE_UNAVAILABLE' });
    });

    it('should return VENICE_UNAVAILABLE on unexpected error', async () => {
      mockVeniceClient.complete.mockRejectedValueOnce(
        new Error('Unexpected network error')
      );

      const result = await agent.execute({
        taskId: 'task-1',
        nodeId: 'report-node',
        prompt: 'Test unexpected error',
        upstreamResults: mockUpstreamResults,
      });

      expect(result).toEqual({ error: 'VENICE_UNAVAILABLE' });
    });
  });

  describe('healthCheck', () => {
    it('should return true when Venice is available', async () => {
      mockVeniceClient.complete.mockResolvedValueOnce('Hello back');

      const result = await agent.healthCheck();

      expect(result).toBe(true);
    });

    it('should return false when Venice is unavailable', async () => {
      mockVeniceClient.complete.mockRejectedValueOnce(
        new Error('Service unavailable')
      );

      const result = await agent.healthCheck();

      expect(result).toBe(false);
    });
  });

  describe('getCapability', () => {
    it('should return "report"', () => {
      expect(agent.getCapability()).toBe('report');
    });
  });
});
