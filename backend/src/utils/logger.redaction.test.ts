import { Writable } from 'stream';

import { createLogger, sanitizeLogPayload } from './logger';
import { createLogger as apiCreateLogger } from '../api/logger';

// Issue #746: a canary secret must never reach log output, whichever logger
// or field shape it travels through.
const CANARY = 'canary-s3cr3t-7f1c9a';
const JWT = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJjYW5hcnkifQ.c2lnbmF0dXJlLWNhbmFyeQ';

function captureLogger(factory: typeof createLogger, bindings?: Record<string, unknown>) {
  const lines: string[] = [];
  const destination = new Writable({
    write(chunk, _enc, cb) {
      lines.push(chunk.toString());
      cb();
    },
  });
  const log = factory(bindings, { destination });
  return { log, output: () => lines.join('') };
}

const fakeReq = {
  method: 'POST',
  originalUrl: `/api/tasks?api_key=${CANARY}`,
  ip: '127.0.0.1',
  headers: { authorization: `Bearer ${CANARY}`, cookie: `sid=${CANARY}`, 'x-api-key': CANARY },
  body: { prompt: CANARY },
};

const payloads: Array<[string, Record<string, unknown> | string]> = [
  ['authorization header', { headers: { authorization: `Bearer ${CANARY}` } }],
  ['cookie header', { headers: { cookie: `session=${CANARY}` } }],
  ['x-api-key header', { headers: { 'x-api-key': CANARY } }],
  ['venice key', { config: { veniceApiKey: CANARY } }],
  ['jwt field', { jwt: CANARY }],
  ['signature', { wallet: { signature: CANARY } }],
  ['prompt body', { task: { prompt: `do this ${CANARY}` } }],
  ['llm completion', { completion: CANARY }],
  ['request body', { body: { anything: CANARY } }],
  ['express req', { req: fakeReq }],
  [
    'express res',
    { res: { statusCode: 200, getHeaders: () => ({ 'set-cookie': CANARY }), body: CANARY } },
  ],
  ['bearer in message', `upstream rejected Bearer ${CANARY}`],
  ['key=value in message', `GET /v1?token=${CANARY}`],
  ['jwt in message', `token was ${JWT}`],
];

describe('logger canary-secret redaction', () => {
  // The test config defaults to LOG_LEVEL=silent; an explicit env value wins
  // and gives each fresh destination-backed logger something to write.
  const previousLevel = process.env.LOG_LEVEL;
  beforeAll(() => {
    process.env.LOG_LEVEL = 'info';
  });
  afterAll(() => {
    if (previousLevel === undefined) delete process.env.LOG_LEVEL;
    else process.env.LOG_LEVEL = previousLevel;
  });

  const factories: Array<[string, typeof createLogger]> = [
    ['utils/logger createLogger', createLogger],
    ['api/logger createLogger', apiCreateLogger],
  ];

  for (const [factoryName, factory] of factories) {
    describe(factoryName, () => {
      it.each(payloads)('never writes the canary via %s', (_label, payload) => {
        const { log, output } = captureLogger(factory, { component: 'canary-test' });
        if (typeof payload === 'string') log.warn(payload);
        else log.info(payload, 'canary');
        const child = log.child({ apiKey: CANARY });
        child.error(new Error(`failed with password=${CANARY}`));

        const written = output();
        expect(written.length).toBeGreaterThan(0);
        expect(written).not.toContain(CANARY);
        expect(written).not.toContain(JWT);
      });
    });
  }

  it('whitelists req fields instead of serializing the whole request', () => {
    const sanitized = sanitizeLogPayload({ req: fakeReq }) as { req: Record<string, unknown> };
    expect(Object.keys(sanitized.req).sort()).toEqual(['id', 'ip', 'method', 'path']);
    expect(sanitized.req.path).toBe('/api/tasks');
  });
});
