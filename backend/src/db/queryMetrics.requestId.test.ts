/** Slow-query logs carry the active request ID (#903). */
jest.mock('../utils/logger', () => {
  const warn = jest.fn();
  return { createLogger: () => ({ warn }), mockWarn: warn };
});

// jestSetup.ts loads the real queryMetrics module before this suite's mock is
// registered, so re-import it (and its dependencies) afterwards.
let recordDbQuery: typeof import('./queryMetrics').recordDbQuery;
let runWithTraceContext: typeof import('../services/traceContext').runWithTraceContext;
let mockWarn: jest.Mock;

describe('database query logs (#903)', () => {
  beforeAll(async () => {
    jest.resetModules();
    mockWarn = (jest.requireMock('../utils/logger') as { mockWarn: jest.Mock }).mockWarn;
    ({ recordDbQuery } = await import('./queryMetrics'));
    ({ runWithTraceContext } = await import('../services/traceContext'));
  });

  beforeEach(() => {
    mockWarn.mockClear();
  });

  it('adds the request and trace IDs to slow-query log entries', () => {
    runWithTraceContext(
      { traceId: 'trace-903', spanId: 'span-903', requestId: 'req-903-db' },
      () => recordDbQuery('tasks', 'SELECT 1', 300),
    );

    expect(mockWarn).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'slow_query',
        db: 'tasks',
        requestId: 'req-903-db',
        traceId: 'trace-903',
      }),
      'slow query',
    );
  });

  it('does not invent an ID for background queries', () => {
    recordDbQuery('tasks', 'SELECT 1', 300);

    const fields = mockWarn.mock.calls[0][0] as Record<string, unknown>;
    expect(fields.requestId).toBeUndefined();
    expect(fields.traceId).toBeUndefined();
  });
});
