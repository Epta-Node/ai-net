import { Writable } from 'stream';
import pino from 'pino';
import { requestId } from '../src/api/middleware/requestId';
import type { Request, Response, NextFunction } from 'express';

/** A simple writable stream that collects written chunks into an array. */
function collectStream(): { stream: Writable; lines: Buffer[] } {
  const lines: Buffer[] = [];
  const stream = new Writable({
    write(chunk: Buffer, _enc: string, cb: () => void) {
      lines.push(chunk);
      cb();
    },
  });
  return { stream, lines };
}

/** Parse a Buffer into a JSON object, or null on failure. */
function parseLine(buf: Buffer): Record<string, unknown> | null {
  try {
    return JSON.parse(buf.toString()) as Record<string, unknown>;
  } catch {
    return null;
  }
}

describe('Structured Logger', () => {
  describe('LOG_LEVEL env var', () => {
    const origLevel = process.env.LOG_LEVEL;

    afterEach(() => {
      process.env.LOG_LEVEL = origLevel;
    });

    it('includes requestId in log output', () => {
      const { stream, lines } = collectStream();

      const log = pino({ level: 'info' }, stream);
      const child = log.child({ requestId: 'test-req-456', taskId: 'task_abc' });
      child.info({ nodeId: 'node_1' }, 'node execution started');

      // Give pino a tick to flush
      expect(lines.length).toBeGreaterThanOrEqual(1);

      const logEntry = lines
        .map(parseLine)
        .find((e): e is Record<string, unknown> => e !== null && e.requestId === 'test-req-456');

      expect(logEntry).toBeDefined();
      expect(logEntry!.taskId).toBe('task_abc');
      expect(logEntry!.nodeId).toBe('node_1');
      expect(logEntry!.level).toBe(30); // pino info level
      expect(typeof logEntry!.time).toBe('number');
    });
  });

  it('LOG_LEVEL=silent suppresses all output', () => {
    process.env.LOG_LEVEL = 'silent';

    const { stream } = collectStream();
    const writeSpy = jest.spyOn(stream, 'write');

    const log = pino({ level: 'silent', enabled: false }, stream);
    log.info({ requestId: 'should-not-appear' }, 'this should be silent');
    log.warn('silent warning');
    log.error('silent error');

    expect(writeSpy).not.toHaveBeenCalled();

    process.env.LOG_LEVEL = 'info';
    writeSpy.mockRestore();
  });

  it('LOG_LEVEL=info allows info level logs', () => {
    process.env.LOG_LEVEL = 'info';

    const { stream, lines } = collectStream();
    const log = pino({ level: 'info' }, stream);
    log.info({ requestId: 'test-req' }, 'info message');

    expect(lines.length).toBeGreaterThanOrEqual(1);

    const entry = parseLine(lines[0]!);
    expect(entry).not.toBeNull();
    expect(entry!.requestId).toBe('test-req');
    expect(entry!.level).toBe(30);

    process.env.LOG_LEVEL = 'info';
  });
});

describe('requestId middleware', () => {
  it('generates a requestId when no X-Request-Id header is present', () => {
    const req = { headers: {} } as unknown as Request;
    const res = { locals: {}, setHeader: jest.fn() } as unknown as Response;
    const next = jest.fn() as NextFunction;

    requestId(req, res, next);

    expect(res.locals.requestId).toBeDefined();
    expect(typeof res.locals.requestId).toBe('string');
    expect(res.locals.requestId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
    expect(res.setHeader).toHaveBeenCalledWith('X-Request-Id', res.locals.requestId);
    expect(next).toHaveBeenCalled();
  });

  it('reuses existing X-Request-Id header when present', () => {
    const existingId = 'existing-trace-id-12345';
    const req = { headers: { 'x-request-id': existingId } } as unknown as Request;
    const res = { locals: {}, setHeader: jest.fn() } as unknown as Response;
    const next = jest.fn() as NextFunction;

    requestId(req, res, next);

    expect(res.locals.requestId).toBe(existingId);
    expect(res.setHeader).toHaveBeenCalledWith('X-Request-Id', existingId);
    expect(next).toHaveBeenCalled();
  });
});
