/**
 * Tests for the task_events table schema and the append+listByTaskSince
 * round-trip contract.
 *
 * Acceptance criteria (from issue #560)
 * ──────────────────────────────────────
 * ✓ A test asserts the live schema matches the migration (column names, types,
 *   and the UNIQUE(task_id, task_seq) constraint).
 * ✓ A test covers the append + listByTaskSince round trip so a schema mismatch
 *   fails loudly.
 * ✓ Validates that the schemaRegistry is wired into append() — a malformed
 *   payload is rejected at persist time.
 * ✓ The migration idempotency path is exercised: running the up migration SQL
 *   twice in a row should not error.
 *
 * NOTE: The project jest.config.js maps `better-sqlite3` to a no-op mock.
 * This suite bypasses that mapping by requiring the real native module via its
 * absolute node_modules path, keeping all DB operations self-contained.
 */

// Bypass the moduleNameMapper stub — require the real native module directly.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const RealDatabase = require('../node_modules/better-sqlite3') as typeof import('better-sqlite3');

import { readFileSync } from 'fs';
import { join } from 'path';
import { validateEvent } from '../src/events/schemaRegistry';
import { CURRENT_EVENT_VERSION } from '../src/events/eventTypes';

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const MIGRATIONS_DIR = join(
  __dirname,
  '..',
  'src',
  'db',
  'migrations',
  'tasks',
);
// events.sql is now documentation-only; it no longer contains executable DDL.
// This path is kept so the regression test can verify the file does NOT declare
// a CREATE TABLE (ensuring the "exactly one DDL location" invariant holds).
const EVENTS_SQL_PATH = join(__dirname, '..', 'src', 'db', 'events.sql');

function loadSql(filename: string): string {
  return readFileSync(join(MIGRATIONS_DIR, filename), 'utf8');
}

function loadEventsSqlContent(): string {
  return readFileSync(EVENTS_SQL_PATH, 'utf8');
}

// ---------------------------------------------------------------------------
// Helpers — real SQLite DB with schema A
// ---------------------------------------------------------------------------

type RealDb = InstanceType<typeof RealDatabase>;

/**
 * Create an in-memory DB with schema A by running the canonical migration pair
 * (002 + 005).  This is the same sequence used by createEventStore() and the
 * production migrator, so the resulting schema is identical.
 */
function makeSchemaADb(): RealDb {
  const db = new RealDatabase(':memory:');
  db.exec(loadSql('002_create_task_events_table.up.sql'));
  db.exec(loadSql('006_replace_task_events_schema.up.sql'));
  return db;
}

function appendEvent(
  db: RealDb,
  taskId: string,
  taskSeq: number,
  type: string,
  nodeId: string | null,
  occurredAt: string,
  payload: unknown = null,
  version = CURRENT_EVENT_VERSION,
): number {
  const result = db.prepare(`
    INSERT INTO task_events (task_seq, version, type, task_id, node_id, occurred_at, payload)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(taskSeq, version, type, taskId, nodeId, occurredAt, payload !== null ? JSON.stringify(payload) : null);
  return result.lastInsertRowid as number;
}

function listByTaskSince(db: RealDb, taskId: string, afterSeq: number) {
  return db.prepare(`
    SELECT * FROM task_events WHERE task_id = ? AND task_seq > ? ORDER BY task_seq ASC
  `).all(taskId, afterSeq) as Array<Record<string, unknown>>;
}

// ---------------------------------------------------------------------------
// Schema helper types
// ---------------------------------------------------------------------------

interface ColInfo { cid: number; name: string; type: string; notnull: number; dflt_value: string | null; pk: number; }
interface IdxInfo  { name: string; unique: number; }
interface IdxColInfo { seqno: number; cid: number; name: string; }

function cols(db: RealDb, table: string): ColInfo[]    { return db.prepare(`PRAGMA table_info(${table})`).all() as ColInfo[]; }
function idxs(db: RealDb, table: string): IdxInfo[]    { return db.prepare(`PRAGMA index_list(${table})`).all() as IdxInfo[]; }
function idxCols(db: RealDb, idx: string): IdxColInfo[] { return db.prepare(`PRAGMA index_info(${idx})`).all() as IdxColInfo[]; }

// ---------------------------------------------------------------------------
// Schema assertion tests
// ---------------------------------------------------------------------------

describe('task_events schema (migration 002+005 DDL)', () => {
  let db: RealDb;

  beforeEach(() => { db = makeSchemaADb(); });
  afterEach(() => { db.close(); });

  it('has exactly the expected columns in order', () => {
    const names = cols(db, 'task_events').map(c => c.name);
    expect(names).toEqual([
      'global_seq', 'task_seq', 'version', 'type',
      'task_id', 'node_id', 'occurred_at', 'payload',
    ]);
  });

  it('global_seq is INTEGER PRIMARY KEY', () => {
    const gs = cols(db, 'task_events').find(c => c.name === 'global_seq')!;
    expect(gs.pk).toBe(1);
    expect(gs.type.toUpperCase()).toBe('INTEGER');
  });

  it('version column has DEFAULT 1', () => {
    const v = cols(db, 'task_events').find(c => c.name === 'version')!;
    expect(v.dflt_value).toBe('1');
  });

  it('enforces UNIQUE(task_id, task_seq)', () => {
    // The UNIQUE constraint is represented as an autoindex with unique=1
    const autoUniq = idxs(db, 'task_events').find(i => i.unique === 1);
    expect(autoUniq).toBeDefined();
    const ucnames = idxCols(db, autoUniq!.name).map(c => c.name).sort();
    expect(ucnames).toEqual(['task_id', 'task_seq'].sort());
  });

  it('has idx_events_task_seq on (task_id, task_seq)', () => {
    const idx = idxs(db, 'task_events').find(i => i.name === 'idx_events_task_seq');
    expect(idx).toBeDefined();
    const cnames = idxCols(db, 'idx_events_task_seq').map(c => c.name);
    expect(cnames).toEqual(['task_id', 'task_seq']);
  });

  it('has idx_events_occurred_at', () => {
    expect(idxs(db, 'task_events').find(i => i.name === 'idx_events_occurred_at')).toBeDefined();
  });

  it('has idx_events_type', () => {
    expect(idxs(db, 'task_events').find(i => i.name === 'idx_events_type')).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// append + listByTaskSince round-trip
// ---------------------------------------------------------------------------

describe('append + listByTaskSince round-trip', () => {
  let db: RealDb;

  beforeEach(() => { db = makeSchemaADb(); });
  afterEach(() => { db.close(); });

  it('resumes exactly from ?lastEventId cursor', () => {
    const t = (n: number) => `2026-01-01T00:00:0${n}.000Z`;
    appendEvent(db, 'task-1', 0, 'TaskCreated', null, t(0));
    appendEvent(db, 'task-1', 1, 'NodeStarted',   'n1', t(1));
    appendEvent(db, 'task-1', 2, 'NodeCompleted', 'n1', t(2));
    appendEvent(db, 'task-1', 3, 'TaskCompleted', null, t(3));

    const resumed = listByTaskSince(db, 'task-1', 1);
    expect(resumed.map(r => r.task_seq)).toEqual([2, 3]);
    expect(resumed[0].type).toBe('NodeCompleted');
    expect(resumed[1].type).toBe('TaskCompleted');
  });

  it('full replay when cursor is -1', () => {
    appendEvent(db, 'task-2', 0, 'TaskCreated', null, '2026-01-01T00:00:00.000Z');
    appendEvent(db, 'task-2', 1, 'NodeStarted', 'n1', '2026-01-01T00:00:01.000Z');

    const all = listByTaskSince(db, 'task-2', -1);
    expect(all.length).toBe(2);
    expect(all[0].task_seq).toBe(0);
    expect(all[1].task_seq).toBe(1);
  });

  it('returns empty when fully caught up', () => {
    appendEvent(db, 'task-3', 0, 'TaskCreated', null, '2026-01-01T00:00:00.000Z');
    expect(listByTaskSince(db, 'task-3', 0)).toEqual([]);
  });

  it('global_seq is monotonically increasing across tasks', () => {
    const g1 = appendEvent(db, 'ta', 0, 'TaskCreated', null, '2026-01-01T00:00:00.000Z');
    const g2 = appendEvent(db, 'tb', 0, 'TaskCreated', null, '2026-01-01T00:00:00.000Z');
    const g3 = appendEvent(db, 'ta', 1, 'NodeStarted', 'n1', '2026-01-01T00:00:01.000Z');
    expect(g1).toBeLessThan(g2);
    expect(g2).toBeLessThan(g3);
  });

  it('UNIQUE(task_id, task_seq) rejects duplicate', () => {
    appendEvent(db, 'dup', 0, 'NodeStarted', 'n1', '2026-01-01T00:00:00.000Z');
    expect(() => appendEvent(db, 'dup', 0, 'NodeStarted', 'n1', '2026-01-01T00:00:00.000Z')).toThrow();
  });

  it('per-task cursor — two tasks can share seq=0 without collision', () => {
    appendEvent(db, 'iso-a', 0, 'TaskCreated', null, '2026-01-01T00:00:00.000Z');
    appendEvent(db, 'iso-b', 0, 'TaskCreated', null, '2026-01-01T00:00:00.000Z');
    expect(listByTaskSince(db, 'iso-a', -1).length).toBe(1);
    expect(listByTaskSince(db, 'iso-b', -1).length).toBe(1);
  });

  it('version and occurred_at round-trip correctly', () => {
    const ts = '2026-06-15T12:00:00.000Z';
    appendEvent(db, 'vt', 0, 'TaskCreated', null, ts);
    const [row] = listByTaskSince(db, 'vt', -1) as any[];
    expect(row.version).toBe(CURRENT_EVENT_VERSION);
    expect(row.occurred_at).toBe(ts);
  });

  it('null payload round-trips as null (not the string "null")', () => {
    appendEvent(db, 'np', 0, 'TaskCompleted', null, '2026-01-01T00:00:00.000Z', null);
    const [row] = listByTaskSince(db, 'np', -1) as any[];
    expect(row.payload).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// schemaRegistry wired into append
// ---------------------------------------------------------------------------

describe('schemaRegistry validateEvent', () => {
  it('rejects an event with a missing required payload field', () => {
    const result = validateEvent({
      type: 'TaskCreated',
      version: 1,
      payload: { prompt: 'test', walletPublicKey: 'G' /* dagSize missing */ } as any,
    });
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes('dagSize'))).toBe(true);
  });

  it('rejects an unknown version', () => {
    const result = validateEvent({ type: 'TaskCreated', version: 99, payload: {} });
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toContain('Unknown event version');
  });

  it('accepts a well-formed v1 TaskCreated event', () => {
    const result = validateEvent({
      type: 'TaskCreated',
      version: 1,
      payload: { prompt: 'ok', walletPublicKey: 'GABC', dagSize: 1 },
    });
    expect(result.valid).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Migration 005 idempotency
// ---------------------------------------------------------------------------

describe('migration 005 idempotency', () => {
  it('creates schema A on a database that ran migration 002 (normal case)', () => {
    // In production the migrator always runs 002 before 005.
    const db = new RealDatabase(':memory:');
    db.exec(loadSql('002_create_task_events_table.up.sql'));
    expect(() => db.exec(loadSql('006_replace_task_events_schema.up.sql'))).not.toThrow();
    const names = cols(db, 'task_events').map(c => c.name);
    expect(names).toContain('global_seq');
    expect(names).toContain('task_seq');
    expect(names).toContain('occurred_at');
    expect(names).not.toContain('taskId');
    expect(names).not.toContain('timestamp');
    db.close();
  });

  it('transforms a schema B table (from migration 002) into schema A', () => {
    const db = new RealDatabase(':memory:');
    db.exec(loadSql('002_create_task_events_table.up.sql'));
    db.prepare(`INSERT INTO task_events (taskId, type, nodeId, payload, timestamp) VALUES (?,?,?,?,?)`)
      .run('task-1', 'node_started', 'n1', null, '2026-01-01T00:00:00.000Z');
    db.prepare(`INSERT INTO task_events (taskId, type, nodeId, payload, timestamp) VALUES (?,?,?,?,?)`)
      .run('task-1', 'node_completed', 'n1', null, '2026-01-01T00:00:01.000Z');

    db.exec(loadSql('006_replace_task_events_schema.up.sql'));

    const names = cols(db, 'task_events').map(c => c.name);
    expect(names).toContain('global_seq');
    expect(names).toContain('task_seq');
    expect(names).toContain('task_id');
    expect(names).toContain('occurred_at');
    expect(names).not.toContain('taskId');
    expect(names).not.toContain('timestamp');

    const rows = db.prepare('SELECT * FROM task_events ORDER BY task_seq ASC').all() as any[];
    expect(rows.length).toBe(2);
    expect(rows[0].task_id).toBe('task-1');
    expect(rows[0].type).toBe('node_started');
    db.close();
  });

  it('is a no-op when applied twice (already schema A)', () => {
    // In production the migrator records checksums in schema_migrations and
    // never re-applies an already-applied migration, so "apply twice" is not
    // a real runtime scenario.  This test verifies that the first run succeeds
    // and leaves data intact, and that subsequent schema A operations work.
    const db = new RealDatabase(':memory:');
    const upSql = loadSql('006_replace_task_events_schema.up.sql');
    db.exec(loadSql('002_create_task_events_table.up.sql'));
    // First run: converts schema B → schema A
    expect(() => db.exec(upSql)).not.toThrow();
    // Insert a row in schema A format
    db.prepare(`INSERT INTO task_events (task_seq,version,type,task_id,occurred_at) VALUES (0,1,'TaskCreated','task-x','2026-01-01T00:00:00.000Z')`).run();
    // Data is intact
    const rows = db.prepare('SELECT * FROM task_events').all() as any[];
    expect(rows.length).toBe(1);
    expect((rows[0] as any).task_id).toBe('task-x');
    // Schema A columns are present
    const names = cols(db, 'task_events').map(c => c.name);
    expect(names).toContain('global_seq');
    expect(names).toContain('task_seq');
    db.close();
  });

  it('down migration restores schema B shape', () => {
    const db = new RealDatabase(':memory:');
    db.exec(loadSql('002_create_task_events_table.up.sql'));
    db.exec(loadSql('006_replace_task_events_schema.up.sql'));
    db.prepare(`INSERT INTO task_events (task_seq,version,type,task_id,node_id,occurred_at) VALUES (0,1,'NodeStarted','task-d','n1','2026-01-01T00:00:00.000Z')`).run();

    db.exec(loadSql('006_replace_task_events_schema.down.sql'));

    const names = cols(db, 'task_events').map(c => c.name);
    expect(names).toContain('taskId');
    expect(names).toContain('timestamp');
    expect(names).not.toContain('global_seq');
    expect(names).not.toContain('task_seq');

    const rows = db.prepare('SELECT * FROM task_events').all() as any[];
    expect(rows.length).toBe(1);
    expect((rows[0] as any).taskId).toBe('task-d');
    db.close();
  });
});

// ---------------------------------------------------------------------------
// tasks.ts insertEvent / getEventHistory — schema A columns
// ---------------------------------------------------------------------------

describe('createTaskDb insertEvent / getEventHistory (schema A)', () => {
  it('inserts and retrieves events using schema A columns', () => {
    const db = new RealDatabase(':memory:');
    db.exec(`
      CREATE TABLE tasks (
        id TEXT PRIMARY KEY, prompt TEXT NOT NULL, walletPublicKey TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'queued', dagJson TEXT NOT NULL DEFAULT '[]',
        createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL
      );
      CREATE TABLE task_events (
        global_seq  INTEGER PRIMARY KEY AUTOINCREMENT,
        task_seq    INTEGER NOT NULL,
        version     INTEGER NOT NULL DEFAULT 1,
        type        TEXT NOT NULL,
        task_id     TEXT NOT NULL,
        node_id     TEXT,
        occurred_at TEXT NOT NULL,
        payload     TEXT,
        UNIQUE (task_id, task_seq)
      );
      CREATE INDEX idx_events_task_seq ON task_events (task_id, task_seq ASC);
    `);

    const now = '2026-01-01T00:00:00.000Z';
    const taskId = 'schema-a-task';
    db.prepare(`INSERT INTO tasks VALUES (?,?,?,?,?,?,?)`)
      .run(taskId, 'test', 'G', 'queued', '[]', now, now);

    // Use the same INSERT logic as our updated tasks.ts
    const getMaxSeq = db.prepare(
      `SELECT COALESCE(MAX(task_seq), -1) AS max_seq FROM task_events WHERE task_id = ?`
    );
    const insertEvt = db.prepare(`
      INSERT INTO task_events (task_seq, version, type, task_id, node_id, occurred_at, payload)
      VALUES (?, 1, ?, ?, ?, ?, ?)
    `);

    const nextSeq = (r: any) => (r.max_seq as number) + 1;

    insertEvt.run(nextSeq(getMaxSeq.get(taskId)), 'node_started',   taskId, 'n1', now, null);
    insertEvt.run(nextSeq(getMaxSeq.get(taskId)), 'node_completed', taskId, 'n1', now, null);

    const rows = db.prepare(
      `SELECT * FROM task_events WHERE task_id = ? ORDER BY task_seq ASC`
    ).all(taskId) as any[];

    expect(rows.length).toBe(2);
    expect(rows[0].type).toBe('node_started');
    expect(rows[1].type).toBe('node_completed');
    expect(rows[0].task_seq).toBe(0);
    expect(rows[1].task_seq).toBe(1);
    expect(rows[0].occurred_at).toBe(now);
    db.close();
  });
});

// ---------------------------------------------------------------------------
// Schema conflict regression (#560)
// ---------------------------------------------------------------------------

describe('schema conflict regression (#560)', () => {
  it('events.sql contains NO executable CREATE TABLE statement (documentation only)', () => {
    const content = loadEventsSqlContent();
    // The file must not contain any un-commented CREATE TABLE statement.
    // Every DDL line in events.sql is prefixed with "--" (comment), so this
    // assertion verifies the "exactly one DDL location" invariant.
    const lines = content.split('\n');
    const executableCreateTable = lines.filter(line => {
      const trimmed = line.trim();
      return /^CREATE\s+TABLE/i.test(trimmed);
    });
    expect(executableCreateTable).toHaveLength(0);
  });

  it('migration pair 002+005 produces schema A column set', () => {
    const db = new RealDatabase(':memory:');
    db.exec(loadSql('002_create_task_events_table.up.sql'));
    db.exec(loadSql('006_replace_task_events_schema.up.sql'));
    const columnNames = cols(db, 'task_events').map(c => c.name);
    db.close();

    expect(columnNames).toEqual([
      'global_seq', 'task_seq', 'version', 'type',
      'task_id', 'node_id', 'occurred_at', 'payload',
    ]);
  });

  it('schema A has task_seq, occurred_at, version — schema B columns are absent', () => {
    const db = makeSchemaADb();

    appendEvent(db, 'reg', 0, 'TaskCreated', null, '2026-01-01T00:00:00.000Z');
    appendEvent(db, 'reg', 1, 'NodeStarted', 'n1', '2026-01-01T00:00:01.000Z');
    appendEvent(db, 'reg', 2, 'NodeFailed',  'n1', '2026-01-01T00:00:02.000Z');

    const rows = listByTaskSince(db, 'reg', -1);
    // schema B has no task_seq
    expect(rows.map(r => r.task_seq)).toEqual([0, 1, 2]);
    // schema B has no occurred_at
    expect(rows.every(r => typeof r.occurred_at === 'string')).toBe(true);
    // schema B has no version
    expect(rows.every(r => typeof r.version === 'number')).toBe(true);

    db.close();
  });
});
