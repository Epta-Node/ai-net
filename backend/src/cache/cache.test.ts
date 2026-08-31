/**
 * Unit tests for the cache layer — Issue #263
 *
 * Covers:
 *  - LRUCacheClient: get, set, del, delByPattern, flush, size
 *  - buildCacheKey: deterministic key generation, query param ordering
 *  - Cache middleware: HIT path, MISS path, bypass header, TTL=0 passthrough
 *  - Cache invalidation helpers: invalidateAgentsCache, invalidateStatsCache,
 *    invalidateOnAgentRegistration, flushAllCaches
 *  - TTL expiry: item not served after TTL elapses (mocked timers)
 *  - initCache / setCacheClient / resetCache lifecycle
 */

import { Request, Response, NextFunction } from 'express';

// Pull in everything before mocking so we get real implementations
import {
  LRUCacheClient,
  buildCacheKey,
  initCache,
  setCacheClient,
  resetCache,
  getCacheClient,
  type CacheClient,
} from './index';

import {
  invalidateAgentsCache,
  invalidateStatsCache,
  invalidateOnAgentRegistration,
  invalidateOnTaskMutation,
  flushAllCaches,
  CACHE_PREFIX,
} from './invalidation';

import {
  cacheMiddleware,
  CACHE_BYPASS_HEADER,
  CACHE_STATUS_HEADER,
} from '../api/middleware/cache';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/** Advance fake timers and let microtasks settle */
const tick = () => new Promise((r) => setImmediate(r));

function mockReq(overrides: Partial<Request> = {}): Request {
  return {
    method: 'GET',
    path: '/api/agents',
    query: {},
    headers: {},
    ...overrides,
  } as unknown as Request;
}

function mockRes(): {
  res: Response;
  sentJson: unknown;
  status: number;
  headers: Record<string, string>;
} {
  const ctx: { sentJson: unknown; status: number; headers: Record<string, string> } = {
    sentJson: undefined,
    status: 200,
    headers: {},
  };
  const res = {
    setHeader(k: string, v: string) {
      ctx.headers[k] = v;
    },
    getHeader(k: string) {
      return ctx.headers[k];
    },
    status(code: number) {
      ctx.status = code;
      return res;
    },
    json(body: unknown) {
      ctx.sentJson = body;
      return res;
    },
    send(body: unknown) {
      ctx.sentJson = body;
      return res;
    },
  } as unknown as Response;
  return { res, ...ctx };
}

// ---------------------------------------------------------------------------
// 1. LRUCacheClient
// ---------------------------------------------------------------------------

describe('LRUCacheClient', () => {
  let client: LRUCacheClient;

  beforeEach(() => {
    client = new LRUCacheClient(100, 60_000);
  });

  it('returns undefined for a missing key', async () => {
    expect(await client.get('missing')).toBeUndefined();
  });

  it('stores and retrieves a value', async () => {
    await client.set('key1', 'value1');
    expect(await client.get('key1')).toBe('value1');
  });

  it('del removes a key', async () => {
    await client.set('key2', 'value2');
    await client.del('key2');
    expect(await client.get('key2')).toBeUndefined();
  });

  it('delByPattern removes matching keys only', async () => {
    await client.set('api:GET:/api/agents:noquery', 'a1');
    await client.set('api:GET:/api/agents:abc123', 'a2');
    await client.set('api:GET:/api/stats:noquery', 'stats');

    await client.delByPattern('api:GET:/api/agents*');

    expect(await client.get('api:GET:/api/agents:noquery')).toBeUndefined();
    expect(await client.get('api:GET:/api/agents:abc123')).toBeUndefined();
    // stats key must survive
    expect(await client.get('api:GET:/api/stats:noquery')).toBe('stats');
  });

  it('delByPattern with no matches is a no-op', async () => {
    await client.set('api:GET:/api/health:noquery', 'h');
    await client.delByPattern('api:GET:/api/nonexistent*');
    expect(await client.get('api:GET:/api/health:noquery')).toBe('h');
  });

  it('flush wipes all entries', async () => {
    await client.set('k1', 'v1');
    await client.set('k2', 'v2');
    await client.flush();
    expect(await client.size()).toBe(0);
    expect(await client.get('k1')).toBeUndefined();
  });

  it('size reflects current entry count', async () => {
    expect(await client.size()).toBe(0);
    await client.set('x', 'y');
    expect(await client.size()).toBe(1);
    await client.set('x2', 'y2');
    expect(await client.size()).toBe(2);
  });

  it('per-item TTL expires the entry', async () => {
    jest.useFakeTimers();
    const c = new LRUCacheClient(100, 1_000); // default 1s TTL
    await c.set('expiring', 'data', 0.001); // 1ms TTL
    jest.advanceTimersByTime(100);
    expect(await c.get('expiring')).toBeUndefined();
    jest.useRealTimers();
  });

  it('respects max size by evicting LRU entry', async () => {
    const small = new LRUCacheClient(2, 60_000);
    await small.set('a', '1');
    await small.set('b', '2');
    // Access 'a' to make it recently-used
    await small.get('a');
    // Add third entry — 'b' should be evicted (LRU)
    await small.set('c', '3');
    expect(await small.get('a')).toBe('1');
    expect(await small.get('c')).toBe('3');
    expect(await small.get('b')).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 2. buildCacheKey
// ---------------------------------------------------------------------------

describe('buildCacheKey', () => {
  it('produces the expected pattern', () => {
    const key = buildCacheKey('GET', '/api/agents', {});
    expect(key).toMatch(/^api:GET:\/api\/agents:noquery$/);
  });

  it('hashes query params into the key', () => {
    const key = buildCacheKey('GET', '/api/stats', { page: 1, size: 10 });
    expect(key).toMatch(/^api:GET:\/api\/stats:[a-f0-9]{8}$/);
  });

  it('produces the same key regardless of param order', () => {
    const k1 = buildCacheKey('GET', '/api/agents', { b: 2, a: 1 });
    const k2 = buildCacheKey('GET', '/api/agents', { a: 1, b: 2 });
    expect(k1).toBe(k2);
  });

  it('produces different keys for different paths', () => {
    const k1 = buildCacheKey('GET', '/api/agents', {});
    const k2 = buildCacheKey('GET', '/api/stats', {});
    expect(k1).not.toBe(k2);
  });

  it('produces different keys for different query values', () => {
    const k1 = buildCacheKey('GET', '/api/agents', { capability: 'research' });
    const k2 = buildCacheKey('GET', '/api/agents', { capability: 'risk' });
    expect(k1).not.toBe(k2);
  });

  it('upper-cases the HTTP method', () => {
    const k1 = buildCacheKey('get', '/api/agents', {});
    const k2 = buildCacheKey('GET', '/api/agents', {});
    expect(k1).toBe(k2);
  });
});

// ---------------------------------------------------------------------------
// 3. initCache / getCacheClient lifecycle
// ---------------------------------------------------------------------------

describe('initCache / getCacheClient lifecycle', () => {
  afterEach(() => {
    resetCache();
  });

  it('getCacheClient throws before initCache', () => {
    expect(() => getCacheClient()).toThrow('[cache] Cache not initialised');
  });

  it('initCache with lru driver returns LRUCacheClient', () => {
    const client = initCache({ driver: 'lru' });
    expect(client).toBeInstanceOf(LRUCacheClient);
  });

  it('getCacheClient returns the same instance after init', () => {
    initCache({ driver: 'lru' });
    expect(getCacheClient()).toBe(getCacheClient());
  });

  it('setCacheClient overrides the singleton', () => {
    const mock: CacheClient = {
      get: jest.fn(),
      set: jest.fn(),
      del: jest.fn(),
      delByPattern: jest.fn(),
      flush: jest.fn(),
      size: jest.fn(),
    };
    initCache({ driver: 'lru' });
    setCacheClient(mock);
    expect(getCacheClient()).toBe(mock);
  });
});

// ---------------------------------------------------------------------------
// 4. cacheMiddleware
// ---------------------------------------------------------------------------

describe('cacheMiddleware', () => {
  let client: CacheClient;

  beforeEach(() => {
    resetCache();
    client = new LRUCacheClient(100, 60_000);
    setCacheClient(client);
  });

  afterEach(() => {
    resetCache();
  });

  // ── MISS then HIT ────────────────────────────────────────────────────────

  it('sets X-Cache: MISS on first request and stores response', async () => {
    const middleware = cacheMiddleware({ ttl: 60 });
    const req = mockReq();
    const { res, headers } = mockRes();
    const next = jest.fn();

    await middleware(req, res, next as unknown as NextFunction);

    expect(next).toHaveBeenCalled();
    expect(headers[CACHE_STATUS_HEADER]).toBe('MISS');

    // Simulate handler calling res.json
    res.json({ agents: [] });
    await tick();

    // Second request — should HIT
    const req2 = mockReq();
    const { res: res2, headers: headers2, sentJson: sent2 } = mockRes();
    const next2 = jest.fn();

    await middleware(req2, res2, next2 as unknown as NextFunction);

    expect(next2).not.toHaveBeenCalled();
    expect(headers2[CACHE_STATUS_HEADER]).toBe('HIT');
    expect(sent2).toBeUndefined(); // send() not called yet — res.send called directly
  });

  it('returns cached JSON on HIT', async () => {
    const key = buildCacheKey('GET', '/api/agents', {});
    await client.set(key, JSON.stringify({ cached: true }), 60);

    const middleware = cacheMiddleware({ ttl: 60 });
    const req = mockReq();
    const { res, headers } = mockRes();
    let sentBody: string | undefined;
    (res as unknown as { send: (b: string) => void }).send = (b) => {
      sentBody = b;
    };
    const next = jest.fn();

    await middleware(req, res, next as unknown as NextFunction);

    expect(headers[CACHE_STATUS_HEADER]).toBe('HIT');
    expect(next).not.toHaveBeenCalled();
    expect(sentBody).toBe(JSON.stringify({ cached: true }));
  });

  // ── Bypass header ────────────────────────────────────────────────────────

  it('bypasses cache when X-Cache-Bypass header is present', async () => {
    const key = buildCacheKey('GET', '/api/agents', {});
    await client.set(key, JSON.stringify({ stale: true }), 60);

    const middleware = cacheMiddleware({ ttl: 60 });
    const req = mockReq({ headers: { [CACHE_BYPASS_HEADER]: '1' } });
    const { res, headers } = mockRes();
    const next = jest.fn();

    await middleware(req, res, next as unknown as NextFunction);

    expect(headers[CACHE_STATUS_HEADER]).toBe('BYPASS');
    expect(next).toHaveBeenCalled();
  });

  // ── TTL = 0 passthrough ──────────────────────────────────────────────────

  it('is a passthrough when ttl=0', async () => {
    const middleware = cacheMiddleware({ ttl: 0 });
    const req = mockReq();
    const { res, headers } = mockRes();
    const next = jest.fn();

    await middleware(req, res, next as unknown as NextFunction);

    expect(headers[CACHE_STATUS_HEADER]).toBe('BYPASS');
    expect(next).toHaveBeenCalled();
  });

  // ── Cache error resilience ────────────────────────────────────────────────

  it('falls through to next() when cache.get throws', async () => {
    const brokenClient: CacheClient = {
      get: jest.fn().mockRejectedValue(new Error('redis down')),
      set: jest.fn().mockResolvedValue(undefined),
      del: jest.fn(),
      delByPattern: jest.fn(),
      flush: jest.fn(),
      size: jest.fn(),
    };
    setCacheClient(brokenClient);

    const middleware = cacheMiddleware({ ttl: 60 });
    const req = mockReq();
    const { res } = mockRes();
    const next = jest.fn();

    await middleware(req, res, next as unknown as NextFunction);

    expect(next).toHaveBeenCalled();
  });

  // ── keyExtra ─────────────────────────────────────────────────────────────

  it('incorporates keyExtra into the cache key', async () => {
    const spy = jest.spyOn(client, 'get');

    const middleware = cacheMiddleware({
      ttl: 60,
      keyExtra: (req) => (req.headers['x-wallet'] as string) ?? '',
    });
    const req = mockReq({ headers: { 'x-wallet': 'GABC123' } });
    const { res } = mockRes();
    const next = jest.fn();

    await middleware(req, res, next as unknown as NextFunction);

    const calledKey = (spy.mock.calls[0] as [string])[0];
    expect(calledKey).toContain('GABC123');
  });
});

// ---------------------------------------------------------------------------
// 5. Cache invalidation
// ---------------------------------------------------------------------------

describe('Cache invalidation', () => {
  let client: LRUCacheClient;

  beforeEach(() => {
    resetCache();
    client = new LRUCacheClient(100, 60_000);
    setCacheClient(client);
  });

  afterEach(() => {
    resetCache();
  });

  async function seedKeys() {
    await client.set(`${CACHE_PREFIX.AGENTS}:noquery`, '[]');
    await client.set(`${CACHE_PREFIX.AGENTS}:abc123`, '[]');
    await client.set(`${CACHE_PREFIX.STATS}:noquery`, '{}');
    await client.set(`${CACHE_PREFIX.HEALTH}:noquery`, '{}');
  }

  it('invalidateAgentsCache removes all agent keys', async () => {
    await seedKeys();
    await invalidateAgentsCache();

    expect(await client.get(`${CACHE_PREFIX.AGENTS}:noquery`)).toBeUndefined();
    expect(await client.get(`${CACHE_PREFIX.AGENTS}:abc123`)).toBeUndefined();
    // Stats and health must survive
    expect(await client.get(`${CACHE_PREFIX.STATS}:noquery`)).toBe('{}');
    expect(await client.get(`${CACHE_PREFIX.HEALTH}:noquery`)).toBe('{}');
  });

  it('invalidateStatsCache removes only stats keys', async () => {
    await seedKeys();
    await invalidateStatsCache();

    expect(await client.get(`${CACHE_PREFIX.STATS}:noquery`)).toBeUndefined();
    expect(await client.get(`${CACHE_PREFIX.AGENTS}:noquery`)).toBe('[]');
    expect(await client.get(`${CACHE_PREFIX.HEALTH}:noquery`)).toBe('{}');
  });

  it('invalidateOnAgentRegistration busts agents + stats', async () => {
    await seedKeys();
    await invalidateOnAgentRegistration();

    expect(await client.get(`${CACHE_PREFIX.AGENTS}:noquery`)).toBeUndefined();
    expect(await client.get(`${CACHE_PREFIX.STATS}:noquery`)).toBeUndefined();
    // Health survives
    expect(await client.get(`${CACHE_PREFIX.HEALTH}:noquery`)).toBe('{}');
  });

  it('invalidateOnTaskMutation busts only stats', async () => {
    await seedKeys();
    await invalidateOnTaskMutation();

    expect(await client.get(`${CACHE_PREFIX.STATS}:noquery`)).toBeUndefined();
    expect(await client.get(`${CACHE_PREFIX.AGENTS}:noquery`)).toBe('[]');
  });

  it('flushAllCaches wipes everything', async () => {
    await seedKeys();
    await flushAllCaches();

    expect(await client.size()).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 6. TTL expiry (fake timers)
// ---------------------------------------------------------------------------

describe('TTL expiry', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  it('item is unavailable after its TTL elapses', async () => {
    jest.useFakeTimers();
    // 10ms TTL
    const c = new LRUCacheClient(100, 10);
    await c.set('ttl-test', 'value', 0.01); // 10ms
    expect(await c.get('ttl-test')).toBe('value');
    jest.advanceTimersByTime(50);
    expect(await c.get('ttl-test')).toBeUndefined();
  });

  it('item with longer TTL survives a shorter elapsed time', async () => {
    jest.useFakeTimers();
    const c = new LRUCacheClient(100, 1_000);
    await c.set('long-lived', 'still-here', 1); // 1s
    jest.advanceTimersByTime(500); // only 0.5s passed
    expect(await c.get('long-lived')).toBe('still-here');
  });
});
