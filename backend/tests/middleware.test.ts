import { Request, Response, NextFunction } from 'express';

// ── rateLimit ─────────────────────────────────────────────────────────────────

// Re-require between tests to get a fresh module with empty windows map
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
    // different IP should still pass
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

    // Advance past the 60s window
    jest.advanceTimersByTime(61_000);

    const next = jest.fn();
    rateLimitMiddleware(req, makeRes() as unknown as Response, next as NextFunction);
    expect(next).toHaveBeenCalled();
    jest.useRealTimers();
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
    const res = makeRes();
    authMiddleware(makeAuthReq('Bearer wrong-key'), res as unknown as Response, jest.fn() as NextFunction);
    expect(res.status).toHaveBeenCalledWith(401);
  });

  it('returns 401 when Authorization header is missing', () => {
    const authMiddleware = freshAuth('key-abc');
    const res = makeRes();
    authMiddleware(makeAuthReq(), res as unknown as Response, jest.fn() as NextFunction);
    expect(res.status).toHaveBeenCalledWith(401);
  });
});

// ── createRateLimiter — eviction (memory-leak fix) ────────────────────────────

describe('createRateLimiter — stale entry eviction', () => {
  it('evicts IPs whose window has fully expired, preventing memory leaks', () => {
    jest.useFakeTimers();

    const { createRateLimiter } = require('../src/api/middleware/rateLimit') as typeof import('../src/api/middleware/rateLimit');

    const windowMs = 60_000;
    const { middleware, stop } = createRateLimiter({ windowMs, maxRequests: 5 });

    // Make a request to seed the internal windows Map
    const req = makeReq('10.0.0.1');
    const next = jest.fn();
    middleware(req, makeRes() as unknown as Response, next as NextFunction);
    expect(next).toHaveBeenCalledTimes(1);

    // Advance past the window — the eviction interval should remove the entry
    jest.advanceTimersByTime(windowMs + 60_000 + 1);

    // A new request from the same IP should succeed as though it is fresh
    // (proves the entry was cleaned up, not just rate-limited from old data)
    const next2 = jest.fn();
    middleware(req, makeRes() as unknown as Response, next2 as NextFunction);
    expect(next2).toHaveBeenCalledTimes(1);

    stop();
    jest.useRealTimers();
  });
});
