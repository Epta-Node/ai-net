/**
 * Venice key-health rotation observability (issue #741).
 *
 * Rotation events have to be attributable — an operator debugging "why did
 * this call go to the fallback?" needs to tell two near-identical keys apart —
 * and they must never carry the key itself into the logs, which are shipped
 * off-box. These tests run a real client against an injected store with a
 * capturing logger and assert both properties on the rotation path.
 */

import { Writable } from 'stream';
import { VeniceClient } from '../../src/services/venice/client';
import { CircuitBreaker } from '../../src/services/venice/circuitBreaker';
import { VeniceKeyHealthStore, veniceKeyId } from '../../src/services/venice/keyHealth';
import { createLogger } from '../../src/utils/logger';

const mockFetch = jest.fn();
(global as any).fetch = mockFetch;

const P1 = { apiKey: 'sk-alpha-quota-secret', baseUrl: 'https://p1.test', name: 'primary' };
const P2 = { apiKey: 'sk-beta-healthy-secret', baseUrl: 'https://p2.test', name: 'fallback' };

function okResponse(content: string) {
  return {
    ok: true,
    status: 200,
    json: () => Promise.resolve({ choices: [{ message: { content } }] }),
  };
}

function statusResponse(status: number) {
  return {
    ok: false,
    status,
    json: () => Promise.resolve({ error: 'quota exceeded' }),
  };
}

function collectStream(): { stream: Writable; text: () => string } {
  const lines: Buffer[] = [];
  const stream = new Writable({
    write(chunk: Buffer, _enc, callback) {
      lines.push(chunk);
      callback();
    },
  });
  return { stream, text: () => lines.map((l) => l.toString()).join('') };
}

describe('venice key health log redaction (#741)', () => {
  let savedLogLevel: string | undefined;

  beforeEach(() => {
    mockFetch.mockReset();
    // getConfig() re-reads process.env on every call under NODE_ENV=test,
    // where the runtime default is LOG_LEVEL=silent — lift it so the real
    // pino pipeline writes to the capture stream.
    savedLogLevel = process.env.LOG_LEVEL;
    process.env.LOG_LEVEL = 'info';
  });

  afterEach(() => {
    if (savedLogLevel === undefined) delete process.env.LOG_LEVEL;
    else process.env.LOG_LEVEL = savedLogLevel;
  });

  it('logs the quota rotation with keyIds only — never the keys', async () => {
    const { stream, text } = collectStream();
    const store = new VeniceKeyHealthStore({
      nowFn: () => 1_000_000,
      cooldownMs: 60_000,
      maxCooldownMs: 600_000,
      logger: createLogger({ module: 'VeniceKeyHealthTest' }, { destination: stream }),
    });
    const client = new VeniceClient({
      providers: [P1, P2],
      circuitBreaker: new CircuitBreaker(),
      keyHealth: store,
      maxRetries: 0,
    });

    // Primary is out of quota; the fallback serves the call.
    mockFetch
      .mockResolvedValueOnce(statusResponse(429))
      .mockResolvedValueOnce(okResponse('served by fallback'));

    const result = await client.complete('prompt', 'research');
    expect(result).toBe('served by fallback');

    const raw = text();
    // The rotation event is attributable…
    expect(raw).toContain('venice key quota exhausted');
    expect(raw).toContain(veniceKeyId(P1.apiKey));
    // …and the key itself is absent from every captured line.
    expect(raw).not.toContain(P1.apiKey);
    expect(raw).not.toContain(P2.apiKey);
  });

  it('surfaces only redacted health from getKeyHealth()', async () => {
    const store = new VeniceKeyHealthStore({
      nowFn: () => 1_000_000,
      cooldownMs: 60_000,
      maxCooldownMs: 600_000,
      logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
    });
    const client = new VeniceClient({
      providers: [P1, P2],
      circuitBreaker: new CircuitBreaker(),
      keyHealth: store,
      maxRetries: 0,
    });

    mockFetch
      .mockResolvedValueOnce(statusResponse(429))
      .mockResolvedValueOnce(okResponse('served by fallback'));
    await client.complete('prompt', 'research');

    const health = client.getKeyHealth();
    expect(health).toHaveLength(2);
    expect(health[0]).toMatchObject({
      id: 'primary',
      keyId: veniceKeyId(P1.apiKey),
      state: 'cooldown',
      quotaEvents: 1,
    });
    expect(health[1]).toMatchObject({ id: 'fallback', state: 'healthy', successes: 1 });
    expect(JSON.stringify(health)).not.toContain(P1.apiKey);
    expect(JSON.stringify(health)).not.toContain(P2.apiKey);
  });
});
