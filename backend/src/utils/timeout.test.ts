/**
 * Unit tests for the deadline helpers (src/utils/timeout.ts) — issue #742.
 *
 * All timing runs under Jest fake timers: the helpers hand-roll
 * setTimeout/clearTimeout precisely so budget exhaustion is testable without
 * real waits.
 */
import { withTimeout, fetchWithTimeout, isTimeoutAbort } from './timeout';
import { RequestTimeoutError } from '../errors/RequestTimeoutError';

afterEach(() => {
  jest.useRealTimers();
});

describe('withTimeout', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  it('aborts the guard signal once the budget elapses', () => {
    const guard = withTimeout(undefined, 1_000);

    jest.advanceTimersByTime(999);
    expect(guard.signal.aborted).toBe(false);
    expect(guard.didTimeout()).toBe(false);

    jest.advanceTimersByTime(1);
    expect(guard.signal.aborted).toBe(true);
    expect(guard.didTimeout()).toBe(true);
    guard.dispose();
  });

  it('passes a parent-signal abort through without marking a timeout', () => {
    const parent = new AbortController();
    const guard = withTimeout(parent.signal, 1_000);

    parent.abort();
    expect(guard.signal.aborted).toBe(true);
    expect(guard.didTimeout()).toBe(false);
    guard.dispose();
  });

  it('mirrors an already-aborted parent and never arms the budget', () => {
    const parent = new AbortController();
    const reason = new DOMException('cancelled', 'AbortError');
    parent.abort(reason);

    const guard = withTimeout(parent.signal, 1_000);
    expect(guard.signal.aborted).toBe(true);
    expect(guard.signal.reason).toBe(reason);
    expect(guard.didTimeout()).toBe(false);

    // Even far past the budget the guard stays silent: it was never armed.
    jest.advanceTimersByTime(60_000);
    expect(guard.didTimeout()).toBe(false);
    guard.dispose();
  });

  it('dispose() releases the budget timer', () => {
    const guard = withTimeout(undefined, 1_000);
    guard.dispose();
    guard.dispose(); // idempotent

    jest.advanceTimersByTime(60_000);
    expect(guard.signal.aborted).toBe(false);
    expect(guard.didTimeout()).toBe(false);
  });

  it('treats a non-positive budget as no deadline', () => {
    const guard = withTimeout(undefined, 0);

    jest.advanceTimersByTime(60_000);
    expect(guard.signal.aborted).toBe(false);
    expect(guard.didTimeout()).toBe(false);
    guard.dispose();
  });
});

describe('isTimeoutAbort', () => {
  it('recognises budget aborts only', () => {
    expect(isTimeoutAbort(new DOMException('t', 'TimeoutError'))).toBe(true);
    expect(isTimeoutAbort(new DOMException('c', 'AbortError'))).toBe(false);
    expect(isTimeoutAbort(new Error('boom'))).toBe(false);
    expect(isTimeoutAbort('TimeoutError')).toBe(false);
    expect(isTimeoutAbort(null)).toBe(false);
    expect(isTimeoutAbort(undefined)).toBe(false);
  });
});

describe('fetchWithTimeout', () => {
  const originalFetch = global.fetch;

  /** A fetch that never settles on its own; rejects when the signal aborts. */
  function hangingFetch(): typeof fetch {
    return jest.fn(
      (_input: string | URL | Request, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), {
            once: true,
          });
        })
    ) as unknown as typeof fetch;
  }

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('maps budget exhaustion to RequestTimeoutError (504 / REQUEST_TIMEOUT)', async () => {
    jest.useFakeTimers();
    global.fetch = hangingFetch();

    const pending = fetchWithTimeout('https://upstream.example/v1', undefined, 5_000);
    const expectation = expect(pending).rejects.toBeInstanceOf(RequestTimeoutError);

    jest.advanceTimersByTime(5_000);
    await expectation;

    await expect(pending).rejects.toMatchObject({
      name: 'RequestTimeoutError',
      code: 'REQUEST_TIMEOUT',
      statusCode: 504,
      details: { url: 'https://upstream.example/v1', timeoutMs: 5_000 },
    });
  });

  it('rethrows parent-signal aborts untouched (not budget exhaustion)', async () => {
    jest.useFakeTimers();
    global.fetch = hangingFetch();

    const parent = new AbortController();
    const reason = new DOMException('client gone', 'AbortError');
    const pending = fetchWithTimeout(
      'https://upstream.example/v1',
      undefined,
      60_000,
      parent.signal
    );
    const expectation = expect(pending).rejects.toBe(reason);

    parent.abort(reason);
    await expectation;

    // Far past the (never armed / released) budget nothing else fires.
    jest.advanceTimersByTime(120_000);
    await expect(pending).rejects.toBe(reason);
  });

  it('chains init.signal as the parent when no explicit signal is given', async () => {
    jest.useFakeTimers();
    const parent = new AbortController();
    const reason = new DOMException('cancelled', 'AbortError');
    global.fetch = hangingFetch();

    const pending = fetchWithTimeout(
      'https://upstream.example/v1',
      { signal: parent.signal },
      60_000
    );
    const expectation = expect(pending).rejects.toBe(reason);

    parent.abort(reason);
    await expectation;
  });

  it('passes a live signal to fetch and resolves when the call settles in budget', async () => {
    jest.useFakeTimers();
    const response = { ok: true, status: 200 } as Response;
    global.fetch = jest.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      expect(init?.signal?.aborted).toBe(false);
      return response;
    }) as unknown as typeof fetch;

    await expect(fetchWithTimeout('https://upstream.example/v1', undefined, 5_000)).resolves.toBe(
      response
    );

    // The guard released its timer: no late abort can leak into later calls.
    jest.advanceTimersByTime(60_000);
  });

  it('rethrows non-timeout failures unchanged', async () => {
    jest.useFakeTimers();
    const failure = new TypeError('fetch failed');
    global.fetch = jest.fn(() => Promise.reject(failure)) as unknown as typeof fetch;

    await expect(fetchWithTimeout('https://upstream.example/v1', undefined, 5_000)).rejects.toBe(
      failure
    );
  });
});
