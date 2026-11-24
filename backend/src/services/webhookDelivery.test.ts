import { createHmac } from 'crypto';
import {
  DELIVERY_LOG_LIMIT,
  MAX_FAILED_ATTEMPTS,
  WEBHOOK_RETRY_DELAYS_MS,
  classifyDelivery,
  dueForRetry,
  generateSigningKey,
  hashSigningKey,
  nextStepAfterFailure,
  signBody,
  signingKeyMatches,
  validateRegistration,
  verifySignature,
} from './webhookDelivery';

const EVENTS = ['task.created', 'task.completed', 'task.failed'];
const NOW = new Date('2026-11-24T08:00:00.000Z');

describe('signing', () => {
  it('signs the exact body with HMAC-SHA256 as lowercase hex', () => {
    const body = JSON.stringify({ event: 'task.completed', taskId: 't1' });
    const expected = createHmac('sha256', 'key-123').update(body).digest('hex');
    expect(signBody('key-123', body)).toBe(expected);
    expect(signBody('key-123', body)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('changes when the body or the key changes', () => {
    expect(signBody('k', 'a')).not.toBe(signBody('k', 'b'));
    expect(signBody('k1', 'a')).not.toBe(signBody('k2', 'a'));
  });

  it('verifies a valid signature and rejects a tampered body, wrong key or bad header', () => {
    const body = '{"x":1}';
    const sig = signBody('secret-key', body);
    expect(verifySignature('secret-key', body, sig)).toBe(true);
    expect(verifySignature('secret-key', body, sig.toUpperCase())).toBe(true);
    expect(verifySignature('secret-key', '{"x":2}', sig)).toBe(false);
    expect(verifySignature('other-key', body, sig)).toBe(false);
    expect(verifySignature('secret-key', body, sig.slice(0, -2))).toBe(false);
    expect(verifySignature('secret-key', body, '')).toBe(false);
    expect(verifySignature('secret-key', body, undefined)).toBe(false);
  });
});

describe('signing key storage', () => {
  it('generates distinct 256-bit hex keys', () => {
    const a = generateSigningKey();
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(generateSigningKey()).not.toBe(a);
  });

  it('stores only a SHA-256 hash, never the key', () => {
    const key = generateSigningKey();
    const hash = hashSigningKey(key);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hash).not.toContain(key);
    expect(hashSigningKey(key)).toBe(hash);
  });

  it('matches only the original key (so a wrong key is a 403)', () => {
    const key = generateSigningKey();
    const hash = hashSigningKey(key);
    expect(signingKeyMatches(key, hash)).toBe(true);
    expect(signingKeyMatches(generateSigningKey(), hash)).toBe(false);
    expect(signingKeyMatches('', hash)).toBe(false);
    expect(signingKeyMatches(undefined, hash)).toBe(false);
    expect(signingKeyMatches(hash, hash)).toBe(false);
  });
});

describe('classifyDelivery', () => {
  it.each([200, 201, 204, 299])('treats %i as delivered', (httpStatus) => {
    expect(classifyDelivery({ httpStatus })).toBe('delivered');
  });

  it.each([199, 301, 400, 404, 429, 500, 503])('treats %i as failed', (httpStatus) => {
    expect(classifyDelivery({ httpStatus })).toBe('failed');
  });

  it('treats timeouts, network errors and missing responses as failed', () => {
    expect(classifyDelivery({ timedOut: true, httpStatus: 200 })).toBe('failed');
    expect(classifyDelivery({ error: 'ECONNREFUSED' })).toBe('failed');
    expect(classifyDelivery({})).toBe('failed');
    expect(classifyDelivery({ httpStatus: null })).toBe('failed');
  });
});

describe('retry schedule', () => {
  it('uses 30s, 5m, 30m, 2h, 8h', () => {
    expect([...WEBHOOK_RETRY_DELAYS_MS]).toEqual([30_000, 300_000, 1_800_000, 7_200_000, 28_800_000]);
  });

  it.each([
    [1, 30_000],
    [2, 300_000],
    [3, 1_800_000],
    [4, 7_200_000],
  ])('after failure %i retries after %i ms', (failed, delay) => {
    const step = nextStepAfterFailure(failed, NOW);
    expect(step).toEqual({ action: 'retry', delayMs: delay, nextRetryAt: new Date(NOW.getTime() + delay) });
  });

  it('disables the webhook after the fifth failure', () => {
    expect(MAX_FAILED_ATTEMPTS).toBe(5);
    expect(nextStepAfterFailure(5, NOW)).toEqual({ action: 'disable' });
    expect(nextStepAfterFailure(9, NOW)).toEqual({ action: 'disable' });
  });

  it('rejects an invalid failure count', () => {
    expect(() => nextStepAfterFailure(0, NOW)).toThrow(RangeError);
    expect(() => nextStepAfterFailure(1.5, NOW)).toThrow(RangeError);
  });

  it('keeps the delivery log to 50 entries', () => {
    expect(DELIVERY_LOG_LIMIT).toBe(50);
  });
});

describe('dueForRetry', () => {
  const at = (s: string) => new Date(s);
  const rows = [
    { id: 'late', status: 'failed', nextRetryAt: at('2026-11-24T07:59:00Z') },
    { id: 'early', status: 'failed', nextRetryAt: at('2026-11-24T07:00:00Z') },
    { id: 'future', status: 'failed', nextRetryAt: at('2026-11-24T08:00:01Z') },
    { id: 'done', status: 'delivered', nextRetryAt: null },
    { id: 'none', status: 'failed', nextRetryAt: null },
  ];

  it('returns failed deliveries whose time has come, oldest first', () => {
    expect(dueForRetry(rows, NOW).map((d) => d.id)).toEqual(['early', 'late']);
  });

  it('includes a delivery due exactly now', () => {
    expect(dueForRetry([{ id: 'x', status: 'failed', nextRetryAt: NOW }], NOW)).toHaveLength(1);
  });
});

describe('validateRegistration', () => {
  const ok = { url: 'https://ci.example.com/hooks/ainet', events: ['task.completed'], secret: 'a'.repeat(16) };

  it('accepts a valid registration', () => {
    expect(validateRegistration(ok, EVENTS)).toBeNull();
  });

  it('requires https and no embedded credentials', () => {
    expect(validateRegistration({ ...ok, url: 'http://ci.example.com/h' }, EVENTS)).toMatch(/https/);
    expect(validateRegistration({ ...ok, url: 'https://user:pw@ci.example.com/h' }, EVENTS)).toMatch(/credentials/);
    expect(validateRegistration({ ...ok, url: 'not a url' }, EVENTS)).toMatch(/valid URL/);
    expect(validateRegistration({ ...ok, url: undefined }, EVENTS)).toMatch(/required/);
  });

  it.each([
    'https://localhost/h',
    'https://127.0.0.1/h',
    'https://10.1.2.3/h',
    'https://192.168.0.5/h',
    'https://172.20.1.1/h',
    'https://169.254.169.254/latest/meta-data',
    'https://[::1]/h',
    'https://db.internal/h',
  ])('refuses the private address %s', (url) => {
    expect(validateRegistration({ ...ok, url }, EVENTS)).toMatch(/private or local/);
  });

  it('allows public addresses that merely look similar', () => {
    expect(validateRegistration({ ...ok, url: 'https://172.32.0.1/h' }, EVENTS)).toBeNull();
    expect(validateRegistration({ ...ok, url: 'https://110.1.2.3/h' }, EVENTS)).toBeNull();
  });

  it('checks events and the secret', () => {
    expect(validateRegistration({ ...ok, events: [] }, EVENTS)).toMatch(/non-empty/);
    expect(validateRegistration({ ...ok, events: 'task.completed' }, EVENTS)).toMatch(/non-empty/);
    expect(validateRegistration({ ...ok, events: ['task.exploded'] }, EVENTS)).toMatch(/Unknown event/);
    expect(validateRegistration({ ...ok, secret: 'short' }, EVENTS)).toMatch(/secret/);
    expect(validateRegistration({ ...ok, secret: undefined }, EVENTS)).toMatch(/secret/);
  });
});
