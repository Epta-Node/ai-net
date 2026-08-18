import Database from 'better-sqlite3';
import { getStats } from './stats';

const now = new Date('2026-06-17T12:00:00.000Z');

function createTestDb() {
  const db = new Database(':memory:');
  
  db.exec(`
    CREATE TABLE agents (id TEXT PRIMARY KEY);
    CREATE TABLE tasks (
      id TEXT PRIMARY KEY,
      status TEXT NOT NULL,
      "createdAt" TEXT NOT NULL
    );
    CREATE TABLE payments (
      id TEXT PRIMARY KEY,
      amount REAL NOT NULL,
      status TEXT NOT NULL,
      "createdAt" TEXT NOT NULL
    );
  `);

  return db;
}

describe('getStats', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb();
  });

  afterEach(() => {
    db.close();
  });

  it('builds 24 hourly points and computes uptime and XLM transacted precisely', async () => {
    // Insert 15 agents
    const insertAgent = db.prepare('INSERT INTO agents (id) VALUES (?)');
    for (let i = 0; i < 15; i++) {
      insertAgent.run(`agent_${i}`);
    }

    // Insert 154 total tasks. We need 10 tasks in the last 7 days for uptime,
    // and specific tasks in the last 24h for tasksLast24h.
    
    // For uptime (last 7 days): we want 10 total, 8 'completed'.
    // The query checks createdAt >= '2026-06-10T12:00:00.000Z'
    // We also need tasks for the 24h hourly buckets:
    // 2 at 2026-06-16T13:XX:XX
    // 3 at 2026-06-16T17:XX:XX
    // 4 at 2026-06-17T12:XX:XX
    // Total in last 7 days is 9 tasks from the hourly buckets. So we can add 1 more to make it 10.
    // Of these 10, 8 should be 'completed'.
    
    const insertTask = db.prepare('INSERT INTO tasks (id, status, "createdAt") VALUES (?, ?, ?)');
    
    let taskId = 0;
    const addTasks = (count: number, status: string, time: string) => {
      for (let i = 0; i < count; i++) {
        insertTask.run(`task_${taskId++}`, status, time);
      }
    };

    // 2 at 2026-06-16T13:XX:XX
    addTasks(2, 'completed', '2026-06-16T13:15:00.000Z');
    // 3 at 2026-06-16T17:XX:XX
    addTasks(3, 'completed', '2026-06-16T17:30:00.000Z');
    // 4 at 2026-06-17T12:XX:XX
    addTasks(3, 'completed', '2026-06-17T12:10:00.000Z');
    addTasks(1, 'failed', '2026-06-17T12:15:00.000Z'); // 1 failed
    
    // Now we have 9 tasks in the last 7 days. Add 1 more failed task within the last 7 days.
    addTasks(1, 'failed', '2026-06-15T12:00:00.000Z');
    
    // Now we have 10 tasks in the last 7 days, 8 completed, 2 failed.
    // Total tasks so far: 10. We need 154 total. So add 144 old tasks (> 7 days ago).
    addTasks(144, 'completed', '2026-01-01T00:00:00.000Z');

    // Total XLM Transacted: 12.3456789 -> 123456789 stroops
    // For xlmLast24h:
    // 2026-06-16T13:00:00.000Z -> 15_000_000
    // 2026-06-16T17:00:00.000Z -> 5_000_000
    // 2026-06-17T12:00:00.000Z -> 10_000_000
    // These sum to 30_000_000 stroops. We need 93_456_789 more for the old payments to reach 123_456_789.
    
    const insertPayment = db.prepare('INSERT INTO payments (id, amount, status, "createdAt") VALUES (?, ?, ?, ?)');
    insertPayment.run('p1', 15_000_000, 'released', '2026-06-16T13:15:00.000Z');
    insertPayment.run('p2', 5_000_000, 'released', '2026-06-16T17:30:00.000Z');
    insertPayment.run('p3', 10_000_000, 'released', '2026-06-17T12:10:00.000Z');
    insertPayment.run('p4', 93_456_789, 'released', '2026-01-01T00:00:00.000Z');

    const stats = await getStats(db, now);

    expect(stats.totalAgents).toBe(15);
    expect(stats.totalTasks).toBe(154);
    expect(stats.uptimePercent).toBe(80);
    expect(stats.totalXLMTransacted).toBe(12.3456789);
    expect(stats.tasksLast24h).toHaveLength(24);
    expect(stats.xlmLast24h).toHaveLength(24);
    expect(stats.tasksLast24h[0].timestamp).toBe('2026-06-16T13:00:00.000Z');
    expect(stats.tasksLast24h[0].value).toBe(2);
    expect(stats.tasksLast24h[4].value).toBe(3);
    expect(stats.tasksLast24h[23].value).toBe(4);
    expect(stats.xlmLast24h[0].value).toBe(1.5);
    expect(stats.xlmLast24h[4].value).toBe(0.5);
    expect(stats.xlmLast24h[23].value).toBe(1);
  });

  it('returns 100 uptime percent when no tasks exist in the last 7 days', async () => {
    // Leave db empty
    const stats = await getStats(db, now);
    expect(stats.uptimePercent).toBe(100);
  });
});
