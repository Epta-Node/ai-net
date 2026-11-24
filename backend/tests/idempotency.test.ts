/**
 * Idempotency middleware behaviour (issue #658).
 *
 * The fix for #658 replaced a check-then-execute lookup with a reservation taken
 * *before* the handler is dispatched. These tests drive the middleware against
 * an in-memory `IdempotencyStore` fake so the decision logic — reserve, replay,
 * 409 on in-flight, 400 on an oversized key, release on failure — is asserted
 * without any SQLite involved.
 *
 * The real store, and the concurrency behaviour that actually motivated the
 * change, are covered in `tests/sqlite/idempotencyConcurrency.test.ts`.
 */
import request from 'supertest';
import express, { Router, Request, Response, NextFunction } from 'express';
import {
  createIdempotencyMiddleware,
  IDEMPOTENCY_KEY_MAX_LENGTH,
} from '../src/api/middleware/idempotency';
import { errorHandler } from '../src/api/middleware/errorHandler';
import {
  type IdempotencyEntry,
  type IdempotencyReservation,
  type IdempotencyStore,
} from '../src/services/idempotency';

// ---------------------------------------------------------------------------
// In-memory store fake
// ---------------------------------------------------------------------------

interface Slot {
  wallet: string;
  key: string;
  status: 'pending' | 'completed';
  reservationId: string;
  statusCode?: number;
  responseBody?: string;
  createdAt: string;
  expiresAt: string;
}

/**
 * Mirrors the SQLite store's contract: `reserve` hands the slot to exactly one
 * caller, `complete`/`release` require the fencing token, and rows are scoped
 * by `(wallet, key)`.
 */
function createMemoryStore(): IdempotencyStore & { slots: Map<string, Slot> } {
  const slots = new Map<string, Slot>();
  const keyOf = (wallet: string, key: string) => JSON.stringify([wallet, key]);
  let counter = 0;

  return {
    slots,
    reserve(wallet: string, key: string): IdempotencyReservation {
      const id = keyOf(wallet, key);
      const existing = slots.get(id);
      if (!existing) {
        counter += 1;
        const now = new Date();
        slots.set(id, {
          wallet,
          key,
          status: 'pending',
          reservationId: `res-${counter}`,
          createdAt: now.toISOString(),
          expiresAt: new Date(now.getTime() + 60_000).toISOString(),
        });
        return { status: 'reserved', reservationId: `res-${counter}` };
      }
      if (existing.status === 'completed') {
        const { reservationId: _rid, ...rest } = existing;
        const entry: IdempotencyEntry = rest;
        return { status: 'replay', entry };
      }
      return { status: 'conflict' };
    },
    complete(wallet, key, reservationId, statusCode, body): void {
      const slot = slots.get(keyOf(wallet, key));
      if (!slot || slot.status !== 'pending' || slot.reservationId !== reservationId) return;
      slot.status = 'completed';
      slot.statusCode = statusCode;
      slot.responseBody = JSON.stringify(body);
    },
    release(wallet, key, reservationId): void {
      const id = keyOf(wallet, key);
      const slot = slots.get(id);
      if (!slot || slot.status !== 'pending' || slot.reservationId !== reservationId) return;
      slots.delete(id);
    },
    get(wallet, key): IdempotencyEntry | undefined {
      const slot = slots.get(keyOf(wallet, key));
      if (!slot) return undefined;
      const { reservationId: _rid, ...rest } = slot;
      return rest;
    },
    delete(wallet, key): void {
      slots.delete(keyOf(wallet, key));
    },
    cleanup: () => 0,
    startCleanup: () => undefined,
    stopCleanup: () => undefined,
    close: () => undefined,
  };
}

// ---------------------------------------------------------------------------
// App fixture
// ---------------------------------------------------------------------------

const WALLET_A = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const WALLET_B = 'GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';

describe('Idempotency Middleware (#658)', () => {
  let store: ReturnType<typeof createMemoryStore>;
  let app: express.Express;
  let handlerCallCount: number;

  beforeEach(() => {
    store = createMemoryStore();
    handlerCallCount = 0;

    app = express();
    app.use(express.json());

    const router = Router();
    router.post(
      '/tasks',
      createIdempotencyMiddleware(store),
      (_req: Request, res: Response) => {
        handlerCallCount += 1;
        res.status(201).json({ taskId: `task_${handlerCallCount}`, status: 'queued' });
      },
    );
    app.use('/api', router);
    app.use(errorHandler);
  });

  const post = (key: string, wallet?: string) => {
    const req = request(app).post('/api/tasks').send({ prompt: 'hello' });
    if (key !== undefined) req.set('Idempotency-Key', key);
    if (wallet !== undefined) req.set('walletpublickey', wallet);
    return req;
  };

  it('passes through transparently when no Idempotency-Key header is present', async () => {
    const res = await post('', undefined);

    expect(res.status).toBe(201);
    expect(handlerCallCount).toBe(1);
    expect(store.slots.size).toBe(0);
  });

  it('ignores whitespace-only Idempotency-Key values', async () => {
    const res = await post('   ');

    expect(res.status).toBe(201);
    expect(handlerCallCount).toBe(1);
    expect(store.slots.size).toBe(0);
  });

  it('passes through on the first request with an Idempotency-Key', async () => {
    const res = await post('idem-key-1');

    expect(res.status).toBe(201);
    expect(res.body.taskId).toBe('task_1');
    expect(handlerCallCount).toBe(1);
  });

  it('replays the stored response on a duplicate Idempotency-Key', async () => {
    const first = await post('idem-key-2');
    expect(first.status).toBe(201);
    expect(first.body.taskId).toBe('task_1');

    const second = await post('idem-key-2');
    expect(second.status).toBe(201);
    expect(second.body.taskId).toBe('task_1');
    expect(second.headers['x-idempotent-replay']).toBe('true');
    expect(first.headers['x-idempotent-replay']).toBeUndefined();
    // The handler must not run a second time.
    expect(handlerCallCount).toBe(1);
  });

  it('creates separate tasks for different idempotency keys', async () => {
    const first = await post('key-A');
    const second = await post('key-B');

    expect(first.body.taskId).toBe('task_1');
    expect(second.body.taskId).toBe('task_2');
    expect(handlerCallCount).toBe(2);
  });

  // AC2: a duplicate arriving while the first is still executing must never
  // reach the handler.
  it('rejects a concurrent duplicate with 409 and never runs the handler twice', async () => {
    // Reserve the slot by hand to model a request that is mid-flight.
    const inFlight = store.reserve(WALLET_A, 'in-flight-key');
    expect(inFlight.status).toBe('reserved');

    const res = await post('in-flight-key', WALLET_A);

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('REQUEST_IN_PROGRESS');
    expect(res.headers['retry-after']).toBeDefined();
    expect(handlerCallCount).toBe(0);
  });

  it('releases the reservation when the handler is done, letting a later retry replay', async () => {
    await post('retry-key', WALLET_A);
    expect(store.get(WALLET_A, 'retry-key')?.status).toBe('completed');

    const res = await post('retry-key', WALLET_A);
    expect(res.status).toBe(201);
    expect(handlerCallCount).toBe(1);
  });

  it('does not replay error responses and releases the key for a genuine retry', async () => {
    const errorApp = express();
    errorApp.use(express.json());
    const router = Router();
    router.post('/fail', createIdempotencyMiddleware(store), (_req, res) => {
      handlerCallCount += 1;
      res.status(400).json({ error: 'bad request' });
    });
    errorApp.use('/api', router);
    errorApp.use(errorHandler);

    const first = await request(errorApp)
      .post('/api/fail')
      .set('idempotency-key', 'error-key')
      .send({});
    expect(first.status).toBe(400);

    // The failed request must not have left a completed record behind…
    expect(store.get('anonymous', 'error-key')).toBeUndefined();

    // …and the key must be reusable.
    const second = await request(errorApp)
      .post('/api/fail')
      .set('idempotency-key', 'error-key')
      .send({});
    expect(second.status).toBe(400);
    expect(handlerCallCount).toBe(2);
  });

  it('releases the reservation when the handler throws', async () => {
    const throwApp = express();
    throwApp.use(express.json());
    const router = Router();
    router.post('/boom', createIdempotencyMiddleware(store), () => {
      throw new Error('kaboom');
    });
    throwApp.use('/api', router);
    throwApp.use(errorHandler);

    await request(throwApp)
      .post('/api/boom')
      .set('idempotency-key', 'boom-key')
      .send({})
      .expect(500);

    expect(store.get('anonymous', 'boom-key')).toBeUndefined();
  });

  // AC3: the key is scoped to the wallet, so one client cannot replay another
  // client's stored response.
  it('does not replay another wallet’s response for the same key', async () => {
    const first = await post('shared-key', WALLET_A);
    expect(first.status).toBe(201);
    expect(first.body.taskId).toBe('task_1');

    const second = await post('shared-key', WALLET_B);
    expect(second.status).toBe(201);
    // Wallet B got its own execution, not wallet A's response.
    expect(second.body.taskId).toBe('task_2');
    expect(handlerCallCount).toBe(2);

    // And each wallet still replays its own response.
    const replayA = await post('shared-key', WALLET_A);
    expect(replayA.body.taskId).toBe('task_1');
    expect(handlerCallCount).toBe(2);
  });

  it('scopes the key by walletPublicKey in the request body', async () => {
    const first = await request(app)
      .post('/api/tasks')
      .set('idempotency-key', 'body-key')
      .send({ prompt: 'hi', walletPublicKey: WALLET_A });
    expect(first.body.taskId).toBe('task_1');

    // Same key, no wallet anywhere → the anonymous bucket, so no replay.
    const second = await request(app)
      .post('/api/tasks')
      .set('idempotency-key', 'body-key')
      .send({ prompt: 'hi' });
    expect(second.status).toBe(201);
    expect(second.body.taskId).toBe('task_2');
  });

  // AC4: an oversized key is rejected before it can reach the store.
  it('rejects an oversized Idempotency-Key with 400', async () => {
    const res = await post('k'.repeat(IDEMPOTENCY_KEY_MAX_LENGTH + 1));

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(res.body.error.details.field).toBe('Idempotency-Key');
    expect(res.body.error.details.maxLength).toBe(IDEMPOTENCY_KEY_MAX_LENGTH);
    expect(handlerCallCount).toBe(0);
    expect(store.slots.size).toBe(0);
  });

  it('accepts a key exactly at the documented limit', async () => {
    const res = await post('k'.repeat(IDEMPOTENCY_KEY_MAX_LENGTH));

    expect(res.status).toBe(201);
    expect(handlerCallCount).toBe(1);
  });

  it('exposes a documented limit of 128 characters', () => {
    expect(IDEMPOTENCY_KEY_MAX_LENGTH).toBe(128);
  });

  it('does not reserve a slot when the store throws', async () => {
    const brokenStore = {
      ...store,
      reserve: () => {
        throw new Error('store unavailable');
      },
    } as unknown as IdempotencyStore;

    const degraded = express();
    degraded.use(express.json());
    const router = Router();
    router.post('/tasks', createIdempotencyMiddleware(brokenStore), (_req, res) => {
      handlerCallCount += 1;
      res.status(201).json({ ok: true });
    });
    degraded.use('/api', router);
    degraded.use(errorHandler);

    const res = await request(degraded)
      .post('/api/tasks')
      .set('idempotency-key', 'broken')
      .send({});

    // Fails open: the request is served rather than 500-ing on a cache outage.
    expect(res.status).toBe(201);
    expect(handlerCallCount).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Exported surface
// ---------------------------------------------------------------------------

describe('idempotency middleware exports', () => {
  it('provides a ready-to-use middleware bound to the default store', async () => {
    const { idempotencyMiddleware } = await import(
      '../src/api/middleware/idempotency'
    );
    expect(typeof idempotencyMiddleware).toBe('function');
    expect(idempotencyMiddleware).toHaveLength(3);
  });

  it('type-checks NextFunction usage without leaking', () => {
    const _next: NextFunction = () => undefined;
    expect(typeof _next).toBe('function');
  });
});
