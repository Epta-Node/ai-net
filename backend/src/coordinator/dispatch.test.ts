/**
 * Unit tests for the HTTP dispatch layer.
 *
 * Uses a mock `fetch` implementation so no real network I/O occurs.
 */

import { httpDispatch, DEFAULT_DISPATCH_OPTIONS, type DispatchOptions } from './dispatch';
import type { AgentRegistration } from '../types/agent';
import type { DAGNode } from '../types/task';

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const mockAgent: AgentRegistration = {
  id: 'agent-research-1',
  type: 'research',
  endpoint: 'http://agent-research:4001',
  cost: 10,
  status: 'online',
};

const mockNode: DAGNode = {
  nodeId: 'node_research',
  type: 'research',
  dependencies: [],
  status: 'running',
  prompt: 'Gather market data for solar energy in Southeast Asia',
};

const mockContext = '';

/** Fast options to avoid slow retries during tests */
const fastOptions: DispatchOptions = {
  timeoutMs: 500,
  maxRetries: 2,
  retryDelayMs: 10,
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Build a mock fetch that returns a successful JSON response */
function successFetch(body: unknown): typeof fetch {
  return jest.fn().mockResolvedValue({
    ok: true,
    status: 200,
    statusText: 'OK',
    text: () => Promise.resolve(JSON.stringify(body)),
  }) as unknown as typeof fetch;
}

/** Build a mock fetch that always returns the given status code */
function statusFetch(status: number, statusText = 'Error'): typeof fetch {
  return jest.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    statusText,
    text: () => Promise.resolve(''),
  }) as unknown as typeof fetch;
}

/** Build a mock fetch that always rejects with a network error */
function networkErrorFetch(message = 'ECONNREFUSED'): typeof fetch {
  return jest.fn().mockRejectedValue(new Error(message)) as unknown as typeof fetch;
}

/** Build a mock fetch that simulates an AbortError (timeout) */
function abortFetch(): typeof fetch {
  const err = new Error('The operation was aborted');
  err.name = 'AbortError';
  return jest.fn().mockRejectedValue(err) as unknown as typeof fetch;
}

/** Build a mock fetch that fails N times then succeeds */
function failThenSucceedFetch(failCount: number, successBody: unknown): typeof fetch {
  let calls = 0;
  return jest.fn().mockImplementation(() => {
    calls += 1;
    if (calls <= failCount) {
      return Promise.resolve({
        ok: false,
        status: 503,
        statusText: 'Service Unavailable',
        text: () => Promise.resolve(''),
      });
    }
    return Promise.resolve({
      ok: true,
      status: 200,
      statusText: 'OK',
      text: () => Promise.resolve(JSON.stringify(successBody)),
    });
  }) as unknown as typeof fetch;
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('httpDispatch', () => {
  describe('successful dispatch', () => {
    it('returns parsed JSON response from the agent', async () => {
      const expected = { summary: 'Solar energy is growing fast in SEA.' };
      const mockFetch = successFetch(expected);

      const result = await httpDispatch(
        mockAgent,
        mockNode.nodeId,
        mockNode,
        mockContext,
        fastOptions,
        mockFetch,
      );

      expect(result).toEqual(expected);
    });

    it('POSTs to <endpoint>/execute with correct headers and body', async () => {
      const mockFetch = successFetch({});

      await httpDispatch(
        mockAgent,
        mockNode.nodeId,
        mockNode,
        'some context',
        fastOptions,
        mockFetch,
      );

      expect(mockFetch).toHaveBeenCalledTimes(1);
      const [url, init] = (mockFetch as jest.Mock).mock.calls[0] as [string, RequestInit];
      expect(url).toBe('http://agent-research:4001/execute');
      expect(init.method).toBe('POST');
      expect((init.headers as Record<string, string>)['Content-Type']).toBe('application/json');

      const body = JSON.parse(init.body as string) as {
        nodeId: string;
        node: DAGNode;
        context: string;
      };
      expect(body.nodeId).toBe('node_research');
      expect(body.node).toMatchObject({ type: 'research' });
      expect(body.context).toBe('some context');
    });

    it('returns empty object when agent returns an empty body', async () => {
      const mockFetch = jest.fn().mockResolvedValue({
        ok: true,
        status: 200,
        statusText: 'OK',
        text: () => Promise.resolve(''),
      }) as unknown as typeof fetch;

      const result = await httpDispatch(
        mockAgent,
        mockNode.nodeId,
        mockNode,
        mockContext,
        fastOptions,
        mockFetch,
      );

      expect(result).toEqual({});
    });

    it('strips trailing slash from agent endpoint before appending /execute', async () => {
      const agentWithSlash = { ...mockAgent, endpoint: 'http://agent-research:4001/' };
      const mockFetch = successFetch({});

      await httpDispatch(agentWithSlash, mockNode.nodeId, mockNode, mockContext, fastOptions, mockFetch);

      const [url] = (mockFetch as jest.Mock).mock.calls[0] as [string];
      expect(url).toBe('http://agent-research:4001/execute');
    });
  });

  describe('retry behaviour', () => {
    it('retries on 503 and succeeds on the next attempt', async () => {
      const expected = { data: 'recovered' };
      const mockFetch = failThenSucceedFetch(1, expected);

      const result = await httpDispatch(
        mockAgent,
        mockNode.nodeId,
        mockNode,
        mockContext,
        fastOptions,
        mockFetch,
      );

      expect(result).toEqual(expected);
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });

    it('retries on 429 rate-limit response', async () => {
      const expected = { data: 'after rate limit' };
      const mockFetch = failThenSucceedFetch(1, expected);
      // Override the first call to return 429
      let firstCall = true;
      (mockFetch as jest.Mock).mockImplementation(() => {
        if (firstCall) {
          firstCall = false;
          return Promise.resolve({ ok: false, status: 429, statusText: 'Too Many Requests', text: () => Promise.resolve('') });
        }
        return Promise.resolve({ ok: true, status: 200, statusText: 'OK', text: () => Promise.resolve(JSON.stringify(expected)) });
      });

      const result = await httpDispatch(
        mockAgent,
        mockNode.nodeId,
        mockNode,
        mockContext,
        fastOptions,
        mockFetch,
      );

      expect(result).toEqual(expected);
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });

    it('retries on network errors (ECONNREFUSED)', async () => {
      const expected = { data: 'after network error' };
      let calls = 0;
      const mockFetch = jest.fn().mockImplementation(() => {
        calls += 1;
        if (calls === 1) return Promise.reject(new Error('ECONNREFUSED'));
        return Promise.resolve({
          ok: true,
          status: 200,
          statusText: 'OK',
          text: () => Promise.resolve(JSON.stringify(expected)),
        });
      }) as unknown as typeof fetch;

      const result = await httpDispatch(
        mockAgent,
        mockNode.nodeId,
        mockNode,
        mockContext,
        fastOptions,
        mockFetch,
      );

      expect(result).toEqual(expected);
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });

    it('throws after all retries are exhausted', async () => {
      const mockFetch = statusFetch(503, 'Service Unavailable');

      await expect(
        httpDispatch(
          mockAgent,
          mockNode.nodeId,
          mockNode,
          mockContext,
          fastOptions,
          mockFetch,
        ),
      ).rejects.toThrow(/503/);

      // 1 initial + 2 retries = 3 total calls
      expect(mockFetch).toHaveBeenCalledTimes(fastOptions.maxRetries + 1);
    });

    it('does NOT retry on 4xx non-retryable errors (e.g. 400)', async () => {
      const mockFetch = statusFetch(400, 'Bad Request');

      await expect(
        httpDispatch(
          mockAgent,
          mockNode.nodeId,
          mockNode,
          mockContext,
          fastOptions,
          mockFetch,
        ),
      ).rejects.toThrow(/non-retryable 400/);

      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it('does NOT retry on 404 Not Found', async () => {
      const mockFetch = statusFetch(404, 'Not Found');

      await expect(
        httpDispatch(
          mockAgent,
          mockNode.nodeId,
          mockNode,
          mockContext,
          fastOptions,
          mockFetch,
        ),
      ).rejects.toThrow(/non-retryable 404/);

      expect(mockFetch).toHaveBeenCalledTimes(1);
    });
  });

  describe('timeout handling', () => {
    it('wraps AbortError as a descriptive timeout error', async () => {
      const mockFetch = abortFetch();

      await expect(
        httpDispatch(
          mockAgent,
          mockNode.nodeId,
          mockNode,
          mockContext,
          { ...fastOptions, maxRetries: 0 },
          mockFetch,
        ),
      ).rejects.toThrow(/timed out after 500ms/);
    });

    it('retries after timeout up to maxRetries times', async () => {
      const mockFetch = abortFetch();

      await expect(
        httpDispatch(
          mockAgent,
          mockNode.nodeId,
          mockNode,
          mockContext,
          fastOptions, // maxRetries: 2
          mockFetch,
        ),
      ).rejects.toThrow(/timed out/);

      // 1 initial + 2 retries = 3 attempts
      expect(mockFetch).toHaveBeenCalledTimes(fastOptions.maxRetries + 1);
    });
  });

  describe('DEFAULT_DISPATCH_OPTIONS', () => {
    it('has 60s timeout, 3 max retries, 1s base delay', () => {
      expect(DEFAULT_DISPATCH_OPTIONS.timeoutMs).toBe(60_000);
      expect(DEFAULT_DISPATCH_OPTIONS.maxRetries).toBe(3);
      expect(DEFAULT_DISPATCH_OPTIONS.retryDelayMs).toBe(1_000);
    });
  });
});
