import { VeniceClient } from './client';
import { CircuitBreaker } from '../../venice/circuitBreaker';

const mockFetch = jest.fn();
(global as any).fetch = mockFetch;

function okResponse(content: string) {
  return {
    ok: true,
    status: 200,
    json: () => Promise.resolve({ choices: [{ message: { content } }] }),
  };
}

describe('VeniceClient caching & deduplication', () => {
  let client: VeniceClient;

  beforeEach(() => {
    mockFetch.mockReset();
    client = new VeniceClient({ apiKey: 'test-key', circuitBreaker: new CircuitBreaker() });
  });

  it('serves a repeat prompt from cache without a second upstream call', async () => {
    mockFetch.mockResolvedValueOnce(okResponse('answer'));
    const first = await client.complete('What is 2+2?', 'research');
    expect(first).toBe('answer');
    expect(mockFetch).toHaveBeenCalledTimes(1);

    const second = await client.complete('What is 2+2?', 'research');
    expect(second).toBe('answer');
    expect(mockFetch).toHaveBeenCalledTimes(1); // cache hit -> no extra call
  });

  it('bypasses the cache when force is set', async () => {
    mockFetch.mockResolvedValueOnce(okResponse('a')).mockResolvedValueOnce(okResponse('b'));
    const first = await client.complete('repeat', 'research');
    expect(first).toBe('a');
    const forced = await client.complete('repeat', 'research', { force: true });
    expect(forced).toBe('b');
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('deduplicates concurrent identical requests into a single upstream call', async () => {
    mockFetch.mockResolvedValueOnce(okResponse('shared'));
    const [a, b] = await Promise.all([
      client.complete('concurrent', 'research'),
      client.complete('concurrent', 'research'),
    ]);
    expect(a).toBe('shared');
    expect(b).toBe('shared');
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('exposes a cache hit rate', async () => {
    mockFetch.mockResolvedValueOnce(okResponse('x'));
    await client.complete('hit-rate', 'research');
    await client.complete('hit-rate', 'research');
    expect(client.getCacheHitRate()).toBeGreaterThan(0);
  });
});
