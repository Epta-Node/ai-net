/**
 * Unit tests for the per-endpoint timeout budget middleware (issue #742).
 *
 * AC: "Unit tests use fake timers to assert timeout → 504 mapping." — the
 * deterministic suites below drive the budget timer under Jest fake timers,
 * route the captured error through the real error handler, and assert the
 * 504 / REQUEST_TIMEOUT envelope. A final pair of supertest cases proves the
 * same behaviour end-to-end over HTTP with a short (50ms) configured budget.
 */
import express from 'express';
import request from 'supertest';
import type { NextFunction, Request, Response } from 'express';
import { timeoutBudget, budgetMsFor } from './timeoutBudget';
import { errorHandler } from './errorHandler';
import { RequestTimeoutError } from '../../errors/RequestTimeoutError';

afterEach(() => {
  jest.useRealTimers();
});

/** Minimal express Response double: listener registry + write spies. */
interface FakeResponse {
  headersSent: boolean;
  writableEnded: boolean;
  locals: Record<string, unknown>;
  on: jest.Mock;
  emit: (event: string) => void;
  status: jest.Mock;
  json: jest.Mock;
  send: jest.Mock;
  end: jest.Mock;
  write: jest.Mock;
  setHeader: jest.Mock;
}

function fakeRes(): FakeResponse {
  const listeners = new Map<string, Array<() => void>>();
  const res: FakeResponse = {
    headersSent: false,
    writableEnded: false,
    locals: {} as Record<string, unknown>,
    on: jest.fn((event: string, cb: () => void) => {
      const group = listeners.get(event) ?? [];
      group.push(cb);
      listeners.set(event, group);
      return res;
    }),
    emit: (event: string): void => {
      (listeners.get(event) ?? []).forEach((cb) => cb());
    },
    status: jest.fn(() => res),
    json: jest.fn(() => res),
    send: jest.fn(() => res),
    end: jest.fn(() => res),
    write: jest.fn(() => true),
    setHeader: jest.fn(() => res),
  };
  return res;
}

function fakeReq(method = 'GET', path = '/api/widgets/42'): Request {
  return { method, path } as unknown as Request;
}

describe('budgetMsFor', () => {
  it('resolves each route class from config', () => {
    expect(budgetMsFor('llm_submit')).toBe(30_000);
    expect(budgetMsFor('read')).toBe(5_000);
    expect(budgetMsFor('admin')).toBe(10_000);
  });

  it('is configurable via env', () => {
    process.env.TIMEOUT_BUDGET_READ_MS = '25';
    try {
      expect(budgetMsFor('read')).toBe(25);
    } finally {
      delete process.env.TIMEOUT_BUDGET_READ_MS;
    }
    expect(budgetMsFor('read')).toBe(5_000);
  });
});

describe('timeoutBudget — timeout → 504 mapping (fake timers)', () => {
  it('fires exactly at the budget and maps to a 504 REQUEST_TIMEOUT envelope', () => {
    jest.useFakeTimers();
    const req = fakeReq();
    const res = fakeRes();
    const jsonSpy = res.json;
    const next = jest.fn();

    timeoutBudget('read')(req, res as unknown as Response, next as NextFunction);

    // The chain passes through once when the budget is armed; no error yet.
    jest.advanceTimersByTime(4_999);
    expect(next).toHaveBeenCalledTimes(1);
    expect(next).toHaveBeenCalledWith();

    jest.advanceTimersByTime(1);
    expect(next).toHaveBeenCalledTimes(2);

    const err = next.mock.calls[1][0];
    expect(err).toBeInstanceOf(RequestTimeoutError);
    expect(err.statusCode).toBe(504);
    expect(err.code).toBe('REQUEST_TIMEOUT');
    expect(err.details).toEqual({ routeClass: 'read', budgetMs: 5_000 });

    // Through the real error handler the typed error becomes the canonical
    // 504 envelope clients consume.
    errorHandler(err, req, res as unknown as Response, jest.fn() as NextFunction);
    expect(res.status).toHaveBeenCalledWith(504);
    expect(jsonSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        statusCode: 504,
        error: expect.objectContaining({ code: 'REQUEST_TIMEOUT' }),
      })
    );
  });

  it('swallows a late handler write once the budget has fired', () => {
    jest.useFakeTimers();
    const req = fakeReq();
    const res = fakeRes();
    const jsonSpy = res.json;
    const setHeaderSpy = res.setHeader;
    const next = jest.fn();

    timeoutBudget('read')(req, res as unknown as Response, next as NextFunction);
    jest.advanceTimersByTime(5_000);
    expect(next).toHaveBeenCalledTimes(2); // pass-through + budget error

    // The error handler sends the 504 through the patched methods first.
    errorHandler(next.mock.calls[1][0], req, res as unknown as Response, jest.fn() as NextFunction);
    const sentDuringErrorHandling = jsonSpy.mock.calls.length;
    expect(sentDuringErrorHandling).toBe(1);

    // The still-running handler finishes late: its write is swallowed instead
    // of throwing "Cannot set headers after they are sent".
    res.headersSent = true;
    res.json({ too: 'late' });
    res.send('late');
    res.setHeader('X-Late', '1');
    expect(jsonSpy.mock.calls.length).toBe(sentDuringErrorHandling);
    expect(setHeaderSpy).not.toHaveBeenCalled();
  });

  it('clears the budget when the response finishes', () => {
    jest.useFakeTimers();
    const next = jest.fn();
    const res = fakeRes();
    timeoutBudget('read')(fakeReq(), res as unknown as Response, next as NextFunction);

    res.emit('finish');
    jest.advanceTimersByTime(60_000);
    expect(next).toHaveBeenCalledTimes(1); // pass-through only, budget cleared
    expect(next).toHaveBeenCalledWith();
  });

  it('clears the budget when the client disconnects', () => {
    jest.useFakeTimers();
    const next = jest.fn();
    const res = fakeRes();
    timeoutBudget('read')(fakeReq(), res as unknown as Response, next as NextFunction);

    res.emit('close');
    jest.advanceTimersByTime(60_000);
    expect(next).toHaveBeenCalledTimes(1); // pass-through only, budget cleared
    expect(next).toHaveBeenCalledWith();
  });

  it('skips methods outside the budget scope without arming a timer', () => {
    jest.useFakeTimers();
    const next = jest.fn();
    const res = fakeRes();
    timeoutBudget('read', { methods: ['GET'] })(
      fakeReq('POST'),
      res as unknown as Response,
      next as NextFunction
    );

    expect(next).toHaveBeenCalledWith();
    expect(res.on).not.toHaveBeenCalled();
    jest.advanceTimersByTime(60_000);
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('skips exempt requests without arming a timer', () => {
    jest.useFakeTimers();
    const next = jest.fn();
    const res = fakeRes();
    timeoutBudget('read', {
      methods: ['GET'],
      exempt: (req) => req.path.includes('/events/stream'),
    })(
      fakeReq('GET', '/api/tasks/t-1/events/stream'),
      res as unknown as Response,
      next as NextFunction
    );

    expect(next).toHaveBeenCalledWith();
    expect(res.on).not.toHaveBeenCalled();
    jest.advanceTimersByTime(60_000);
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('keeps the first class claimed when two mounts overlap', () => {
    jest.useFakeTimers();
    const next = jest.fn();
    const res = fakeRes();
    res.locals.timeoutBudgetClass = 'admin'; // claimed by an earlier mount

    timeoutBudget('read')(fakeReq(), res as unknown as Response, next as NextFunction);

    expect(next).toHaveBeenCalledWith();
    expect(res.on).not.toHaveBeenCalled();
    jest.advanceTimersByTime(60_000);
    expect(next).toHaveBeenCalledTimes(1);
  });
});

describe('timeoutBudget — HTTP integration', () => {
  const previousBudget = process.env.TIMEOUT_BUDGET_READ_MS;

  afterAll(() => {
    if (previousBudget === undefined) {
      delete process.env.TIMEOUT_BUDGET_READ_MS;
    } else {
      process.env.TIMEOUT_BUDGET_READ_MS = previousBudget;
    }
  });

  it('cuts a hanging GET off with 504 REQUEST_TIMEOUT', async () => {
    process.env.TIMEOUT_BUDGET_READ_MS = '50';

    const app = express();
    app.use(timeoutBudget('read', { methods: ['GET'] }));
    app.get('/hang', (_req, _res) => {
      /* deliberately never responds */
    });
    app.use(errorHandler);

    const res = await request(app).get('/hang');
    expect(res.status).toBe(504);
    expect(res.body.statusCode).toBe(504);
    expect(res.body.error.code).toBe('REQUEST_TIMEOUT');
    expect(res.body.error.details).toEqual({ routeClass: 'read', budgetMs: 50 });
  });

  it('lets a response inside the budget through untouched', async () => {
    process.env.TIMEOUT_BUDGET_READ_MS = '5000';

    const app = express();
    app.use(timeoutBudget('read', { methods: ['GET'] }));
    app.get('/fast', (_req, res) => {
      res.json({ ok: true });
    });
    app.use(errorHandler);

    const res = await request(app).get('/fast');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });
});
