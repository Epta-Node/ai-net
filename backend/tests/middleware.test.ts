import { Request, Response, NextFunction } from 'express';
import { createRateLimiter } from '../src/api/middleware/rateLimit';

// ── rateLimit ─────────────────────────────────────────────────────────────────

function freshRateLimit() {
  jest.resetModules();
  return require('../src/api/middleware/rateLimit').rateLimitMiddleware as typeof import('../src/api/middleware/rateLimit').rateLimitMiddleware;
}

function makeReq(ip = '127.0.0.1'): Request {
  return { ip } as unknown as Request;
}

function makeRes(): { status: jest.Mock; json: jest.Mock; setHeader: jest.Mock; _status?: number } {
  const res: ReturnType<typeof makeRes> = {
    status: jest.fn().mockReturnThis(),
    json: jest.fn().mockReturnThis(),
    setHeader: jest.fn(),
  };
  return res;
}

describe('rateLimitMiddleware', () => {
  it('allows first 20 requests', () => {
    const rateLimitMiddleware = freshRateLimit();
    const req = makeReq();
    for (let i = 0; i < 20; i++) {
      const next = jest.fn();
      rateLimitMiddleware(req, makeRes() as unknown as Response, next as NextFunction);
      expect(next).toHaveBeenCalled();
    }
  });

  it('blocks the 21st request with 429 and Retry-After header', () => {
    const rateLimitMiddleware = freshRateLimit();
    const req = makeReq();
    const next = jest.fn();
    for (let i = 0; i < 20; i++) {
      rateLimitMiddleware(req, makeRes() as unknown as Response, next as NextFunction);
    }
    const res = makeRes();
    rateLimitMiddleware(req, res as unknown as Response, jest.fn() as NextFunction);
    expect(res.status).toHaveBeenCalledWith(429);
    expect(res.setHeader).toHaveBeenCalledWith('Retry-After', expect.any(String));
  });

  it('does not rate-limit a different IP', () => {
    const rateLimitMiddleware = freshRateLimit();
    const next = jest.fn();
    for (let i = 0; i < 20; i++) {
      rateLimitMiddleware(makeReq('1.2.3.4'), makeRes() as unknown as Response, next as NextFunction);
    }
    const next2 = jest.fn();
    rateLimitMiddleware(makeReq('5.6.7.8'), makeRes() as unknown as Response, next2 as NextFunction);
    expect(next2).toHaveBeenCalled();
  });

  it('allows requests again after window expires', () => {
    jest.useFakeTimers();
    const rateLimitMiddleware = freshRateLimit();
    const req = makeReq('10.0.0.1');

    for (let i = 0; i < 20; i++) {
      rateLimitMiddleware(req, makeRes() as unknown as Response, jest.fn() as NextFunction);
    }

    jest.advanceTimersByTime(61_000);

    const next = jest.fn();
    rateLimitMiddleware(req, makeRes() as unknown as Response, next as NextFunction);
    expect(next).toHaveBeenCalled();
    jest.useRealTimers();
  });

  it('re-issues a fresh window for an IP whose entry has aged out', () => {
    jest.useFakeTimers();
    const limiter = createRateLimiter({ windowMs: 60_000, maxRequests: 5 });

    // 100 unique IPs each make one request inside the window.
    for (let i = 0; i < 100; i++) {
      const next = jest.fn();
      limiter.middleware(makeReq(`192.168.1.${i}`), makeRes() as unknown as Response, next as NextFunction);
      expect(next).toHaveBeenCalled();
    }
    expect(limiter.size()).toBe(100);

    // Advance past the 60s window so all entries become stale. lru-cache
    // evicts lazily on next access; the next request should produce a
    // fresh, empty window and so succeed.
    jest.advanceTimersByTime(70_000);

    const next = jest.fn();
    limiter.middleware(makeReq('192.168.1.0'), makeRes() as unknown as Response, next as NextFunction);
    expect(next).toHaveBeenCalled();

    limiter.stop();
    jest.useRealTimers();
  });

  it('keeps the window map bounded under IP flood (issue #154)', () => {
    const limiter = createRateLimiter({
      windowMs: 60_000,
      maxRequests: 100,
      maxEntries: 10_000,
    });

    // 25 000 unique IPs each make one request. Without `max`/LRU eviction
    // this would balloon the map to 25 000 entries and OOM in production.
    for (let i = 0; i < 25_000; i++) {
      const next = jest.fn();
      limiter.middleware(
        makeReq(`10.0.${Math.floor(i / 256)}.${i % 256}`),
        makeRes() as unknown as Response,
        next as NextFunction,
      );
      expect(next).toHaveBeenCalled();
    }

    // The LRU must have evicted older entries; total size MUST stay <= max.
    expect(limiter.size()).toBeLessThanOrEqual(10_000);
    // And MUST be much smaller than what was inserted (proves LRU actually evicted).
    expect(limiter.size()).toBeLessThan(25_000);
    // Sanity: size stays exactly at max once we exceed it.
    expect(limiter.size()).toBe(10_000);

    limiter.stop();
  });

  it('evicts the least-recently-used IP first when maxEntries is exceeded', () => {
    const limiter = createRateLimiter({
      windowMs: 60_000,
      maxRequests: 1,
      maxEntries: 3,
    });

    limiter.middleware(makeReq('1.1.1.1'), makeRes() as unknown as Response, jest.fn() as NextFunction);
    limiter.middleware(makeReq('2.2.2.2'), makeRes() as unknown as Response, jest.fn() as NextFunction);
    limiter.middleware(makeReq('3.3.3.3'), makeRes() as unknown as Response, jest.fn() as NextFunction);
    expect(limiter.size()).toBe(3);

    // Touching 1.1.1.1 refreshes its LRU recency (lru-cache v10 moves the
    // entry to MRU on get regardless of `updateAgeOnGet`). Note: this still
    // hits a 429 because the entry already has a timestamp and maxRequests=1,
    // but the LRU position is correctly updated to MRU.
    limiter.middleware(makeReq('1.1.1.1'), makeRes() as unknown as Response, jest.fn() as NextFunction);

    // New 4th IP should evict '2.2.2.2' (the oldest untouched), not '1.1.1.1'.
    limiter.middleware(makeReq('4.4.4.4'), makeRes() as unknown as Response, jest.fn() as NextFunction);
    expect(limiter.size()).toBe(3);

    // 1.1.1.1 must still be tracked: hitting it again must produce an immediate
    // 429 because we already pushed a timestamp for it (maxRequests = 1) before
    // the LRU refresh. This is the real proof of LRU policy — '1' was kept,
    // '2' was thrown out.
    const res1 = makeRes();
    limiter.middleware(makeReq('1.1.1.1'), res1 as unknown as Response, jest.fn() as NextFunction);
    expect(res1.status).toHaveBeenCalledWith(429);

    // 2.2.2.2 was evicted, so its next request should be allowed with a
    // fresh, empty window.
    const res = makeRes();
    const next = jest.fn();
    limiter.middleware(makeReq('2.2.2.2'), res as unknown as Response, next as NextFunction);
    expect(next).toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalledWith(429);

    limiter.stop();
  });
});

// ── authMiddleware ────────────────────────────────────────────────────────────

function freshAuth(apiKeys?: string) {
  jest.resetModules();
  if (apiKeys !== undefined) {
    process.env.API_KEYS = apiKeys;
  } else {
    delete process.env.API_KEYS;
  }
  return require('../src/api/middleware/auth').authMiddleware as typeof import('../src/api/middleware/auth').authMiddleware;
}

function makeAuthReq(authHeader?: string): Request {
  return {
    headers: authHeader ? { authorization: authHeader } : {},
  } as unknown as Request;
}

afterEach(() => {
  delete process.env.API_KEYS;
  jest.resetModules();
});

describe('authMiddleware', () => {
  it('passes all requests when API_KEYS is unset', () => {
    const authMiddleware = freshAuth(undefined);
    const next = jest.fn();
    authMiddleware(makeAuthReq(), makeRes() as unknown as Response, next as NextFunction);
    expect(next).toHaveBeenCalled();
  });

  it('passes request with valid API key', () => {
    const authMiddleware = freshAuth('key-abc,key-xyz');
    const next = jest.fn();
    authMiddleware(makeAuthReq('Bearer key-abc'), makeRes() as unknown as Response, next as NextFunction);
    expect(next).toHaveBeenCalled();
  });

  it('returns 401 for invalid API key', () => {
    const authMiddleware = freshAuth('key-abc');
    const next = jest.fn();
    authMiddleware(makeAuthReq('Bearer wrong-key'), makeRes() as unknown as Response, next as NextFunction);
    expect(next).toHaveBeenCalledWith(expect.any(Error));
    expect((next.mock.calls[0][0] as any).statusCode).toBe(401);
  });

  it('returns 401 when Authorization header is missing', () => {
    const authMiddleware = freshAuth('key-abc');
    const next = jest.fn();
    authMiddleware(makeAuthReq(), makeRes() as unknown as Response, next as NextFunction);
    expect(next).toHaveBeenCalledWith(expect.any(Error));
    expect((next.mock.calls[0][0] as any).statusCode).toBe(401);
  });
});
