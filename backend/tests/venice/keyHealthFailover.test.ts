/**
 * Health-aware Venice fallback key rotation (issue #741).
 *
 * Before this, the chain was tried in configured order on every call, so a
 * key that was refusing requests with 429 cost one guaranteed failed request
 * per call until the breaker opened — and once the quota window rolled over
 * the key silently became usable again, which is why permanent demotion is
 * also wrong. These tests pin the win: the cooled-down key stops costing a
 * request, recovery happens on a timer with no operator action, the backoff
 * escalates while the quota stays exhausted, and the chain never refuses to
 * try at all.
 */

import { VeniceClient } from '../../src/services/venice/client';
import { CircuitBreaker } from '../../src/services/venice/circuitBreaker';
import { VeniceKeyHealthStore } from '../../src/services/venice/keyHealth';

const mockFetch = jest.fn();
(global as any).fetch = mockFetch;

const P1 = { apiKey: 'sk-alpha-quota-secret', baseUrl: 'https://p1.test', name: 'primary' };
const P2 = { apiKey: 'sk-beta-healthy-secret', baseUrl: 'https://p2.test', name: 'fallback' };

function okResponse(content: string) {
  return {
    ok: true,
    status: 200,
    json: () => Promise.resolve({ choices: [{ message: { content } }] }),
  };
}

function statusResponse(status: number) {
  return {
    ok: false,
    status,
    json: () => Promise.resolve({ error: 'nope' }),
  };
}

function fetchUrls(): string[] {
  return mockFetch.mock.calls.map((call) => String(call[0]));
}

function makeClient(now: { t: number }, providers = [P1, P2]) {
  const store = new VeniceKeyHealthStore({
    nowFn: () => now.t,
    cooldownMs: 60_000,
    maxCooldownMs: 600_000,
    logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
  });
  const client = new VeniceClient({
    providers,
    circuitBreaker: new CircuitBreaker(),
    keyHealth: store,
    // Zero retries keeps fetch call counts deterministic.
    maxRetries: 0,
  });
  return { client, store };
}

describe('health-aware key rotation (#741)', () => {
  beforeEach(() => mockFetch.mockReset());

  it('skips a quota-cooled key on the very next call instead of paying for its 429', async () => {
    const now = { t: 1_000_000 };
    const { client } = makeClient(now);

    // Call 1: primary is out of quota, fallback serves.
    mockFetch
      .mockResolvedValueOnce(statusResponse(429))
      .mockResolvedValueOnce(okResponse('served by fallback'));
    await expect(client.complete('prompt-1', 'research')).resolves.toBe('served by fallback');
    expect(fetchUrls()).toEqual([
      'https://p1.test/chat/completions',
      'https://p2.test/chat/completions',
    ]);

    // Call 2, same instant: primary must not be tried at all. `force` skips
    // the response cache so the fetch ordering is what is under test.
    mockFetch.mockReset().mockResolvedValueOnce(okResponse('still fallback'));
    await expect(client.complete('prompt-1', 'research', { force: true })).resolves.toBe(
      'still fallback'
    );
    expect(fetchUrls()).toEqual(['https://p2.test/chat/completions']);
  });

  it('retries the recovered key first once the cooldown lapses, with no operator action', async () => {
    const now = { t: 1_000_000 };
    const { client } = makeClient(now);

    mockFetch
      .mockResolvedValueOnce(statusResponse(429))
      .mockResolvedValueOnce(okResponse('served by fallback'));
    await client.complete('prompt-1', 'research');

    now.t += 60_001;

    mockFetch.mockReset().mockResolvedValueOnce(okResponse('primary is back'));
    await expect(client.complete('prompt-1', 'research', { force: true })).resolves.toBe(
      'primary is back'
    );
    expect(fetchUrls()).toEqual(['https://p1.test/chat/completions']);
  });

  it('escalates the cooldown while the quota stays exhausted', async () => {
    const now = { t: 1_000_000 };
    const { client, store } = makeClient(now);

    mockFetch
      .mockResolvedValueOnce(statusResponse(429))
      .mockResolvedValueOnce(okResponse('fallback'));
    await client.complete('prompt-1', 'research');
    expect(store.snapshot()[0]!.cooldownUntil).toBe(now.t + 60_000);

    now.t += 60_001;
    mockFetch
      .mockResolvedValueOnce(statusResponse(429))
      .mockResolvedValueOnce(okResponse('fallback'));
    await client.complete('prompt-1', 'research', { force: true });
    expect(store.snapshot()[0]!.cooldownUntil).toBe(now.t + 120_000);
  });

  it('still attempts a request when every key is cooling down', async () => {
    const now = { t: 1_000_000 };
    const { client } = makeClient(now);

    mockFetch.mockResolvedValueOnce(statusResponse(429)).mockResolvedValueOnce(statusResponse(429));

    // A request we never send can never succeed, and sending it is also how
    // a recovered key is discovered — so all-cooling still goes to the wire,
    // earliest expiry first.
    await expect(client.complete('prompt', 'research')).rejects.toThrow();
    expect(fetchUrls()).toEqual([
      'https://p1.test/chat/completions',
      'https://p2.test/chat/completions',
    ]);
  });

  it('does not cool a key down for a 5xx — that is the service, not the key', async () => {
    const now = { t: 1_000_000 };
    const { client, store } = makeClient(now);

    mockFetch
      .mockResolvedValueOnce(statusResponse(503))
      .mockResolvedValueOnce(okResponse('fallback absorbed it'));
    await expect(client.complete('prompt', 'research')).resolves.toBe('fallback absorbed it');

    expect(store.snapshot()[0]).toMatchObject({
      state: 'degraded',
      cooldownUntil: null,
      quotaEvents: 0,
    });
  });

  it('reports rotation state through getKeyHealth() with keyIds only', async () => {
    const now = { t: 1_000_000 };
    const { client } = makeClient(now);

    mockFetch
      .mockResolvedValueOnce(statusResponse(429))
      .mockResolvedValueOnce(okResponse('fallback'));
    await client.complete('prompt', 'research');

    const health = client.getKeyHealth();
    expect(health).toHaveLength(2);
    expect(health[0]).toMatchObject({ id: 'primary', state: 'cooldown', quotaEvents: 1 });
    expect(health[0]!.keyId).toMatch(/^[0-9a-f]{16}$/);
    expect(health[1]).toMatchObject({ id: 'fallback', state: 'healthy', successes: 1 });
  });
});
