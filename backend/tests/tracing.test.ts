/**
 * Unit tests for the distributed tracing service and correlation ID middleware.
 *
 * Tests cover:
 *  - TracingService span lifecycle (start, end, getTrace)
 *  - Correlation ID propagation via the requestId middleware
 *  - GET /health/traces/:correlationId endpoint
 */

import { TracingService } from '../src/services/tracing';
import type { Request, Response, NextFunction } from 'express';
// ── Helpers ───────────────────────────────────────────────────────────────────

function makeService() {
  return new TracingService();
}

/** Minimal mock that satisfies Express Request typing for middleware tests. */
function makeReq(overrides: Partial<{ headers: Record<string, string>; method: string; path: string }> = {}): Request {
  return {
    headers: {},
    method: 'GET',
    path: '/test',
    ...overrides,
  } as unknown as Request;
}

/** Minimal mock Response with setHeader + on('finish') support. */
function makeRes(locals: Record<string, unknown> = {}): {
  res: Response;
  locals: Record<string, unknown>;
  headers: Record<string, string>;
  statusCode: number;
  triggerFinish: () => void;
} {
  const finishHandlers: Array<() => void> = [];
  const headers: Record<string, string> = {};
  const obj = {
    locals,
    statusCode: 200,
    headers,
    setHeader(name: string, value: string) {
      headers[name] = value;
    },
    on(event: string, handler: () => void) {
      if (event === 'finish') finishHandlers.push(handler);
    },
  };
  return {
    res: obj as unknown as Response,
    locals,
    headers,
    statusCode: 200,
    triggerFinish: () => finishHandlers.forEach((h) => h()),
  };
}

// ── TracingService tests ──────────────────────────────────────────────────────

describe('TracingService', () => {
  it('startSpan creates a span with correct fields', () => {
    const svc = makeService();
    const span = svc.startSpan('corr-1', 'backend', 'http_request', { method: 'GET' });

    expect(span.spanId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
    );
    expect(span.correlationId).toBe('corr-1');
    expect(span.service).toBe('backend');
    expect(span.operation).toBe('http_request');
    expect(span.status).toBe('running');
    expect(span.startedAt).toBeTruthy();
    expect(new Date(span.startedAt).getTime()).not.toBeNaN();
    expect(span.endedAt).toBeUndefined();
    expect(span.durationMs).toBeUndefined();
    expect(span.metadata).toEqual({ method: 'GET' });
  });

  it('startSpan with no metadata omits the metadata field', () => {
    const svc = makeService();
    const span = svc.startSpan('corr-x', 'coordinator', 'executeDAG');
    expect(span.metadata).toBeUndefined();
  });

  it('endSpan updates status, endedAt, and durationMs', () => {
    const svc = makeService();
    const span = svc.startSpan('corr-2', 'payment', 'lock');

    svc.endSpan(span.spanId, 'completed', { txHash: 'abc123' });

    const trace = svc.getTrace('corr-2')!;
    const updated = trace.spans[0];

    expect(updated.status).toBe('completed');
    expect(updated.endedAt).toBeTruthy();
    expect(typeof updated.durationMs).toBe('number');
    expect(updated.durationMs).toBeGreaterThanOrEqual(0);
    expect(updated.metadata).toMatchObject({ txHash: 'abc123' });
  });

  it('endSpan with failed status records failure', () => {
    const svc = makeService();
    const span = svc.startSpan('corr-f', 'coordinator', 'node_execution');
    svc.endSpan(span.spanId, 'failed', { error: 'timeout' });

    const trace = svc.getTrace('corr-f')!;
    expect(trace.spans[0].status).toBe('failed');
  });

  it('endSpan on unknown spanId is a no-op', () => {
    const svc = makeService();
    expect(() => svc.endSpan('no-such-span', 'completed')).not.toThrow();
  });

  it('getTrace returns all spans for a correlationId', () => {
    const svc = makeService();
    const s1 = svc.startSpan('corr-3', 'backend', 'http_request');
    const s2 = svc.startSpan('corr-3', 'coordinator', 'executeDAG');

    const trace = svc.getTrace('corr-3')!;
    expect(trace).toBeDefined();
    expect(trace.correlationId).toBe('corr-3');
    expect(trace.spans).toHaveLength(2);
    expect(trace.spans.map((s) => s.spanId)).toContain(s1.spanId);
    expect(trace.spans.map((s) => s.spanId)).toContain(s2.spanId);
  });

  it('getTrace returns undefined for unknown correlationId', () => {
    const svc = makeService();
    expect(svc.getTrace('ghost-id')).toBeUndefined();
  });

  it('getTrace returns startedAt from the first span', () => {
    const svc = makeService();
    const s1 = svc.startSpan('corr-t', 'backend', 'http_request');
    svc.startSpan('corr-t', 'coordinator', 'executeDAG');

    const trace = svc.getTrace('corr-t')!;
    expect(trace.startedAt).toBe(s1.startedAt);
  });

  it('getTrace omits endedAt and totalDurationMs when a span is still running', () => {
    const svc = makeService();
    const s1 = svc.startSpan('corr-r', 'backend', 'http_request');
    svc.startSpan('corr-r', 'coordinator', 'executeDAG'); // still running
    svc.endSpan(s1.spanId, 'completed');

    const trace = svc.getTrace('corr-r')!;
    expect(trace.endedAt).toBeUndefined();
    expect(trace.totalDurationMs).toBeUndefined();
  });

  it('getTrace computes totalDurationMs when all spans have ended', () => {
    const svc = makeService();
    const s1 = svc.startSpan('corr-d', 'backend', 'http_request');
    const s2 = svc.startSpan('corr-d', 'coordinator', 'executeDAG');
    svc.endSpan(s1.spanId, 'completed');
    svc.endSpan(s2.spanId, 'completed');

    const trace = svc.getTrace('corr-d')!;
    expect(trace.endedAt).toBeTruthy();
    expect(typeof trace.totalDurationMs).toBe('number');
    expect(trace.totalDurationMs).toBeGreaterThanOrEqual(0);
  });

  it('clearTrace removes all spans and makes getTrace return undefined', () => {
    const svc = makeService();
    svc.startSpan('corr-c', 'backend', 'http_request');
    expect(svc.getTrace('corr-c')).toBeDefined();

    svc.clearTrace('corr-c');
    expect(svc.getTrace('corr-c')).toBeUndefined();
    expect(svc.size).toBe(0);
  });

  it('size reflects the number of active trace buckets', () => {
    const svc = makeService();
    expect(svc.size).toBe(0);
    svc.startSpan('a', 'backend', 'op');
    svc.startSpan('b', 'backend', 'op');
    expect(svc.size).toBe(2);
    svc.clearTrace('a');
    expect(svc.size).toBe(1);
  });
});

// ── requestId middleware tests ────────────────────────────────────────────────

describe('requestId middleware', () => {
  // Re-require the middleware fresh each test to avoid cross-test state on
  // the singleton tracingService (we only need to check res.locals / headers).
  function freshMiddleware() {
    jest.resetModules();
    return require('../src/api/middleware/requestId').requestId as (
      req: Request,
      res: Response,
      next: NextFunction
    ) => void;
  }

  afterEach(() => jest.resetModules());

  it('sets res.locals.requestId from X-Request-Id header when present', () => {
    const mw = freshMiddleware();
    const { res, locals } = makeRes();
    const req = makeReq({ headers: { 'x-request-id': 'my-req-id' } });
    mw(req, res, jest.fn());
    expect(locals.requestId).toBe('my-req-id');
  });

  it('generates a UUID requestId when X-Request-Id header is absent', () => {
    const mw = freshMiddleware();
    const { res, locals } = makeRes();
    mw(makeReq(), res, jest.fn());
    expect(typeof locals.requestId).toBe('string');
    expect((locals.requestId as string).length).toBeGreaterThan(0);
  });

  it('sets res.locals.correlationId from X-Correlation-ID header when present', () => {
    const mw = freshMiddleware();
    const { res, locals } = makeRes();
    const req = makeReq({ headers: { 'x-correlation-id': 'my-corr-id' } });
    mw(req, res, jest.fn());
    expect(locals.correlationId).toBe('my-corr-id');
  });

  it('generates a UUID correlationId when X-Correlation-ID header is absent', () => {
    const mw = freshMiddleware();
    const { res, locals } = makeRes();
    mw(makeReq(), res, jest.fn());
    expect(typeof locals.correlationId).toBe('string');
    expect((locals.correlationId as string).length).toBeGreaterThan(0);
  });

  it('echoes X-Correlation-ID as a response header', () => {
    const mw = freshMiddleware();
    const { res, headers } = makeRes();
    const req = makeReq({ headers: { 'x-correlation-id': 'echo-me' } });
    mw(req, res, jest.fn());
    expect(headers['X-Correlation-ID']).toBe('echo-me');
  });

  it('echoes X-Request-Id as a response header', () => {
    const mw = freshMiddleware();
    const { res, headers } = makeRes();
    const req = makeReq({ headers: { 'x-request-id': 'req-42' } });
    mw(req, res, jest.fn());
    expect(headers['X-Request-Id']).toBe('req-42');
  });

  it('calls next()', () => {
    const mw = freshMiddleware();
    const { res } = makeRes();
    const next = jest.fn();
    mw(makeReq(), res, next as unknown as NextFunction);
    expect(next).toHaveBeenCalled();
  });
});

// ── GET /health/traces/:correlationId endpoint tests ─────────────────────────

import request from 'supertest';
import express from 'express';
import { tracingService as sharedTracingService } from '../src/services/tracing';
import { healthRouter } from '../src/api/routes/health';

// Build the health app once using the same module instances as the tests,
// so that spans written to `sharedTracingService` are visible to the router.
function buildHealthApp() {
  const app = express();
  app.use('/health', healthRouter);
  return app;
}

describe('GET /health/traces/:correlationId', () => {
  afterEach(() => {
    // Clean up any spans created during tests.
    sharedTracingService.clearTrace('trace-test-id');
    sharedTracingService.clearTrace('unknown-id');
  });

  it('returns 404 when no trace exists for the correlationId', async () => {
    const app = buildHealthApp();
    const res = await request(app).get('/health/traces/unknown-id');
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ error: 'Trace not found', correlationId: 'unknown-id' });
  });

  it('returns 200 with the trace when spans exist', async () => {
    // Seed a span directly into the shared singleton.
    const span = sharedTracingService.startSpan('trace-test-id', 'backend', 'http_request');
    sharedTracingService.endSpan(span.spanId, 'completed', { statusCode: 200 });

    const app = buildHealthApp();
    const res = await request(app).get('/health/traces/trace-test-id');
    expect(res.status).toBe(200);
    expect(res.body.correlationId).toBe('trace-test-id');
    expect(Array.isArray(res.body.spans)).toBe(true);
    expect(res.body.spans.length).toBeGreaterThanOrEqual(1);
    expect(res.body.startedAt).toBeTruthy();
  });
});
