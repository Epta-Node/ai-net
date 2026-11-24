/**
 * Request-ID propagation across middleware (#903).
 *
 * Verifies the ID reaches the request context, downstream spans, log lines
 * and the canonical error envelope.
 */
import express from 'express';
import request from 'supertest';
import { AppError } from '../../errors';
import { tracingService } from '../../services/tracing';
import { createLogger } from '../../utils/logger';
import { errorHandler } from './errorHandler';
import { requestId } from './requestId';

function buildApp(logLines: string[] = []) {
  const app = express();
  app.use(requestId);
  app.get('/context', (req, res) => {
    const downstream = tracingService.startSpan(req.traceId!, 'venice', 'call');
    res.json({
      requestId: req.requestId,
      traceId: req.traceId,
      spanId: downstream.spanId,
    });
  });
  app.get('/log', (_req, res) => {
    createLogger(
      { module: 'request-id-test' },
      { destination: { write: (line: string) => logLines.push(line) } },
    ).info('middleware log line');
    res.json({ ok: true });
  });
  app.get('/boom', () => {
    throw new AppError('bad request', 400, 'BAD_REQUEST');
  });
  app.use(errorHandler);
  return app;
}

describe('requestId middleware propagation (#903)', () => {
  it('reuses a supplied X-Request-Id and resolves it to the trace', async () => {
    const app = buildApp();
    const res = await request(app).get('/context').set('X-Request-Id', 'req-903-context');

    expect(res.status).toBe(200);
    expect(res.headers['x-request-id']).toBe('req-903-context');
    expect(res.body.requestId).toBe('req-903-context');
    expect(tracingService.resolveRequestId('req-903-context')).toBe(res.body.traceId);

    const span = tracingService
      .getTrace(res.body.traceId)
      ?.spans.find((s) => s.spanId === res.body.spanId);
    expect(span?.metadata?.requestId).toBe('req-903-context');
    tracingService.clearTrace(res.body.traceId);
  });

  it('writes the request ID on every log line emitted during the request', async () => {
    const previousLogLevel = process.env.LOG_LEVEL;
    // Tests default to LOG_LEVEL=silent, so enable info just for this line.
    process.env.LOG_LEVEL = 'info';
    const logLines: string[] = [];
    try {
      const app = buildApp(logLines);
      const res = await request(app).get('/log').set('X-Request-Id', 'req-903-log');

      expect(res.status).toBe(200);
      // Pino flushes to the supplied stream asynchronously.
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(logLines).toHaveLength(1);
      const line = JSON.parse(logLines[0]);
      expect(line.requestId).toBe('req-903-log');
      expect(line.traceId).toBe(res.headers['x-trace-id']);
    } finally {
      if (previousLogLevel === undefined) delete process.env.LOG_LEVEL;
      else process.env.LOG_LEVEL = previousLogLevel;
    }
  });

  it('includes the request ID inside error responses', async () => {
    const app = buildApp();
    const res = await request(app).get('/boom').set('X-Request-Id', 'req-903-error');

    expect(res.status).toBe(400);
    expect(res.body.error.requestId).toBe('req-903-error');
    expect(res.body.requestId).toBe('req-903-error');
    expect(res.body.error.correlationId).toBeDefined();
    tracingService.clearTrace(res.body.error.correlationId);
  });
});
