/**
 * Venice per-key health store (issue #741).
 *
 * The store decides the order in which the fallback chain is tried and how
 * long a quota-exhausted key is skipped. These tests pin the behaviour that
 * makes #741 a win rather than a regression: a 429'd key stops costing a
 * request per call, recovers on a timer without operator action, escalates
 * its backoff while the quota stays exhausted, and never leaks the key itself
 * into snapshots or logs.
 */

import {
  VeniceKeyHealthStore,
  getVeniceKeyHealthStore,
  resetVeniceKeyHealthStore,
  veniceKeyId,
} from './keyHealth';

const P1 = { apiKey: 'sk-alpha-super-secret', baseUrl: 'https://p1.test', name: 'primary' };
const P2 = { apiKey: 'sk-beta-super-secret', baseUrl: 'https://p2.test', name: 'fallback' };

function makeStore(now = { t: 1_000_000 }) {
  return new VeniceKeyHealthStore({
    nowFn: () => now.t,
    cooldownMs: 60_000,
    maxCooldownMs: 600_000,
    logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
  });
}

describe('veniceKeyId', () => {
  it('is a 16-hex-char digest that does not contain the key', () => {
    const id = veniceKeyId(P1.apiKey);
    expect(id).toMatch(/^[0-9a-f]{16}$/);
    expect(id).not.toContain(P1.apiKey);
  });

  it('is stable for the same key and different for different keys', () => {
    expect(veniceKeyId(P1.apiKey)).toBe(veniceKeyId(P1.apiKey));
    expect(veniceKeyId(P1.apiKey)).not.toBe(veniceKeyId(P2.apiKey));
  });
});

describe('VeniceKeyHealthStore registration and snapshots', () => {
  it('registers providers and reports them healthy with a redacted keyId', () => {
    const store = makeStore();
    store.register([P1, P2]);

    const snap = store.snapshot();
    expect(snap).toHaveLength(2);
    expect(snap[0]).toMatchObject({
      id: 'primary',
      keyId: veniceKeyId(P1.apiKey),
      state: 'healthy',
      cooldownUntil: null,
      successes: 0,
      failures: 0,
      quotaEvents: 0,
      errorRate: 0,
    });
    expect(snap[1]!.id).toBe('fallback');
  });

  it('never exposes the raw key in a snapshot', () => {
    const store = makeStore();
    store.register([P1, P2]);
    store.recordFailure('primary', 'quota');

    const serialized = JSON.stringify(store.snapshot());
    expect(serialized).not.toContain(P1.apiKey);
    expect(serialized).not.toContain(P2.apiKey);
  });

  it('resets identity and cooldown when the key behind a slot is rotated', () => {
    const store = makeStore();
    store.register([P1, P2]);
    store.recordFailure('primary', 'quota');

    const rotated = { ...P1, apiKey: 'sk-rotated-super-secret' };
    store.register([rotated, P2]);

    const snap = store.snapshot();
    expect(snap[0]!.keyId).toBe(veniceKeyId(rotated.apiKey));
    expect(snap[0]!.state).toBe('healthy');
    expect(snap[0]!.cooldownUntil).toBeNull();
  });

  it('reports keyIdFor for known slots and undefined for unknown ones', () => {
    const store = makeStore();
    store.register([P1]);
    expect(store.keyIdFor('primary')).toBe(veniceKeyId(P1.apiKey));
    expect(store.keyIdFor('nope')).toBeUndefined();
  });
});

describe('VeniceKeyHealthStore quota cooldown', () => {
  it('cools a key down after a quota failure and demotes it in the order', () => {
    const now = { t: 1_000_000 };
    const store = makeStore(now);
    store.register([P1, P2]);

    store.recordFailure('primary', 'quota');

    const snap = store.snapshot();
    expect(snap[0]).toMatchObject({
      state: 'cooldown',
      quotaEvents: 1,
      cooldownUntil: now.t + 60_000,
    });
    expect(store.order([P1, P2]).map((p) => p.name)).toEqual(['fallback', 'primary']);
  });

  it('recovers the key once the cooldown lapses, back in configured order', () => {
    const now = { t: 1_000_000 };
    const store = makeStore(now);
    store.register([P1, P2]);
    store.recordFailure('primary', 'quota');

    now.t += 60_001;

    expect(store.order([P1, P2]).map((p) => p.name)).toEqual(['primary', 'fallback']);
    expect(store.snapshot()[0]!.state).toBe('healthy');
  });

  it('escalates the cooldown on consecutive quota events and caps it', () => {
    const now = { t: 1_000_000 };
    const store = makeStore(now);
    store.register([P1, P2]);

    store.recordFailure('primary', 'quota');
    expect(store.snapshot()[0]!.cooldownUntil).toBe(now.t + 60_000);

    now.t += 60_001;
    store.recordFailure('primary', 'quota');
    expect(store.snapshot()[0]!.cooldownUntil).toBe(now.t + 120_000);

    // Keep the streak alive until the cap (600_000) is hit.
    for (let i = 0; i < 6; i++) {
      now.t += 900_000;
      store.recordFailure('primary', 'quota');
    }
    expect(store.snapshot()[0]!.cooldownUntil).toBe(now.t + 600_000);
  });

  it('clears the escalation streak after a success', () => {
    const now = { t: 1_000_000 };
    const store = makeStore(now);
    store.register([P1, P2]);

    store.recordFailure('primary', 'quota');
    store.recordFailure('primary', 'quota');
    now.t += 60_001;
    store.recordSuccess('primary', 100);

    store.recordFailure('primary', 'quota');
    expect(store.snapshot()[0]!.cooldownUntil).toBe(now.t + 60_000);
  });

  it('keeps quota failures out of the rolling error rate so recovery is real', () => {
    const now = { t: 1_000_000 };
    const store = makeStore(now);
    store.register([P1, P2]);

    store.recordFailure('primary', 'quota');
    now.t += 60_001;

    // A cooled-down-then-expired key must rank first again: a permanently
    // poisoned error rate would mean the key is never retried and #741
    // silently becomes permanent demotion.
    expect(store.snapshot()[0]!.errorRate).toBe(0);
    expect(store.order([P1, P2]).map((p) => p.name)).toEqual(['primary', 'fallback']);
  });

  it('still returns an order when every key is cooling down (earliest expiry first)', () => {
    const now = { t: 1_000_000 };
    const store = makeStore(now);
    store.register([P1, P2]);

    store.recordFailure('primary', 'quota');
    now.t += 1_000;
    store.recordFailure('fallback', 'quota');

    expect(store.order([P1, P2]).map((p) => p.name)).toEqual(['primary', 'fallback']);
    expect(store.snapshot().every((k) => k.state === 'cooldown')).toBe(true);
  });

  it('logs the cooldown with the keyId and never with the key', () => {
    const warn = jest.fn();
    const now = { t: 1_000_000 };
    const store = new VeniceKeyHealthStore({
      nowFn: () => now.t,
      cooldownMs: 60_000,
      maxCooldownMs: 600_000,
      logger: { info: jest.fn(), warn, error: jest.fn() },
    });
    store.register([P1, P2]);

    store.recordFailure('primary', 'quota');

    expect(warn).toHaveBeenCalledTimes(1);
    const [payload, message] = warn.mock.calls[0]! as [Record<string, unknown>, string];
    expect(message).toContain('venice key quota exhausted');
    expect(payload.keyId).toBe(veniceKeyId(P1.apiKey));
    expect(payload.provider).toBe('primary');
    expect(payload.cooldownUntil).toBe(now.t + 60_000);
    expect(JSON.stringify(payload)).not.toContain(P1.apiKey);
  });
});

describe('VeniceKeyHealthStore non-quota failures', () => {
  it.each(['auth', 'server', 'transport'] as const)(
    'does not cool a key down after a %s failure, but degrades its ranking',
    (kind) => {
      const store = makeStore();
      store.register([P1, P2]);

      store.recordFailure('primary', kind);

      const snap = store.snapshot();
      expect(snap[0]!.state).not.toBe('cooldown');
      expect(snap[0]!.errorRate).toBe(1);
      expect(store.order([P1, P2]).map((p) => p.name)).toEqual(['fallback', 'primary']);
    }
  );

  it('lets a healthy fallback earn first place on latency among clean keys', () => {
    const store = makeStore();
    store.register([P1, P2]);

    store.recordSuccess('primary', 900);
    store.recordSuccess('fallback', 50);

    expect(store.order([P1, P2]).map((p) => p.name)).toEqual(['fallback', 'primary']);
  });

  it('preserves configured order for keys with equal health', () => {
    const store = makeStore();
    store.register([P1, P2]);
    expect(store.order([P1, P2]).map((p) => p.name)).toEqual(['primary', 'fallback']);

    store.recordSuccess('primary', 100);
    store.recordSuccess('fallback', 100);
    expect(store.order([P1, P2]).map((p) => p.name)).toEqual(['primary', 'fallback']);
  });

  it('returns a copy for a single-provider chain', () => {
    const store = makeStore();
    store.register([P1]);
    expect(store.order([P1])).toEqual([P1]);
  });

  it('logs a recovery when a cooling key succeeds', () => {
    const info = jest.fn();
    const store = new VeniceKeyHealthStore({
      nowFn: () => 1_000_000,
      cooldownMs: 60_000,
      maxCooldownMs: 600_000,
      logger: { info, warn: jest.fn(), error: jest.fn() },
    });
    store.register([P1, P2]);
    store.recordFailure('primary', 'quota');
    store.recordSuccess('primary', 80);

    expect(info).toHaveBeenCalledTimes(1);
    const [payload, message] = info.mock.calls[0]! as [Record<string, unknown>, string];
    expect(message).toContain('venice key recovered');
    expect(payload.keyId).toBe(veniceKeyId(P1.apiKey));
    expect(JSON.stringify(payload)).not.toContain(P1.apiKey);
    expect(store.snapshot()[0]!.state).toBe('healthy');
  });
});

describe('shared key health store', () => {
  afterEach(() => resetVeniceKeyHealthStore());

  it('returns one process-wide instance until it is reset', () => {
    const first = getVeniceKeyHealthStore();
    expect(getVeniceKeyHealthStore()).toBe(first);

    resetVeniceKeyHealthStore();
    expect(getVeniceKeyHealthStore()).not.toBe(first);
  });

  it('reads the cooldown configuration from env-backed defaults', () => {
    const store = getVeniceKeyHealthStore();
    store.register([P1, P2]);
    store.recordFailure('primary', 'quota');

    // Default cooldown is 60s when VENICE_KEY_COOLDOWN_MS is unset.
    const cooldownUntil = store.snapshot()[0]!.cooldownUntil;
    expect(cooldownUntil).not.toBeNull();
    expect(cooldownUntil! - Date.now()).toBeGreaterThan(0);
    expect(cooldownUntil! - Date.now()).toBeLessThanOrEqual(60_000);
  });
});
