import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  BackupEncryptionError,
  decryptBuffer,
  decryptBackupFile,
  encryptBuffer,
  encryptBackupFile,
  keyIdFor,
  readBackupHeader,
  reencryptBackupFile,
  rotateBackupKeys,
} from './encryption';

const OLD_KEY = 'old-backup-key-0123456789abcdef';
const NEW_KEY = 'new-backup-key-fedcba9876543210';
const PLAINTEXT = Buffer.from('SQLite format 3\u0000 pretend snapshot bytes '.repeat(8));

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ainet-rotation-'));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('key fingerprints', () => {
  it('derives a stable, non-secret id that differs per key', () => {
    expect(keyIdFor(OLD_KEY)).toBe(keyIdFor(OLD_KEY));
    expect(keyIdFor(OLD_KEY)).not.toBe(keyIdFor(NEW_KEY));
    expect(keyIdFor(OLD_KEY)).not.toContain(OLD_KEY);
  });

  it('stores the fingerprint of the key that encrypted the file', () => {
    const header = readBackupHeader(encryptBuffer(PLAINTEXT, { key: OLD_KEY }));
    expect(header.keyId).toBe(keyIdFor(OLD_KEY));
  });
});

describe('decryption during a rotation window', () => {
  it('opens a file written under a retired key while the retired key is still listed', () => {
    const legacy = encryptBuffer(PLAINTEXT, { key: OLD_KEY });
    expect(decryptBuffer(legacy, { keys: [NEW_KEY, OLD_KEY] })).toEqual(PLAINTEXT);
  });

  it('refuses a file when no listed key matches its fingerprint', () => {
    const legacy = encryptBuffer(PLAINTEXT, { key: OLD_KEY });
    expect(() => decryptBuffer(legacy, { keys: [NEW_KEY] })).toThrow(BackupEncryptionError);
  });

  it('still opens files written before fingerprints existed, by trying each key', () => {
    const legacy = encryptBuffer(PLAINTEXT, { key: OLD_KEY });
    const header = JSON.parse(legacy.subarray(12, 12 + legacy.readUInt32BE(8)).toString('utf8'));
    delete header.keyId;
    const headerJson = Buffer.from(JSON.stringify(header), 'utf8');
    const prefix = Buffer.alloc(12);
    legacy.copy(prefix, 0, 0, 8);
    prefix.writeUInt32BE(headerJson.length, 8);
    const payload = legacy.subarray(12 + legacy.readUInt32BE(8));
    const unkeyed = Buffer.concat([prefix, headerJson, payload]);

    expect(decryptBuffer(unkeyed, { keys: [NEW_KEY, OLD_KEY] })).toEqual(PLAINTEXT);
  });
});

describe('reencryptBackupFile', () => {
  it('rewrites a file under the active key and keeps its payload and timestamp', () => {
    const file = path.join(dir, 'tasks-1.sqlite.enc');
    const createdAt = new Date('2026-01-02T03:04:05.000Z');
    fs.writeFileSync(file, encryptBuffer(PLAINTEXT, { key: OLD_KEY, source: 'tasks', schemaVersion: 7, now: createdAt }));

    const result = reencryptBackupFile(file, { activeKey: NEW_KEY, keys: [OLD_KEY] });

    expect(result.status).toBe('rotated');
    const header = readBackupHeader(fs.readFileSync(file));
    expect(header.keyId).toBe(keyIdFor(NEW_KEY));
    expect(header.createdAt).toBe(createdAt.toISOString());
    expect(header.source).toBe('tasks');
    expect(header.schemaVersion).toBe(7);
    expect(decryptBuffer(fs.readFileSync(file), { keys: [NEW_KEY] })).toEqual(PLAINTEXT);
    expect(fs.readdirSync(dir)).toEqual(['tasks-1.sqlite.enc']);
  });

  it('leaves a file already under the active key untouched', () => {
    const file = path.join(dir, 'a.sqlite.enc');
    const before = encryptBuffer(PLAINTEXT, { key: NEW_KEY });
    fs.writeFileSync(file, before);

    expect(reencryptBackupFile(file, { activeKey: NEW_KEY, keys: [NEW_KEY] }).status).toBe('current');
    expect(fs.readFileSync(file).equals(before)).toBe(true);
  });

  it('refuses to rotate without an active key', () => {
    const file = path.join(dir, 'b.sqlite.enc');
    fs.writeFileSync(file, encryptBuffer(PLAINTEXT, { key: OLD_KEY }));

    expect(() => reencryptBackupFile(file, { activeKey: '', keys: [OLD_KEY] })).toThrow(BackupEncryptionError);
  });
});

describe('rotateBackupKeys', () => {
  it('re-encrypts every backup, reports counts and keeps going past a bad file', () => {
    fs.writeFileSync(path.join(dir, 'old.sqlite.enc'), encryptBuffer(PLAINTEXT, { key: OLD_KEY }));
    fs.writeFileSync(path.join(dir, 'new.sqlite.enc'), encryptBuffer(PLAINTEXT, { key: NEW_KEY }));
    fs.writeFileSync(path.join(dir, 'corrupt.sqlite.enc'), Buffer.from('not a backup'));
    fs.writeFileSync(path.join(dir, 'notes.txt'), 'ignored');

    const summary = rotateBackupKeys(dir, { activeKey: NEW_KEY, keys: [NEW_KEY, OLD_KEY] });

    expect(summary.scanned).toBe(3);
    expect(summary.rotated).toBe(1);
    expect(summary.current).toBe(1);
    expect(summary.failed.map((f) => f.file)).toEqual(['corrupt.sqlite.enc']);
    expect(decryptBuffer(fs.readFileSync(path.join(dir, 'old.sqlite.enc')), { keys: [NEW_KEY] })).toEqual(PLAINTEXT);
  });

  it('returns an empty summary when the directory does not exist', () => {
    expect(rotateBackupKeys(path.join(dir, 'missing'), { activeKey: NEW_KEY, keys: [] })).toEqual({
      scanned: 0,
      rotated: 0,
      current: 0,
      failed: [],
    });
  });
});

describe('file helpers still interoperate with rotated files', () => {
  it('decrypts a rotated file through decryptBackupFile with the active key', () => {
    const raw = path.join(dir, 'payments.sqlite');
    fs.writeFileSync(raw, PLAINTEXT);
    const enc = encryptBackupFile(raw, { key: OLD_KEY, source: 'payments' });
    reencryptBackupFile(enc, { activeKey: NEW_KEY, keys: [OLD_KEY] });

    const out = decryptBackupFile(enc, path.join(dir, 'restored.sqlite'), { key: NEW_KEY });
    expect(fs.readFileSync(out)).toEqual(PLAINTEXT);
  });
});
