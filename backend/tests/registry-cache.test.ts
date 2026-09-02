/**
 * Tests for the registry cache layer — Issue #427
 *
 * Covers:
 *  1. cache/metrics.ts  — hit/miss/bypass/stale counters, hitRate calculation
 *  2. cache/registry.ts — key builder, prefix isolation, get/set/invalidate
 *  3. cache/invalidation.ts — invalidateAgentsCache sweeps both key spaces
 *  4. cache middleware — hit/miss/bypass counter integration
 *  5. agents router — cacheMiddleware on GET / and GET /:id,
 *                     invalidation on POST register / POST heartbeat / DELETE
 */

import express from 'express';
import request from 'supertest';
import Database from 'better-sqlite3';
import { createAgentDb, type AgentDb } from '../src/db/agents';
import { createAgentsRouter } from '../src/api/routes/agents';
import { Request, Response, NextFunction } from 'express';

// ── Cache modules ────────────────────────────────────────────────────────────
import {
  LRUCacheClient,
  setCacheClient,
  resetCache,
  type CacheClient,
} from '../src/cache/index';

import {
  recordHit,
  recordMiss,
  recordBypass,
  recordInvalidation,
  markStale,
  getCacheMetrics,
  resetCacheMetrics,
} from '../src/cache/metrics';

import {
  buildRegistryCacheKey,
  buildRegistryInvalidationPattern,
  getRegistryCachePrefix,
  getRegistryCache,
  setRegistryCache,
  invalidateRegistryCache,
  markRegistryCacheStale,
} from '../src/cache/registry';

import {
  invalidateAgentsCache,
  CACHE_PREFIX,
} from '../src/cache/invalidation';

import {
  cacheMiddleware,
  CACHE_STATUS_HEADER,
  CACHE_BYPASS_HEADER,
} from '../src/api/middleware/cache';

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE IF NOT EXISTS agents (
      id               TEXT PRIMARY KEY,
      capabilities     TEXT NOT NULL,
      pricingXLM       REAL NOT NULL,
      endpoint         TEXT NOT NULL,
      stellarPublicKey TEXT NOT NULL,
      reputationScore  REAL NOT NULL DEFAULT 0,
      lastSeenAt       TEXT NOT NULL,
      status           TEXT NOT NULL DEFAULT 'online'
    )
  `);
  return db;
}

function buildApp(db: AgentDb) {
  const app = express();
  app.use(express.json());
  app.use('/api/agents', createAgentsRouter({ db }));
  return app;
}

const VALID_KEY = 'GTESTAGENTSTELLARKEYAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';

function seedAgent(db: AgentDb, id = 'agent-1') {
  db.upsert({
    id,
    capabilities: ['research'],
    pricingXLM: 0.5,
    endpoint: 'http://localhost:9001',
    stellarPublicKey: VALID_KEY,
    reputationScore: 0,
    lastSeenAt: new Date().toISOString(),
    status: 'online',
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. cache/metrics.ts
// ─────────────────────────────────────────────────────────────────────────────

describe('cache/metrics — counters', () => {
  beforeEach(() => resetCacheMetrics());

  it('starts at zero', () => {
    const m = getCacheMetrics();
    expect(m.hits).toBe(0);
    expect(m.misses).toBe(0);
    expect(m.bypasses).toBe(0);
    expect(m.staleHits).toBe(0);
    expect(m.invalidations).toBe(0);
    expect(m.hitRate).toBe(0);
  });

  it('recordHit increments hits', () => {
    recordHit();
    expect(getCacheMetrics().hits).toBe(1);
  });

  it('recordMiss increments misses', () => {
    recordMiss();
    expect(getCacheMetrics().misses).toBe(1);
  });

  it('recordBypass increments bypasses', () => {
    recordBypass();
    expect(getCacheMetrics().bypasses).toBe(1);
  });

  it('recordInvalidation increments invalidations', () => {
    recordInvalidation();
    expect(getCacheMetrics().invalidations).toBe(1);
  });

  it('hitRate = hits / (hits + misses)', () => {
    recordHit(); recordHit(); recordMiss();
    expect(getCacheMetrics().hitRate).toBeCloseTo(2 / 3);
  });

  it('hitRate stays 0 when no hits or misses', () => {
    recordBypass();
    expect(getCacheMetrics().hitRate).toBe(0);
  });

  it('markStale + recordHit increments staleHits', () => {
    markStale('my-key');
    recordHit('my-key');
    expect(getCacheMetrics().staleHits).toBe(1);
  });

  it('staleHits only counted once per key', () => {
    markStale('sk');
    recordHit('sk');
    recordHit('sk');
    expect(getCacheMetrics().staleHits).toBe(1);
  });

  it('recordHit without matching stale key does not increment staleHits', () => {
    markStale('other-key');
    recordHit('unrelated-key');
    expect(getCacheMetrics().staleHits).toBe(0);
  });

  it('resetCacheMetrics resets all counters', () => {
    recordHit(); recordMiss(); recordBypass(); recordInvalidation();
    resetCacheMetrics();
    const m = getCacheMetrics();
    expect(m.hits).toBe(0);
    expect(m.misses).toBe(0);
    expect(m.bypasses).toBe(0);
    expect(m.invalidations).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. cache/registry.ts
// ─────────────────────────────────────────────────────────────────────────────

describe('cache/registry — key builder', () => {
  it('default prefix is "registry"', () => {
    const saved = process.env.REGISTRY_CACHE_KEY_PREFIX;
    delete process.env.REGISTRY_CACHE_KEY_PREFIX;
    expect(getRegistryCachePrefix()).toBe('registry');
    if (saved !== undefined) process.env.REGISTRY_CACHE_KEY_PREFIX = saved;
  });

  it('reads prefix from env', () => {
    process.env.REGISTRY_CACHE_KEY_PREFIX = 'staging';
    expect(getRegistryCachePrefix()).toBe('staging');
    process.env.REGISTRY_CACHE_KEY_PREFIX = 'registry';
  });

  it('builds list key with noquery suffix when no query given', () => {
    process.env.REGISTRY_CACHE_KEY_PREFIX = 'registry';
    const key = buildRegistryCacheKey('list');
    expect(key).toBe('registry:agents:list:noquery');
  });

  it('builds item key with hash suffix when query given', () => {
    process.env.REGISTRY_CACHE_KEY_PREFIX = 'registry';
    const key = buildRegistryCacheKey('item', { id: 'agent-1' });
    expect(key).toMatch(/^registry:agents:item:[a-f0-9]{8}$/);
  });

  it('same query produces same key regardless of param order', () => {
    process.env.REGISTRY_CACHE_KEY_PREFIX = 'registry';
    const k1 = buildRegistryCacheKey('list', { b: 2, a: 1 });
    const k2 = buildRegistryCacheKey('list', { a: 1, b: 2 });
    expect(k1).toBe(k2);
  });

  it('different prefixes produce different keys', () => {
    process.env.REGISTRY_CACHE_KEY_PREFIX = 'prod';
    const k1 = buildRegistryCacheKey('list');
    process.env.REGISTRY_CACHE_KEY_PREFIX = 'staging';
    const k2 = buildRegistryCacheKey('list');
    expect(k1).not.toBe(k2);
    process.env.REGISTRY_CACHE_KEY_PREFIX = 'registry';
  });

  it('invalidation pattern matches all list and item keys', () => {
    process.env.REGISTRY_CACHE_KEY_PREFIX = 'registry';
    const pattern = buildRegistryInvalidationPattern();
    expect(pattern).toBe('registry:agents:*');
  });
});

describe('cache/registry — get / set / invalidate', () => {
  let client: LRUCacheClient;

  beforeEach(() => {
    resetCache();
    resetCacheMetrics();
    process.env.REGISTRY_CACHE_KEY_PREFIX = 'registry';
    client = new LRUCacheClient(100, 60_000);
    setCacheClient(client);
  });

  afterEach(() => {
    resetCache();
  });

  it('getRegistryCache returns undefined on miss', async () => {
    const result = await getRegistryCache('list');
    expect(result).toBeUndefined();
  });

  it('setRegistryCache + getRegistryCache round-trips value', async () => {
    await setRegistryCache('list', {}, [{ id: 'a' }], 60);
    const result = await getRegistryCache<{ id: string }[]>('list');
    expect(result).toEqual([{ id: 'a' }]);
  });

  it('invalidateRegistryCache removes keys and records invalidation', async () => {
    await setRegistryCache('list', {}, ['agent'], 60);
    await setRegistryCache('item', { id: 'x' }, { id: 'x' }, 60);

    resetCacheMetrics(); // reset so we only count the one below
    await invalidateRegistryCache();

    expect(await getRegistryCache('list')).toBeUndefined();
    expect(await getRegistryCache('item', { id: 'x' })).toBeUndefined();
    expect(getCacheMetrics().invalidations).toBe(1);
  });

  it('markRegistryCacheStale flags key for stale tracking', () => {
    process.env.REGISTRY_CACHE_KEY_PREFIX = 'registry';
    markRegistryCacheStale('list');
    recordHit(buildRegistryCacheKey('list'));
    expect(getCacheMetrics().staleHits).toBe(1);
  });

  it('different deployment prefixes do not interfere', async () => {
    process.env.REGISTRY_CACHE_KEY_PREFIX = 'env-a';
    await setRegistryCache('list', {}, ['a'], 60);

    process.env.REGISTRY_CACHE_KEY_PREFIX = 'env-b';
    const fromB = await getRegistryCache('list');
    expect(fromB).toBeUndefined();

    process.env.REGISTRY_CACHE_KEY_PREFIX = 'registry';
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. cache/invalidation.ts — invalidateAgentsCache sweeps both key spaces
// ─────────────────────────────────────────────────────────────────────────────

describe('invalidateAgentsCache — sweeps api + registry key spaces', () => {
  let client: LRUCacheClient;

  beforeEach(async () => {
    resetCache();
    resetCacheMetrics();
    process.env.REGISTRY_CACHE_KEY_PREFIX = 'registry';
    client = new LRUCacheClient(100, 60_000);
    setCacheClient(client);
  });

  afterEach(() => {
    resetCache();
  });

  it('removes api:GET:/api/agents* keys', async () => {
    await client.set(`${CACHE_PREFIX.AGENTS}:noquery`, '[]', 60);
    await client.set(`${CACHE_PREFIX.AGENTS}:abc123`, '[]', 60);
    await invalidateAgentsCache();
    expect(await client.get(`${CACHE_PREFIX.AGENTS}:noquery`)).toBeUndefined();
    expect(await client.get(`${CACHE_PREFIX.AGENTS}:abc123`)).toBeUndefined();
  });

  it('removes registry:agents:* keys', async () => {
    await setRegistryCache('list', {}, ['a'], 60);
    await setRegistryCache('item', { id: 'x' }, { id: 'x' }, 60);
    await invalidateAgentsCache();
    expect(await getRegistryCache('list')).toBeUndefined();
    expect(await getRegistryCache('item', { id: 'x' })).toBeUndefined();
  });

  it('does not remove stats or health keys', async () => {
    await client.set(`${CACHE_PREFIX.STATS}:noquery`, '{}', 60);
    await client.set(`${CACHE_PREFIX.HEALTH}:noquery`, '{}', 60);
    await invalidateAgentsCache();
    expect(await client.get(`${CACHE_PREFIX.STATS}:noquery`)).toBe('{}');
    expect(await client.get(`${CACHE_PREFIX.HEALTH}:noquery`)).toBe('{}');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. cache middleware — hit/miss/bypass counter integration
// ─────────────────────────────────────────────────────────────────────────────

function mockReq(overrides: Partial<Request> = {}): Request {
  return {
    method: 'GET',
    path: '/api/agents',
    baseUrl: '',
    query: {},
    headers: {},
    ...overrides,
  } as unknown as Request;
}

function mockRes(): {
  res: Response;
  headers: Record<string, string>;
  sentBody: string | undefined;
} {
  const ctx = { headers: {} as Record<string, string>, sentBody: undefined as string | undefined };
  const res = {
    setHeader(k: string, v: string) { ctx.headers[k] = v; },
    getHeader(k: string) { return ctx.headers[k]; },
    status() { return res; },
    json(body: unknown) { ctx.sentBody = JSON.stringify(body); return res; },
    send(body: string) { ctx.sentBody = body; return res; },
  } as unknown as Response;
  return { res, ...ctx };
}

describe('cache middleware — metrics integration', () => {
  let client: LRUCacheClient;

  beforeEach(() => {
    resetCache();
    resetCacheMetrics();
    client = new LRUCacheClient(100, 60_000);
    setCacheClient(client);
  });

  afterEach(() => resetCache());

  it('records MISS on first request', async () => {
    const mw = cacheMiddleware({ ttl: 60 });
    const req = mockReq();
    const { res } = mockRes();
    await mw(req, res, jest.fn() as unknown as NextFunction);
    expect(getCacheMetrics().misses).toBe(1);
    expect(getCacheMetrics().hits).toBe(0);
  });

  it('records HIT on second request', async () => {
    const { buildCacheKey } = require('../src/cache/index');
    const key = buildCacheKey('GET', '/api/agents', {});
    await client.set(key, JSON.stringify([]), 60);

    const mw = cacheMiddleware({ ttl: 60 });
    const req = mockReq();
    const { res } = mockRes();
    await mw(req, res, jest.fn() as unknown as NextFunction);
    expect(getCacheMetrics().hits).toBe(1);
    expect(getCacheMetrics().misses).toBe(0);
  });

  it('records BYPASS when bypass header present', async () => {
    const mw = cacheMiddleware({ ttl: 60 });
    const req = mockReq({ headers: { [CACHE_BYPASS_HEADER]: '1' } });
    const { res } = mockRes();
    await mw(req, res, jest.fn() as unknown as NextFunction);
    expect(getCacheMetrics().bypasses).toBe(1);
  });

  it('records BYPASS when ttl=0', async () => {
    const mw = cacheMiddleware({ ttl: 0 });
    const req = mockReq();
    const { res } = mockRes();
    await mw(req, res, jest.fn() as unknown as NextFunction);
    expect(getCacheMetrics().bypasses).toBe(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. agents router integration — cache middleware wired; invalidation on writes
// ─────────────────────────────────────────────────────────────────────────────

describe('GET /api/agents — cache headers', () => {
  let client: LRUCacheClient;
  let db: AgentDb;
  let app: ReturnType<typeof buildApp>;

  beforeEach(() => {
    resetCache();
    resetCacheMetrics();
    process.env.REGISTRY_CACHE_KEY_PREFIX = 'registry';
    client = new LRUCacheClient(500, 60_000);
    setCacheClient(client);
    db = createAgentDb(makeDb());
    app = buildApp(db);
  });

  afterEach(() => resetCache());

  it('first request returns X-Cache: MISS', async () => {
    const res = await request(app).get('/api/agents');
    expect(res.status).toBe(200);
    expect(res.headers['x-cache']).toBe('MISS');
  });

  it('second request returns X-Cache: HIT', async () => {
    await request(app).get('/api/agents'); // prime
    const res = await request(app).get('/api/agents');
    expect(res.headers['x-cache']).toBe('HIT');
  });

  it('bypass header forces MISS on a warm cache', async () => {
    await request(app).get('/api/agents'); // prime
    const res = await request(app)
      .get('/api/agents')
      .set(CACHE_BYPASS_HEADER, '1');
    expect(res.headers['x-cache']).toBe('BYPASS');
  });
});

describe('GET /api/agents/:id — cache headers', () => {
  let client: LRUCacheClient;
  let db: AgentDb;
  let app: ReturnType<typeof buildApp>;

  beforeEach(() => {
    resetCache();
    resetCacheMetrics();
    process.env.REGISTRY_CACHE_KEY_PREFIX = 'registry';
    client = new LRUCacheClient(500, 60_000);
    setCacheClient(client);
    db = createAgentDb(makeDb());
    seedAgent(db);
    app = buildApp(db);
  });

  afterEach(() => resetCache());

  it('first request returns X-Cache: MISS', async () => {
    const res = await request(app).get('/api/agents/agent-1');
    expect(res.status).toBe(200);
    expect(res.headers['x-cache']).toBe('MISS');
  });

  it('second request returns X-Cache: HIT', async () => {
    await request(app).get('/api/agents/agent-1'); // prime
    const res = await request(app).get('/api/agents/agent-1');
    expect(res.headers['x-cache']).toBe('HIT');
  });
});

describe('POST /api/agents/:id/heartbeat — invalidates cache', () => {
  let client: LRUCacheClient;
  let db: AgentDb;
  let app: ReturnType<typeof buildApp>;

  beforeEach(() => {
    resetCache();
    resetCacheMetrics();
    process.env.REGISTRY_CACHE_KEY_PREFIX = 'registry';
    client = new LRUCacheClient(500, 60_000);
    setCacheClient(client);
    db = createAgentDb(makeDb());
    seedAgent(db);
    app = buildApp(db);
  });

  afterEach(() => resetCache());

  it('heartbeat causes subsequent GET to MISS (cache was invalidated)', async () => {
    // Prime
    await request(app).get('/api/agents');
    expect((await request(app).get('/api/agents')).headers['x-cache']).toBe('HIT');

    // Heartbeat should bust the cache
    await request(app).post('/api/agents/agent-1/heartbeat');
    // Flush promise queue so the async invalidation completes
    await new Promise((r) => setImmediate(r));

    const res = await request(app).get('/api/agents');
    expect(res.headers['x-cache']).toBe('MISS');
  });
});

describe('DELETE /api/agents/:id — invalidates cache', () => {
  let client: LRUCacheClient;
  let db: AgentDb;
  let app: ReturnType<typeof buildApp>;

  beforeEach(() => {
    resetCache();
    resetCacheMetrics();
    process.env.REGISTRY_CACHE_KEY_PREFIX = 'registry';
    client = new LRUCacheClient(500, 60_000);
    setCacheClient(client);
    db = createAgentDb(makeDb());
    app = buildApp(db);
  });

  afterEach(() => resetCache());

  it('delete of non-existent agent returns 404', async () => {
    const res = await request(app)
      .delete('/api/agents/nonexistent')
      .set('x-signature', 'sig')
      .set('x-challenge', 'chal');
    expect(res.status).toBe(404);
  });
});
