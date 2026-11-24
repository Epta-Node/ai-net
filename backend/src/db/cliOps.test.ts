/**
 * Unit tests for the operator CLI command bodies (Issue #739).
 *
 * The queue and audit sinks are mocked; backup commands run against real
 * temp files and the real encryption container, because the CLI's contract
 * with the filesystem *is* the behaviour under test.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { encryptBuffer } from '../services/backup/encryption';
import {
  consoleIo,
  listBackups,
  listDeadLetters,
  purgeDeadLetters,
  replayDeadLetter,
  restoreBackup,
  verifyBackup,
  type CliIo,
} from './cliOps';

jest.mock('../queue', () => ({
  getGlobalJobQueue: jest.fn(),
}));

jest.mock('../services/adminControl', () => ({
  recordAdminAudit: jest.fn(),
}));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const queueModule = require('../queue') as { getGlobalJobQueue: jest.Mock };
// eslint-disable-next-line @typescript-eslint/no-var-requires
const auditModule = require('../services/adminControl') as { recordAdminAudit: jest.Mock };

const KEY = 'test-backup-encryption-key-0123456789';
const JOB_ID = 'job_dead_1';

function collectIo(): CliIo & { outLines: string[]; errLines: string[] } {
  const outLines: string[] = [];
  const errLines: string[] = [];
  return {
    outLines,
    errLines,
    out: (line) => outLines.push(line),
    err: (line) => errLines.push(line),
  };
}

const deadLetter = {
  jobId: JOB_ID,
  taskId: 'task_1',
  failureReason: 'max attempts exceeded (3/3): boom',
  failedAt: '2026-10-17T10:00:00.000Z',
  retryCount: 3,
  originalPayload: { taskId: 'task_1' },
};

let dlq: { list: jest.Mock; replay: jest.Mock };
let purgeMock: jest.Mock;

beforeEach(() => {
  jest.clearAllMocks();
  dlq = { list: jest.fn(), replay: jest.fn() };
  purgeMock = jest.fn();
  queueModule.getGlobalJobQueue.mockReturnValue({
    getDeadLetterQueue: () => dlq,
    purgeDeadLetters: purgeMock,
  });
});

// Silence the console reporter used by the no-io default.
beforeAll(() => {
  jest.spyOn(console, 'log').mockImplementation(() => undefined);
  jest.spyOn(console, 'error').mockImplementation(() => undefined);
});
afterAll(() => {
  jest.restoreAllMocks();
});

describe('listDeadLetters (Issue #739)', () => {
  it('pages the store and prints one line per entry', () => {
    dlq.list.mockReturnValue({
      deadLetters: [deadLetter],
      total: 1,
      page: 2,
      pageSize: 20,
    });
    const io = collectIo();
    const page = listDeadLetters({ page: 2, pageSize: 20, io });

    expect(dlq.list).toHaveBeenCalledWith({ page: 2, pageSize: 20 });
    expect(page.total).toBe(1);
    expect(io.outLines[0]).toContain('dead-letter entries: 1 (page 2, pageSize 20)');
    expect(io.outLines[1]).toContain(`job=${JOB_ID}`);
    expect(io.outLines[1]).toContain('attempts=3');
  });
});

describe('replayDeadLetter (Issue #739)', () => {
  it('audits a successful replay', () => {
    dlq.replay.mockReturnValue(true);
    const io = collectIo();
    const result = replayDeadLetter({ jobId: JOB_ID, actor: 'op-alice', io });

    expect(result.requeued).toBe(true);
    expect(dlq.replay).toHaveBeenCalledWith(JOB_ID);
    expect(auditModule.recordAdminAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        actor: 'op-alice',
        action: 'cli.dlq.replay',
        target: JOB_ID,
        statusCode: 200,
      })
    );
    expect(io.outLines.join('\n')).toContain(`replayed ${JOB_ID}`);
  });

  it('audits a no-op replay as 404 and exits non-zero territory', () => {
    dlq.replay.mockReturnValue(false);
    const io = collectIo();
    const result = replayDeadLetter({ jobId: JOB_ID, io });

    expect(result.requeued).toBe(false);
    expect(auditModule.recordAdminAudit).toHaveBeenCalledWith(
      expect.objectContaining({ statusCode: 404, action: 'cli.dlq.replay' })
    );
    expect(io.errLines.join('\n')).toContain('not in the dead-letter queue');
  });
});

describe('purgeDeadLetters (Issue #739)', () => {
  it('refuses to run when the confirmation is declined', async () => {
    const io = collectIo();
    const result = await purgeDeadLetters({
      olderThanDays: 0,
      confirm: async () => false,
      io,
    });

    expect(result).toEqual({ purged: 0, aborted: true });
    expect(purgeMock).not.toHaveBeenCalled();
    expect(auditModule.recordAdminAudit).not.toHaveBeenCalled();
    expect(io.errLines.join('\n')).toContain('purge aborted');
  });

  it('runs with an explicit confirmation and audits the count', async () => {
    purgeMock.mockReturnValue(7);
    const io = collectIo();
    const questions: string[] = [];
    const result = await purgeDeadLetters({
      olderThanDays: 3,
      actor: 'op-bob',
      confirm: async (question) => {
        questions.push(question);
        return true;
      },
      io,
    });

    expect(result).toEqual({ purged: 7, aborted: false });
    expect(purgeMock).toHaveBeenCalledWith(3);
    expect(questions[0]).toContain('older than 3 day(s)');
    expect(auditModule.recordAdminAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        actor: 'op-bob',
        action: 'cli.dlq.purge',
        statusCode: 200,
        details: { purged: 7, olderThanDays: 3 },
      })
    );
  });

  it('purges everything when days is 0 and no confirmation is supplied', async () => {
    purgeMock.mockReturnValue(12);
    const result = await purgeDeadLetters({ olderThanDays: 0 });
    expect(result).toEqual({ purged: 12, aborted: false });
    expect(purgeMock).toHaveBeenCalledWith(0);
  });
});

describe('backup list / verify / restore (Issue #739)', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ainet-cli-'));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('lists plain and encrypted snapshots with sizes', () => {
    fs.writeFileSync(path.join(dir, 'tasks-1.db'), Buffer.alloc(10, 1));
    fs.writeFileSync(path.join(dir, 'tasks-2.db.enc'), Buffer.alloc(20, 2));
    fs.writeFileSync(path.join(dir, 'unrelated.txt'), 'skip');

    const io = collectIo();
    const entries = listBackups({ directory: dir, io });

    expect(entries).toHaveLength(2);
    expect(entries.map((e) => e.encrypted)).toEqual([false, true]);
    expect(entries[0].sizeBytes).toBe(10);
    expect(entries[1].sizeBytes).toBe(20);
  });

  it('verifies an encrypted backup end-to-end', () => {
    const file = path.join(dir, 'payments-1.db.enc');
    fs.writeFileSync(
      file,
      encryptBuffer(Buffer.from('SQLite format 3\0x'), { key: KEY, source: 'payments' })
    );

    const io = collectIo();
    const result = verifyBackup({ file, io });
    expect(result.ok).toBe(true);
    expect(result.encrypted).toBe(true);
    expect(result.header?.source).toBe('payments');
  });

  it('rejects a foreign file on verify', () => {
    const file = path.join(dir, 'not-a-backup.db');
    fs.writeFileSync(file, 'hello');
    const result = verifyBackup({ file, io: collectIo() });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/not an ai-net backup/);
  });

  it('dry-run reports the target without writing or prompting', async () => {
    const plaintext = Buffer.from('SQLite format 3\0payload');
    const file = path.join(dir, 'agents-1.db.enc');
    fs.writeFileSync(file, encryptBuffer(plaintext, { key: KEY, source: 'agents' }));
    const target = path.join(dir, 'restored.db');

    let prompted = false;
    const result = await restoreBackup({
      file,
      target,
      dryRun: true,
      confirm: async () => {
        prompted = true;
        return true;
      },
      io: collectIo(),
    });

    expect(result.ok).toBe(true);
    expect(result.dryRun).toBe(true);
    expect(prompted).toBe(false);
    expect(fs.existsSync(target)).toBe(false);
  });

  it('restores a decrypted payload and audits the write', async () => {
    const plaintext = Buffer.from('SQLite format 3\0payload');
    const file = path.join(dir, 'jobs-1.db.enc');
    fs.writeFileSync(file, encryptBuffer(plaintext, { key: KEY, source: 'jobs' }));
    const target = path.join(dir, 'restored.db');

    const result = await restoreBackup({ file, target, force: true, io: collectIo() });

    expect(result.ok).toBe(true);
    expect(result.wrote).toBe(target);
    expect(fs.readFileSync(target)).toEqual(plaintext);
    expect(auditModule.recordAdminAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'cli.backup.restore',
        statusCode: 200,
        target,
      })
    );
  });

  it('refuses to overwrite an existing target without --force', async () => {
    const file = path.join(dir, 'tasks-1.db.enc');
    fs.writeFileSync(file, encryptBuffer(Buffer.from('SQLite format 3\0x'), { key: KEY }));
    const target = path.join(dir, 'existing.db');
    fs.writeFileSync(target, 'keep me');

    const result = await restoreBackup({ file, target, io: collectIo() });

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/already exists/);
    expect(fs.readFileSync(target, 'utf8')).toBe('keep me');
  });

  it('aborts on a declined confirmation without writing', async () => {
    const file = path.join(dir, 'tasks-1.db.enc');
    fs.writeFileSync(file, encryptBuffer(Buffer.from('SQLite format 3\0x'), { key: KEY }));
    const target = path.join(dir, 'declined.db');

    const result = await restoreBackup({
      file,
      target,
      confirm: async () => false,
      io: collectIo(),
    });

    expect(result.aborted).toBe(true);
    expect(result.ok).toBe(false);
    expect(fs.existsSync(target)).toBe(false);
  });
});

describe('consoleIo', () => {
  it('delegates to the console', () => {
    const log = jest.spyOn(console, 'log').mockImplementation(() => undefined);
    const error = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    consoleIo.out('o');
    consoleIo.err('e');
    expect(log).toHaveBeenCalledWith('o');
    expect(error).toHaveBeenCalledWith('e');
    log.mockRestore();
    error.mockRestore();
  });
});

describe('backup listing edge cases (Issue #739)', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ainet-cli-edge-'));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('recognises .sqlite, .sqlite.enc and bare .enc snapshots', () => {
    fs.writeFileSync(path.join(dir, 'a.sqlite'), 'x');
    fs.writeFileSync(path.join(dir, 'b.sqlite.enc'), 'x');
    fs.writeFileSync(path.join(dir, 'c.enc'), 'x');
    fs.writeFileSync(path.join(dir, 'notes.txt'), 'ignored');

    const io = collectIo();
    const entries = listBackups({ directory: dir, io });

    expect(entries.map((e) => path.basename(e.file))).toEqual([
      'a.sqlite',
      'b.sqlite.enc',
      'c.enc',
    ]);
    expect(entries.map((e) => e.encrypted)).toEqual([false, true, true]);
  });

  it('reports an unreadable directory instead of throwing', () => {
    const io = collectIo();
    const entries = listBackups({
      directory: path.join(dir, 'missing-subdir'),
      io,
    });
    expect(entries).toEqual([]);
    expect(io.errLines.join('\n')).toMatch(/cannot read backup directory/);
  });

  it('accepts a plaintext snapshot by its SQLite header', () => {
    const file = path.join(dir, 'legacy.db');
    fs.writeFileSync(file, Buffer.from('SQLite format 3\0legacy-payload'));

    const io = collectIo();
    const res = verifyBackup({ file, io });

    expect(res.ok).toBe(true);
    expect(io.outLines.join('\n')).toMatch(/plaintext SQLite/);
  });

  it('reports a missing file on verify', () => {
    const io = collectIo();
    const res = verifyBackup({ file: path.join(dir, 'absent.db.enc'), io });
    expect(res.ok).toBe(false);
    expect(res.error).toBeTruthy();
  });
});

describe('defaultBackupDirectory (Issue #739)', () => {
  afterEach(() => {
    jest.unmock('../config');
  });

  it('uses DB_BACKUP_DIR when configured', () => {
    jest.isolateModules(() => {
      jest.doMock('../config', () => ({
        getConfig: () => ({ DB_BACKUP_DIR: '/tmp/ai-net-backups' }),
      }));
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const mod = require('./cliOps') as typeof import('./cliOps');
      expect(mod.defaultBackupDirectory()).toBe('/tmp/ai-net-backups');
    });
  });

  it('falls back to <cwd>/backups when the key is empty or config throws', () => {
    jest.isolateModules(() => {
      jest.doMock('../config', () => ({
        getConfig: () => {
          throw new Error('config unavailable');
        },
      }));
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const mod = require('./cliOps') as typeof import('./cliOps');
      expect(mod.defaultBackupDirectory()).toBe(path.join(process.cwd(), 'backups'));
    });
    jest.isolateModules(() => {
      jest.doMock('../config', () => ({
        getConfig: () => ({ DB_BACKUP_DIR: '' }),
      }));
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const mod = require('./cliOps') as typeof import('./cliOps');
      expect(mod.defaultBackupDirectory()).toBe(path.join(process.cwd(), 'backups'));
    });
  });
});

describe('restore failure paths (Issue #739)', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ainet-cli-restore-'));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('reports a missing file instead of throwing', async () => {
    const io = collectIo();
    const res = await restoreBackup({ file: path.join(dir, 'absent.db.enc'), io });
    expect(res.ok).toBe(false);
    expect(io.errLines.join('\n')).toMatch(/cannot read/);
  });

  it('aborts an encrypted restore when verification fails and audits 500', async () => {
    const file = path.join(dir, 'agents-9.db.enc');
    fs.writeFileSync(file, encryptBuffer(Buffer.from('SQLite format 3\0x'), { key: KEY }));
    const io = collectIo();

    const res = await restoreBackup({
      file,
      target: path.join(dir, 'wrong-key.db'),
      force: true,
      key: 'wrong-key-0123456789-abcdefghijkl',
      io,
    });

    expect(res.ok).toBe(false);
    expect(io.errLines.join('\n')).toMatch(/failed verification/);
    expect(auditModule.recordAdminAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'cli.backup.restore',
        statusCode: 500,
      })
    );
  });

  it('restores a plaintext snapshot with a warning', async () => {
    const plaintext = Buffer.from('SQLite format 3\0legacy-payload');
    const file = path.join(dir, 'legacy.db');
    fs.writeFileSync(file, plaintext);
    const target = path.join(dir, 'legacy-restored.db');

    const io = collectIo();
    const res = await restoreBackup({ file, target, force: true, io });

    expect(res.ok).toBe(true);
    expect(io.errLines.join('\n')).toMatch(/plaintext snapshot/);
    expect(fs.readFileSync(target)).toEqual(plaintext);
  });

  it('restores after an explicit confirmation', async () => {
    const file = path.join(dir, 'jobs-7.db.enc');
    fs.writeFileSync(file, encryptBuffer(Buffer.from('SQLite format 3\0x'), { key: KEY }));
    const target = path.join(dir, 'confirmed.db');

    let question = '';
    const io = collectIo();
    const res = await restoreBackup({
      file,
      target,
      confirm: async (q) => {
        question = q;
        return true;
      },
      io,
    });

    expect(question).toMatch(/restore/i);
    expect(res.ok).toBe(true);
    expect(fs.existsSync(target)).toBe(true);
  });

  it('reports a filesystem failure while writing and audits 500', async () => {
    const file = path.join(dir, 'jobs-8.db.enc');
    fs.writeFileSync(file, encryptBuffer(Buffer.from('SQLite format 3\0x'), { key: KEY }));
    const blocker = path.join(dir, 'blocker');
    fs.writeFileSync(blocker, 'not a directory');

    const io = collectIo();
    const res = await restoreBackup({
      file,
      target: path.join(blocker, 'nested.db'),
      force: true,
      io,
    });

    expect(res.ok).toBe(false);
    expect(res.error).toBeTruthy();
    expect(auditModule.recordAdminAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'cli.backup.restore', statusCode: 500 })
    );
  });
});
