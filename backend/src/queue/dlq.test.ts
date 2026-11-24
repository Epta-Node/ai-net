/**
 * Unit tests for the dead-letter queue facade (Issues #802 and #739).
 *
 * Runs against real SQLite (the default Jest project wires the native
 * `better-sqlite3` addon; see `backend/jest.config.js`).
 */

import Database from 'better-sqlite3';
import { createJobStore, type Job, type JobStore } from './jobStore';
import { DeadLetterQueue, createDeadLetterQueue } from './dlq';

jest.mock('../coordinator/eventBus', () => ({
  eventBus: { emit: jest.fn() },
}));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const eventBusModule = require('../coordinator/eventBus') as { eventBus: { emit: jest.Mock } };

function makeJob(overrides: Partial<Job> = {}): Job {
  return {
    id: 'job_1',
    taskId: 'task_1',
    type: 'execute_task',
    status: 'pending',
    priority: 'normal',
    attempts: 0,
    maxAttempts: 3,
    payload: { taskId: 'task_1' },
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  } as Job;
}

function insertJob(store: JobStore, taskId: string): Job {
  const job = makeJob({ id: `job_${taskId}`, taskId });
  store.insert(job);
  return job;
}

describe('DeadLetterQueue (Issues #802/#739)', () => {
  let db: Database.Database;
  let store: JobStore;
  let dlq: DeadLetterQueue;

  beforeEach(() => {
    jest.clearAllMocks();
    db = new Database(':memory:');
    store = createJobStore(db);
    dlq = createDeadLetterQueue(store);
  });

  afterEach(() => {
    db.close();
  });

  describe('push', () => {
    it('parks a pending job, stamps the failure and emits the event', () => {
      const job = insertJob(store, 'task_1');

      const moved = dlq.push(job, new Error('venice 500'), { attempts: 3, maxAttempts: 3 });

      expect(moved).toBe(true);
      const stored = store.findById(job.id)!;
      expect(stored.status).toBe('dead-letter');
      expect(stored.lastError).toContain('max attempts exceeded (3/3): venice 500');
      expect(stored.failedAt).toBeDefined();
      expect(eventBusModule.eventBus.emit).toHaveBeenCalledWith(
        'task_1',
        expect.objectContaining({ type: 'job.dead_lettered', taskId: 'task_1' })
      );
    });

    it('is a no-op when the job already completed', () => {
      const job = insertJob(store, 'task_2');
      store.updateStatus(job.id, 'completed');

      const moved = dlq.push(job, 'too late');

      expect(moved).toBe(false);
      expect(store.findById(job.id)!.status).toBe('completed');
      expect(eventBusModule.eventBus.emit).not.toHaveBeenCalled();
    });

    it('does not emit twice when the job is already parked', () => {
      const job = insertJob(store, 'task_3');
      dlq.push(job, 'first', { attempts: 3, maxAttempts: 3 });
      const second = dlq.push(job, 'second', { attempts: 4, maxAttempts: 3 });

      expect(second).toBe(false);
      expect(eventBusModule.eventBus.emit).toHaveBeenCalledTimes(1);
    });
  });

  describe('list', () => {
    it('pages parked jobs', () => {
      for (let i = 0; i < 3; i++) {
        const job = insertJob(store, `task_${i}`);
        dlq.push(job, 'boom', { attempts: 3, maxAttempts: 3 });
      }

      const page = dlq.list({ page: 1, pageSize: 2 });
      expect(page.total).toBe(3);
      expect(page.deadLetters).toHaveLength(2);
      expect(page.deadLetters[0]).toMatchObject({
        taskId: expect.stringMatching(/^task_/),
        failureReason: expect.stringContaining('max attempts exceeded'),
        retryCount: 3,
      });
    });

    it('reports an empty page for a fresh store', () => {
      expect(dlq.list()).toEqual({ deadLetters: [], total: 0, page: 1, pageSize: 50 });
    });
  });

  describe('replay', () => {
    it('requeues a parked job with a fresh retry budget', () => {
      const job = insertJob(store, 'task_r');
      dlq.push(job, 'boom', { attempts: 3, maxAttempts: 3 });

      expect(dlq.replay(job.id)).toBe(true);

      const stored = store.findById(job.id)!;
      expect(stored.status).toBe('pending');
      expect(stored.attempts).toBe(0);
      expect(stored.lastError).toBeNull();
      expect(dlq.list().total).toBe(0);
    });

    it('is idempotent: the second replay is a no-op', () => {
      const job = insertJob(store, 'task_r2');
      dlq.push(job, 'boom', { attempts: 3, maxAttempts: 3 });

      expect(dlq.replay(job.id)).toBe(true);
      expect(dlq.replay(job.id)).toBe(false);
      expect(dlq.list().total).toBe(0);
    });

    it('returns false for an unknown job', () => {
      expect(dlq.replay('job_missing')).toBe(false);
    });
  });

  describe('purge', () => {
    it('deletes only entries older than the cutoff', () => {
      const old = insertJob(store, 'task_old');
      const fresh = insertJob(store, 'task_new');
      dlq.push(old, 'boom', { attempts: 3, maxAttempts: 3 });
      dlq.push(fresh, 'boom', { attempts: 3, maxAttempts: 3 });
      // Age the first entry two days into the past.
      db.prepare('UPDATE jobs SET failedAt = ? WHERE id = ?').run(
        new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString(),
        old.id
      );

      expect(dlq.purge(1)).toBe(1);
      expect(store.findById(old.id)).toBeUndefined();
      expect(store.findById(fresh.id)).toBeDefined();
    });

    it('purges everything with days = 0', () => {
      for (let i = 0; i < 4; i++) {
        const job = insertJob(store, `task_all_${i}`);
        dlq.push(job, 'boom', { attempts: 3, maxAttempts: 3 });
      }
      expect(dlq.purge(0)).toBe(4);
      expect(dlq.list().total).toBe(0);
    });

    it('returns 0 when nothing matches', () => {
      expect(dlq.purge(30)).toBe(0);
    });
  });

  describe('count', () => {
    it('reports the number of parked entries', () => {
      expect(dlq.count()).toBe(0);
      const job = insertJob(store, 'task_count');
      dlq.push(job, 'boom', { attempts: 3, maxAttempts: 3 });
      expect(dlq.count()).toBe(1);
    });
  });
});
