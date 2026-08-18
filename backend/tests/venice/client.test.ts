import { VeniceClient } from '../../src/services/venice/client';
import { CircuitBreaker } from '../../src/venice/circuitBreaker';
import { CircuitOpenError, TokenBudgetExceededError } from '../../src/venice/errors';

const mockFetch = jest.fn();
(global as any).fetch = mockFetch;

function okResponse(content: string) {
  return {
    ok: true,
    status: 200,
    json: () => Promise.resolve({
      choices: [{ message: { content } }],
    }),
  };
}

function errorResponse(status: number) {
  return {
    ok: false,
    status,
    json: () => Promise.resolve({ error: 'fail' }),
  };
}

function streamResponse(chunks: string[]) {
  const encoder = new TextEncoder();
  let index = 0;
  return {
    ok: true,
    status: 200,
    body: {
      getReader: () => ({
        read: () => {
          if (index < chunks.length) {
            const chunk = chunks[index++];
            const data = `data: ${JSON.stringify({ choices: [{ delta: { content: chunk } }] })}\n\n`;
            return Promise.resolve({ done: false, value: encoder.encode(data) });
          }
          return Promise.resolve({ done: true, value: undefined });
        },
      }),
    },
  };
}

describe('VeniceClient', () => {
  let client: VeniceClient;
  let breaker: CircuitBreaker;

  beforeEach(() => {
    mockFetch.mockReset();
    breaker = new CircuitBreaker();
    client = new VeniceClient({
      apiKey: 'test-key',
      circuitBreaker: breaker,
    });
  });

  describe('getModelFor', () => {
    it('returns venice-code for coding agent', () => {
      expect(client.getModelFor('coding')).toBe('venice-code');
    });

    it('returns venice-xl for research agent', () => {
      expect(client.getModelFor('research')).toBe('venice-xl');
    });

    it('returns venice-xl for risk agent', () => {
      expect(client.getModelFor('risk')).toBe('venice-xl');
    });

    it('returns venice-xl for design agent', () => {
      expect(client.getModelFor('design')).toBe('venice-xl');
    });

    it('returns venice-xl for report agent', () => {
      expect(client.getModelFor('report')).toBe('venice-xl');
    });
  });

  describe('complete', () => {
    it('returns content from a successful response', async () => {
      mockFetch.mockResolvedValueOnce(okResponse('Hello world'));

      const result = await client.complete('Say hello', 'research');

      expect(result).toBe('Hello world');
    });

    it('uses default maxTokens of 2048', async () => {
      mockFetch.mockResolvedValueOnce(okResponse('ok'));

      await client.complete('test', 'research');

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.max_tokens).toBe(2048);
    });

    it('throws TokenBudgetExceededError when maxTokens > 8192', async () => {
      await expect(
        client.complete('test', 'research', { maxTokens: 8193 })
      ).rejects.toThrow(TokenBudgetExceededError);

      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('allows maxTokens up to 8192', async () => {
      mockFetch.mockResolvedValueOnce(okResponse('ok'));

      await client.complete('test', 'research', { maxTokens: 8192 });

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.max_tokens).toBe(8192);
    });
  });

  describe('chat', () => {
    it('sends caller-provided messages through the shared completion endpoint', async () => {
      mockFetch.mockResolvedValueOnce(okResponse('chat response'));

      const result = await client.chat(
        [
          { role: 'system', content: 'You are concise.' },
          { role: 'user', content: 'Summarize this.' },
        ],
        { model: 'custom-model', temperature: 0.4, maxTokens: 512 }
      );

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(result).toBe('chat response');
      expect(body).toEqual({
        model: 'custom-model',
        messages: [
          { role: 'system', content: 'You are concise.' },
          { role: 'user', content: 'Summarize this.' },
        ],
        temperature: 0.4,
        max_tokens: 512,
      });
    });

    it('uses the default chat model when one is not provided', async () => {
      mockFetch.mockResolvedValueOnce(okResponse('chat response'));

      await client.chat([{ role: 'user', content: 'Hello' }]);

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.model).toBe('llama-3.3-70b');
    });
  });

  describe('circuit breaker integration', () => {
    it('opens after 3 consecutive failures and rejects the 4th without HTTP', async () => {
      mockFetch
        .mockResolvedValueOnce(errorResponse(500))
        .mockResolvedValueOnce(errorResponse(500))
        .mockResolvedValueOnce(errorResponse(500))
        .mockResolvedValueOnce(errorResponse(500))
        .mockResolvedValueOnce(errorResponse(500))
        .mockResolvedValueOnce(errorResponse(500))
        .mockResolvedValueOnce(errorResponse(500))
        .mockResolvedValueOnce(errorResponse(500))
        .mockResolvedValueOnce(errorResponse(500))
        .mockResolvedValueOnce(errorResponse(500))
        .mockResolvedValueOnce(errorResponse(500))
        .mockResolvedValueOnce(errorResponse(500));

      await expect(client.complete('test1', 'research')).rejects.toThrow();
      await expect(client.complete('test2', 'research')).rejects.toThrow();
      await expect(client.complete('test3', 'research')).rejects.toThrow();

      const fetchCallsBefore = mockFetch.mock.calls.length;

      await expect(client.complete('test4', 'research')).rejects.toThrow(CircuitOpenError);

      expect(mockFetch.mock.calls.length).toBe(fetchCallsBefore);
    });
  });

  describe('retry logic', () => {
    it('retries on HTTP 429 with exponential backoff', async () => {
      mockFetch
        .mockResolvedValueOnce(errorResponse(429))
        .mockResolvedValueOnce(okResponse('ok'));

      const result = await client.complete('test', 'research');

      expect(result).toBe('ok');
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });

    it('retries on HTTP 503', async () => {
      mockFetch
        .mockResolvedValueOnce(errorResponse(503))
        .mockResolvedValueOnce(okResponse('ok'));

      const result = await client.complete('test', 'research');

      expect(result).toBe('ok');
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });

    it('does NOT retry on HTTP 400', async () => {
      mockFetch.mockResolvedValueOnce(errorResponse(400));

      await expect(client.complete('test', 'research')).rejects.toThrow(
        'Venice returned non-retryable status: 400'
      );

      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it('does NOT retry on HTTP 401', async () => {
      mockFetch.mockResolvedValueOnce(errorResponse(401));

      await expect(client.complete('test', 'research')).rejects.toThrow();

      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it('does NOT retry on HTTP 422', async () => {
      mockFetch.mockResolvedValueOnce(errorResponse(422));

      await expect(client.complete('test', 'research')).rejects.toThrow();

      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it('retries up to 3 times on retryable errors', async () => {
      mockFetch
        .mockResolvedValueOnce(errorResponse(429))
        .mockResolvedValueOnce(errorResponse(429))
        .mockResolvedValueOnce(errorResponse(429))
        .mockResolvedValueOnce(okResponse('ok'));

      const result = await client.complete('test', 'research');

      expect(result).toBe('ok');
      expect(mockFetch).toHaveBeenCalledTimes(4);
    });
  });

  describe('stream', () => {
    it('calls onChunk for each token and resolves', async () => {
      mockFetch.mockResolvedValueOnce(streamResponse(['Hello', ' ', 'world']));

      const chunks: string[] = [];
      await client.stream('test', 'research', (chunk) => chunks.push(chunk));

      expect(chunks).toEqual(['Hello', ' ', 'world']);
    });

    it('calls onChunk at least once before resolving', async () => {
      mockFetch.mockResolvedValueOnce(streamResponse(['single']));

      const chunks: string[] = [];
      await client.stream('test', 'research', (chunk) => chunks.push(chunk));

      expect(chunks.length).toBeGreaterThanOrEqual(1);
    });

    it('throws TokenBudgetExceededError for maxTokens > 8192', async () => {
      await expect(
        client.stream('test', 'research', () => {}, { maxTokens: 9000 })
      ).rejects.toThrow(TokenBudgetExceededError);

      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('applies circuit breaker to stream calls', async () => {
      mockFetch
        .mockResolvedValueOnce(errorResponse(500))
        .mockResolvedValueOnce(errorResponse(500))
        .mockResolvedValueOnce(errorResponse(500))
        .mockResolvedValueOnce(errorResponse(500))
        .mockResolvedValueOnce(errorResponse(500))
        .mockResolvedValueOnce(errorResponse(500))
        .mockResolvedValueOnce(errorResponse(500))
        .mockResolvedValueOnce(errorResponse(500))
        .mockResolvedValueOnce(errorResponse(500))
        .mockResolvedValueOnce(errorResponse(500))
        .mockResolvedValueOnce(errorResponse(500))
        .mockResolvedValueOnce(errorResponse(500));

      await expect(client.complete('test1', 'research')).rejects.toThrow();
      await expect(client.complete('test2', 'research')).rejects.toThrow();
      await expect(client.complete('test3', 'research')).rejects.toThrow();

      await expect(
        client.stream('test4', 'research', () => {})
      ).rejects.toThrow(CircuitOpenError);
    });
  });
});
