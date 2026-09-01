import request from 'supertest';
import Database from 'better-sqlite3';
import { createIdempotencyStore, type IdempotencyStore } from '../src/services/idempotency';
import { createIdempotencyMiddleware } from '../src/api/middleware/idempotency';
import express, { Router, Request, Response } from 'express';

// ---------------------------------------------------------------------------
// Idempotency Store unit tests
// ---------------------------------------------------------------------------

describe('IdempotencyStore', () => {
  let store: IdempotencyStore;
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    store = createIdempotencyStore(db, { cleanupIntervalMs: 0 });
  });

  afterEach(() => {
    store.close();
  });

  describe('get / storeResponse', () => {
    it('returns undefined for a key that has never been stored', () => {
      expect(store.get('nonexistent')).toBeUndefined();
    });

    it('stores and retrieves a response', () => {
      const body = { taskId: 'task_abc', status: 'queued' };
      store.storeResponse('key-1', 201, body);

      const entry = store.get('key-1');
      expect(entry).toBeDefined();
      expect(entry!.key).toBe('key-1');
      expect(entry!.statusCode).toBe(201);
      expect(JSON.parse(entry!.responseBody)).toEqual(body);
    });

    it('does not overwrite an existing key (INSERT OR IGNORE)', () => {
      store.storeResponse('key-1', 201, { first: true });
      store.storeResponse('key-1', 200, { second: true });

      const entry = store.get('key-1');
      expect(entry).toBeDefined();
      expect(entry!.statusCode).toBe(201);
      expect(JSON.parse(entry!.responseBody)).toEqual({ first: true });
    });

    it('different keys store independently', () => {
      store.storeResponse('key-a', 201, { a: 1 });
      store.storeResponse('key-b', 200, { b: 2 });

      expect(store.get('key-a')!.statusCode).toBe(201);
      expect(store.get('key-b')!.statusCode).toBe(200);
    });
  });

  describe('TTL expiry', () => {
    it('returns undefined for an entry that has expired', () => {
      // Create a store with a 1ms TTL so it expires almost immediately.
      const shortStore = createIdempotencyStore(db, {
        ttlMs: 1,
        cleanupIntervalMs: 0,
      });

      shortStore.storeResponse('ephemeral', 200, { ok: true });

      // Wait just long enough for the TTL to expire.
      const start = Date.now();
      while (Date.now() - start < 5) {
        // busy wait
      }

      expect(shortStore.get('ephemeral')).toBeUndefined();
      shortStore.stopCleanup();
    });
  });

  describe('cleanup', () => {
    it('removes expired entries and returns the count', () => {
      // Use a 1ms TTL so entries expire immediately.
      const shortStore = createIdempotencyStore(db, {
        ttlMs: 1,
        cleanupIntervalMs: 0,
      });

      shortStore.storeResponse('exp-1', 200, {});
      shortStore.storeResponse('exp-2', 201, {});

      // Wait for expiry.
      const start = Date.now();
      while (Date.now() - start < 5) {
        // busy wait
      }

      const deleted = shortStore.cleanup();
      expect(deleted).toBe(2);

      expect(shortStore.get('exp-1')).toBeUndefined();
      expect(shortStore.get('exp-2')).toBeUndefined();
      shortStore.stopCleanup();
    });

    it('does not remove non-expired entries', () => {
      store.storeResponse('still-good', 200, {});
      const deleted = store.cleanup();
      expect(deleted).toBe(0);
      expect(store.get('still-good')).toBeDefined();
    });
  });

  describe('delete', () => {
    it('removes a single entry', () => {
      store.storeResponse('to-delete', 200, {});
      expect(store.get('to-delete')).toBeDefined();

      store.delete('to-delete');
      expect(store.get('to-delete')).toBeUndefined();
    });
  });

  describe('startCleanup / stopCleanup', () => {
    it('starts and stops without throwing', () => {
      store.startCleanup();
      store.startCleanup(); // idempotent
      store.stopCleanup();
      store.stopCleanup(); // idempotent
    });
  });
});

// ---------------------------------------------------------------------------
// Idempotency Middleware integration tests
// ---------------------------------------------------------------------------

describe('Idempotency Middleware', () => {
  let db: Database.Database;
  let store: IdempotencyStore;
  let app: express.Express;
  let handlerCallCount: number;

  beforeEach(() => {
    db = new Database(':memory:');
    store = createIdempotencyStore(db, { cleanupIntervalMs: 0 });
    handlerCallCount = 0;

    app = express();
    app.use(express.json());

    const testRouter = Router();
    testRouter.post(
      '/tasks',
      createIdempotencyMiddleware(store),
      (_req: Request, res: Response) => {
        handlerCallCount += 1;
        res.status(201).json({ taskId: `task_${handlerCallCount}`, status: 'queued' });
      },
    );

    app.use('/api', testRouter);
  });

  afterEach(() => {
    store.close();
  });

  it('passes through transparently when no Idempotency-Key header is present', async () => {
    const res = await request(app)
      .post('/api/tasks')
      .send({ prompt: 'hello' });

    expect(res.status).toBe(201);
    expect(res.body.taskId).toMatch(/^task_/);
    expect(handlerCallCount).toBe(1);
  });

  it('passes through on the first request with an Idempotency-Key', async () => {
    const res = await request(app)
      .post('/api/tasks')
      .set('Idempotency-Key', 'idem-key-1')
      .send({ prompt: 'hello' });

    expect(res.status).toBe(201);
    expect(res.body.taskId).toBe('task_1');
    expect(handlerCallCount).toBe(1);
  });

  it('replays the stored response on a duplicate Idempotency-Key', async () => {
    // First request — creates the task.
    const first = await request(app)
      .post('/api/tasks')
      .set('idempotency-key', 'idem-key-2')
      .send({ prompt: 'hello' });

    expect(first.status).toBe(201);
    expect(first.body.taskId).toBe('task_1');
    expect(handlerCallCount).toBe(1);

    // Second request with the same key — should replay, not create.
    const second = await request(app)
      .post('/api/tasks')
      .set('idempotency-key', 'idem-key-2')
      .send({ prompt: 'hello' });

    expect(second.status).toBe(201);
    expect(second.body.taskId).toBe('task_1'); // same as first
    expect(handlerCallCount).toBe(1); // handler NOT called again
  });

  it('creates separate tasks for different idempotency keys', async () => {
    const first = await request(app)
      .post('/api/tasks')
      .set('idempotency-key', 'key-A')
      .send({ prompt: 'task A' });

    const second = await request(app)
      .post('/api/tasks')
      .set('idempotency-key', 'key-B')
      .send({ prompt: 'task B' });

    expect(first.body.taskId).toBe('task_1');
    expect(second.body.taskId).toBe('task_2');
    expect(handlerCallCount).toBe(2);
  });

  it('does not replay error responses (4xx/5xx)', async () => {
    // Create a route that returns a 400 error.
    const errorApp = express();
    errorApp.use(express.json());
    const errorRouter = Router();
    errorRouter.post(
      '/fail',
      createIdempotencyMiddleware(store),
      (_req: Request, res: Response) => {
        handlerCallCount += 1;
        res.status(400).json({ error: 'bad request' });
      },
    );
    errorApp.use('/api', errorRouter);

    const first = await request(errorApp)
      .post('/api/fail')
      .set('idempotency-key', 'error-key')
      .send({});

    expect(first.status).toBe(400);
    expect(handlerCallCount).toBe(1);

    // Second request should NOT be replayed from cache — it should hit the handler again.
    const second = await request(errorApp)
      .post('/api/fail')
      .set('idempotency-key', 'error-key')
      .send({});

    expect(second.status).toBe(400);
    expect(handlerCallCount).toBe(2); // handler called again
  });

  it('ignores whitespace-only Idempotency-Key values', async () => {
    const res = await request(app)
      .post('/api/tasks')
      .set('idempotency-key', '   ')
      .send({ prompt: 'hello' });

    expect(res.status).toBe(201);
    expect(handlerCallCount).toBe(1);
  });
});
