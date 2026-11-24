import Database from 'better-sqlite3';
import path from 'path';
import { createAgentDb } from '../../src/db/agents';
import { createTaskDb } from '../../src/db/tasks';
import { migrateToLatest } from '../../src/db/migrator';

// This suite deliberately uses the real SQLite project, not the default stub.
describe('bounded registry and history reads', () => {
  let raw: Database.Database;
  beforeEach(() => { raw = new Database(':memory:'); });
  afterEach(() => { raw.close(); });

  it('pages through 10,000 agents without omissions, including tied timestamps', () => {
    const db = createAgentDb(raw);
    raw.transaction(() => {
      for (let i = 0; i < 10_000; i++) {
        db.upsert({
          id: `agent-${String(i).padStart(5, '0')}`, capabilities: ['research'],
          pricingXLM: 1, endpoint: 'https://example.test', stellarPublicKey: 'GTEST',
          reputationScore: 3, lastSeenAt: '2026-09-28T00:00:00Z', status: 'online',
        });
      }
    })();
    expect(db.list()).toHaveLength(20);
    expect(db.list({ limit: 100 })).toEqual(db.listCursor({ limit: 100 }).items);
    const seen = new Set<string>();
    let cursor: string | undefined;
    do {
      const page = db.listCursor({ cursor, limit: 100, capability: 'research', status: 'online' });
      expect(page.items).toHaveLength(100);
      for (const agent of page.items) {
        expect(seen.has(agent.id)).toBe(false);
        seen.add(agent.id);
      }
      cursor = page.nextCursor;
    } while (cursor);
    expect(seen.size).toBe(10_000);
    expect(db.listCursor({ capability: 'missing' })).toEqual({ items: [] });
    for (const limit of [-1, 0, 101, 1.5, NaN, Infinity]) {
      expect(() => db.list({ limit })).toThrow('limit');
    }
    expect(() => db.listCursor({ cursor: 'invalid' })).toThrow('cursor');
  });

  it('returns bounded pages for 100,000 events and reaches the entire history', () => {
    migrateToLatest(raw, path.join(__dirname, '../../src/db/migrations/tasks'));
    const db = createTaskDb(raw);
    const insert = raw.prepare(`INSERT INTO task_events
      (task_seq, task_id, type, occurred_at, payload) VALUES (?, ?, 'node_completed', ?, ?)`);
    raw.transaction(() => {
      for (let i = 0; i < 100_000; i++) {
        insert.run(i, 'long-task', '2026-09-28T00:00:00Z', JSON.stringify({ sequence: i }));
      }
      insert.run(1, 'other-task', '2026-09-28T00:00:00Z', '{}');
    })();
    const prepare = jest.spyOn(raw, 'prepare');
    expect(db.getEventHistory('long-task').items).toHaveLength(100);
    expect(prepare.mock.calls[0][0]).toMatch(/SELECT task_seq, task_id, type, node_id, payload, occurred_at/);
    expect(prepare.mock.calls[0][0]).toMatch(/LIMIT \?/);
    prepare.mockRestore();
    let afterId = -1;
    let count = 0;
    while (true) {
      const page = db.getEventHistory('long-task', { afterId, limit: 100 });
      expect(page.items).toHaveLength(100);
      for (const event of page.items) {
        count++;
        expect(event.taskId).toBe('long-task');
        expect(event.payload).toEqual({ sequence: count - 1 });
      }
      if (page.nextCursor === null) break;
      expect(page.nextCursor).toBe(count - 1);
      afterId = page.nextCursor;
    }
    expect(count).toBe(100_000);
    expect(db.getEventHistory('missing')).toEqual({ items: [], nextCursor: null });
    expect(db.getEventHistory('long-task', { afterId: 100_000 })).toEqual({ items: [], nextCursor: null });
    for (const limit of [-1, 0, 101, 1.5, NaN, Infinity]) {
      expect(() => db.getEventHistory('long-task', { limit })).toThrow('limit');
    }
    for (const afterId of [-2, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => db.getEventHistory('long-task', { afterId })).toThrow('afterId');
    }
  });

  it('supports a single event per page and interleaved tasks', () => {
    migrateToLatest(raw, path.join(__dirname, '../../src/db/migrations/tasks'));
    const db = createTaskDb(raw);
    const timestamp = '2026-09-28T00:00:00Z';
    db.insertEvent({ taskId: 'a', type: 'start', timestamp });
    db.insertEvent({ taskId: 'b', type: 'start', timestamp });
    db.insertEvent({ taskId: 'a', type: 'done', timestamp });
    const first = db.getEventHistory('a', { limit: 1 });
    expect(first.items.map(event => event.type)).toEqual(['start']);
    const last = db.getEventHistory('a', { limit: 1, afterId: first.nextCursor! });
    expect(last.items.map(event => event.type)).toEqual(['done']);
    expect(last.nextCursor).toBeNull();
  });
});
