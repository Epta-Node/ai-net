import { DesignAgent } from '../../../src/agents/design/design';
import type { VeniceClientLike } from '../../../src/services/venice/index';

describe('DesignAgent', () => {
  let mockVeniceClient: jest.Mocked<VeniceClientLike>;
  let agent: DesignAgent;

  beforeEach(() => {
    mockVeniceClient = {
      chat: jest.fn(),
      complete: jest.fn(),
      stream: jest.fn(),
      getModelFor: jest.fn().mockReturnValue('venice-xl'),
      getCircuitState: jest.fn().mockReturnValue('CLOSED'),
      getFailureCount: jest.fn().mockReturnValue(0),
    } as any;

    agent = new DesignAgent({
      veniceClient: mockVeniceClient,
      apiBaseUrl: 'http://test.local',
      agentId: 'test-design-agent',
    });
  });

  describe('execute - normal path', () => {
    it('should generate design specifications successfully', async () => {
      const mockResponse = {
        wireframes: [
          {
            name: 'Homepage',
            description: 'Main landing page layout',
            components: ['Header', 'Hero Section', 'Footer'],
          },
        ],
        colorPalette: [
          {
            name: 'Primary Blue',
            hex: '#0066CC',
            usage: 'Primary buttons and links',
          },
        ],
        componentHierarchy: [
          {
            component: 'App',
            children: ['Header', 'Main', 'Footer'],
            props: ['theme'],
          },
        ],
        assetManifest: [
          {
            type: 'image',
            name: 'logo.svg',
            description: 'Company logo in SVG format',
            dimensions: '200x60',
          },
        ],
      };

      mockVeniceClient.complete.mockResolvedValueOnce(JSON.stringify(mockResponse));

      const result = await agent.execute({
        taskId: 'task-1',
        nodeId: 'design-node',
        prompt: 'Design a modern homepage layout',
      });

      expect(result).toEqual(mockResponse);
    });

    it('should handle context parameter', async () => {
      const mockResponse = {
        wireframes: [
          {
            name: 'Mobile App',
            description: 'Responsive mobile interface',
            components: ['Navigation', 'Content Area'],
          },
        ],
        colorPalette: [
          {
            name: 'Brand Green',
            hex: '#00AA44',
            usage: 'Success states and CTA buttons',
          },
        ],
        componentHierarchy: [
          {
            component: 'MobileApp',
            children: ['NavBar', 'ContentView'],
          },
        ],
        assetManifest: [
          {
            type: 'icon',
            name: 'app-icon.png',
            description: 'Mobile app icon',
            dimensions: '512x512',
          },
        ],
      };

      mockVeniceClient.complete.mockResolvedValueOnce(JSON.stringify(mockResponse));

      const result = await agent.execute({
        taskId: 'task-1',
        nodeId: 'design-node',
        prompt: 'Design mobile interface',
        context: 'Target audience: millennials, focus on accessibility',
      });

      expect(result).toEqual(mockResponse);
      expect(mockVeniceClient.complete).toHaveBeenCalledWith(
        expect.stringContaining('Target audience: millennials'),
        'design'
      );
    });

    it('should validate hex color format', async () => {
      const mockResponse = {
        wireframes: [],
        colorPalette: [
          {
            name: 'Invalid Color',
            hex: 'not-a-hex-color',
            usage: 'Invalid hex format',
          },
        ],
        componentHierarchy: [],
        assetManifest: [],
      };

      mockVeniceClient.complete
        .mockResolvedValueOnce(JSON.stringify(mockResponse))
        .mockResolvedValueOnce(JSON.stringify(mockResponse));

      const result = await agent.execute({
        taskId: 'task-1',
        nodeId: 'design-node',
        prompt: 'Test invalid color',
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
        nodeId: 'design-node',
        prompt: 'Test invalid response',
      });

      expect(result).toEqual({ error: 'VENICE_MALFORMED_RESPONSE' });
    });

    it('should return VENICE_MALFORMED_RESPONSE on missing required fields', async () => {
      const incompleteResponse = {
        wireframes: [
          {
            name: 'Incomplete',
          },
        ],
        colorPalette: [],
        componentHierarchy: [],
        assetManifest: [],
      };

      mockVeniceClient.complete
        .mockResolvedValueOnce(JSON.stringify(incompleteResponse))
        .mockResolvedValueOnce(JSON.stringify(incompleteResponse));

      const result = await agent.execute({
        taskId: 'task-1',
        nodeId: 'design-node',
        prompt: 'Test incomplete response',
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
        nodeId: 'design-node',
        prompt: 'Test Venice failure',
      });

      expect(result).toEqual({ error: 'VENICE_UNAVAILABLE' });
    });

    it('should return VENICE_UNAVAILABLE on unexpected error', async () => {
      mockVeniceClient.complete.mockRejectedValueOnce(
        new Error('Unexpected network error')
      );

      const result = await agent.execute({
        taskId: 'task-1',
        nodeId: 'design-node',
        prompt: 'Test unexpected error',
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
    it('should return "design"', () => {
      expect(agent.getCapability()).toBe('design');
    });
  });
});
