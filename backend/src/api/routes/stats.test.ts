import express from 'express';
import type { AddressInfo } from 'net';
import Database from 'better-sqlite3';
import { createStatsRouter } from './stats';
import type { DbClient } from '../../db/stats';

function createTestDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE agents (id TEXT PRIMARY KEY);
    CREATE TABLE tasks (id TEXT PRIMARY KEY, status TEXT NOT NULL, "createdAt" TEXT NOT NULL);
    CREATE TABLE payments (id TEXT PRIMARY KEY, amount REAL NOT NULL, status TEXT NOT NULL, "createdAt" TEXT NOT NULL);
  `);
  return db;
}

describe('Stats API route', () => {
  it('returns 200 and reuses cached stats for two requests within TTL', async () => {
    const db = createTestDb();
    
    // Add mock data
    db.prepare('INSERT INTO agents (id) VALUES (?)').run('agent_1');
    db.prepare('INSERT INTO tasks (id, status, "createdAt") VALUES (?, ?, ?)').run('task_1', 'completed', new Date().toISOString());
    db.prepare('INSERT INTO payments (id, amount, status, "createdAt") VALUES (?, ?, ?, ?)').run('p1', 10000000, 'released', new Date().toISOString());

    // Spy on db.prepare to count invocations (6 queries in getStats)
    const prepareSpy = jest.spyOn(db, 'prepare');

    const app = express();
    app.use('/api/stats', createStatsRouter(db));

    const server = app.listen(0);
    const address = server.address() as AddressInfo;
    const baseUrl = `http://127.0.0.1:${address.port}`;

    const firstResponse = await fetch(`${baseUrl}/api/stats`);
    const firstJson = await firstResponse.json();

    const secondResponse = await fetch(`${baseUrl}/api/stats`);
    const secondJson = await secondResponse.json();

    server.close();
    db.close();

    expect(firstResponse.status).toBe(200);
    expect(secondResponse.status).toBe(200);
    expect(firstJson).toEqual(secondJson);
    
    // getStats executes 6 queries. If cached, it should still be 6.
    expect(prepareSpy).toHaveBeenCalledTimes(6);
  });
});
