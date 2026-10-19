/**
 * Unit tests for encrypted SQLite backups (Issue #747).
 *
 * Round-trips run against the real AES-256-GCM container so a change to the
 * file format cannot pass by asserting against a mock of itself.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  BACKUP_MAGIC,
  BackupEncryptionError,
  ENCRYPTED_BACKUP_SUFFIX,
  decryptBackupFile,
  decryptBuffer,
  encryptBackupFile,
  encryptBuffer,
  getBackupEncryptionKey,
  isEncryptedBackup,
  packBackupFile,
  readBackupHeader,
  unpackBackupFile,
  verifyBackupBuffer,
} from './encryption';

const KEY = 'test-backup-encryption-key-0123456789';

describe('encryptBuffer / decryptBuffer (Issue #747)', () => {
  const plaintext = Buffer.from('SQLite format 3\0payload-payload-payload');

  it('round-trips through the container format', () => {
    const sealed = encryptBuffer(plaintext, { key: KEY, source: 'payments' });
    expect(isEncryptedBackup(sealed)).toBe(true);
    expect(sealed.includes(plaintext)).toBe(false);

    const header = readBackupHeader(sealed);
    expect(header).toMatchObject({
      algo: 'aes-256-gcm',
      source: 'payments',
      formatVersion: 1,
    });
    expect(header.checksum).toMatch(/^[0-9a-f]{64}$/);

    expect(decryptBuffer(sealed, { key: KEY })).toEqual(plaintext);
  });

  it('falls back to the configured key when none is passed', () => {
    expect(() => encryptBuffer(plaintext, {})).not.toThrow();
  });

  it('fails closed on an explicitly empty key', () => {
    expect(() => encryptBuffer(plaintext, { key: '' })).toThrow(/not configured/);
    expect(() => encryptBuffer(plaintext, { key: '' })).toThrow(BackupEncryptionError);
  });

  it('rejects the wrong key', () => {
    const sealed = encryptBuffer(plaintext, { key: KEY });
    expect(() => decryptBuffer(sealed, { key: 'wrong-key-wrong-key-wrong-key-!!' })).toThrow(
      BackupEncryptionError
    );
  });

  it('rejects a tampered payload', () => {
    const sealed = encryptBuffer(plaintext, { key: KEY });
    const { header, ciphertext } = unpackBackupFile(sealed);
    ciphertext[0] ^= 0xff;
    expect(() => decryptBuffer(packBackupFile(header, ciphertext), { key: KEY })).toThrow(
      BackupEncryptionError
    );
  });

  it('rejects a file without the magic prefix', () => {
    expect(() => unpackBackupFile(Buffer.from('definitely-not-a-backup-file!!'))).toThrow(
      /bad magic/
    );
    expect(isEncryptedBackup(Buffer.from('definitely-not-a-backup-file!!'))).toBe(false);
  });

  it('rejects a truncated container', () => {
    const sealed = encryptBuffer(plaintext, { key: KEY });
    expect(() => unpackBackupFile(sealed.subarray(0, 6))).toThrow(/truncated/);
  });

  it('detects a swapped checksum (wrong plaintext, valid tag)', () => {
    const sealed = encryptBuffer(plaintext, { key: KEY });
    const { header, ciphertext } = unpackBackupFile(sealed);
    header.checksum = '0'.repeat(64);
    expect(() => decryptBuffer(packBackupFile(header, ciphertext), { key: KEY })).toThrow(
      /checksum mismatch/
    );
  });

  it('verifies end-to-end via verifyBackupBuffer', () => {
    const sealed = encryptBuffer(plaintext, { key: KEY, source: 'tasks', schemaVersion: 3 });
    const header = verifyBackupBuffer(sealed, { key: KEY });
    expect(header.source).toBe('tasks');
    expect(header.schemaVersion).toBe(3);
    expect(() => verifyBackupBuffer(Buffer.from('nope'), { key: KEY })).toThrow();
  });
});

describe('encryptBackupFile / decryptBackupFile (Issue #747)', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ainet-backup-'));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('writes <file>.enc, removes the raw snapshot and round-trips', () => {
    // A synthetic SQLite-shaped file: header magic + padding, with
    // `user_version` = 3 at offset 60 so the header carries a schema stamp.
    const rawPath = path.join(dir, 'payments-1.db');
    const fakeDb = Buffer.alloc(128);
    fakeDb.write('SQLite format 3\0', 0, 'utf8');
    fakeDb.writeUInt32BE(3, 60);
    fs.writeFileSync(rawPath, fakeDb);

    const encPath = encryptBackupFile(rawPath, { key: KEY, source: 'payments' });
    expect(encPath).toBe(`${rawPath}${ENCRYPTED_BACKUP_SUFFIX}`);
    expect(fs.existsSync(rawPath)).toBe(false);
    expect(fs.existsSync(encPath)).toBe(true);

    const restored = decryptBackupFile(encPath);
    expect(restored).toBe(rawPath);
    expect(fs.readFileSync(restored).subarray(0, 15).toString('utf8')).toBe('SQLite format 3');
    expect(readBackupHeader(fs.readFileSync(encPath)).schemaVersion).toBe(3);
  });

  it('fails closed without a key and leaves no plaintext behind', () => {
    const rawPath = path.join(dir, 'tasks-1.db');
    fs.writeFileSync(rawPath, Buffer.from('raw-snapshot'));
    expect(() => encryptBackupFile(rawPath, { key: '' })).toThrow(/not configured/);
    expect(fs.existsSync(`${rawPath}${ENCRYPTED_BACKUP_SUFFIX}`)).toBe(false);
  });
});

describe('getBackupEncryptionKey (Issue #747)', () => {
  it('reads through getConfig (the test environment provides a key)', () => {
    expect(typeof getBackupEncryptionKey()).toBe('string');
  });

  it('exposes the magic as ASCII', () => {
    expect(BACKUP_MAGIC).toBe('AINETBAK');
  });
});

describe('malformed container headers (Issue #747)', () => {
  function withHeader(headerJson: Buffer | string, extra: Buffer = Buffer.alloc(0)): Buffer {
    const header = typeof headerJson === 'string' ? Buffer.from(headerJson, 'utf8') : headerJson;
    const headerLen = Buffer.alloc(4);
    headerLen.writeUInt32BE(header.length, 0);
    return Buffer.concat([Buffer.from(BACKUP_MAGIC, 'utf8'), headerLen, header, extra]);
  }

  it('rejects a header whose declared length runs past the file', () => {
    const headerLen = Buffer.alloc(4);
    headerLen.writeUInt32BE(4096, 0);
    const buf = Buffer.concat([
      Buffer.from(BACKUP_MAGIC, 'utf8'),
      headerLen,
      Buffer.from('{"algo":', 'utf8'),
    ]);
    expect(() => decryptBuffer(buf, { key: KEY })).toThrow(/header is truncated/);
  });

  it('rejects a header that is not valid JSON', () => {
    expect(() => decryptBuffer(withHeader('definitely not json'), { key: KEY })).toThrow(
      /not valid JSON/
    );
  });

  it('rejects an unsupported algorithm declared in the header', () => {
    const header = JSON.stringify({
      algo: 'rot13',
      iv: 'AAAA',
      authTag: 'BBBB',
      checksum: 'cc'.repeat(32),
      createdAt: new Date().toISOString(),
      schemaVersion: 1,
      source: 'agents',
      formatVersion: 1,
    });
    const buf = withHeader(header, Buffer.from('ciphertext'));
    expect(() => decryptBuffer(buf, { key: KEY })).toThrow(/Unsupported backup algorithm/);
  });

  it('fails closed when decrypting with an explicitly empty key', () => {
    const sealed = encryptBuffer(Buffer.from('payload'), { key: KEY });
    expect(() => decryptBuffer(sealed, { key: '' })).toThrow(/not configured/);
  });
});

describe('getBackupEncryptionKey failure modes (Issue #747)', () => {
  afterEach(() => {
    jest.unmock('../../config');
  });

  it('returns null when the configuration module throws', () => {
    jest.isolateModules(() => {
      jest.doMock('../../config', () => ({
        getConfig: () => {
          throw new Error('config unavailable');
        },
      }));
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const mod = require('./encryption') as typeof import('./encryption');
      expect(mod.getBackupEncryptionKey()).toBeNull();
    });
  });

  it('returns null when the configured key is empty', () => {
    jest.isolateModules(() => {
      jest.doMock('../../config', () => ({
        getConfig: () => ({ DB_BACKUP_ENCRYPTION_KEY: '' }),
      }));
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const mod = require('./encryption') as typeof import('./encryption');
      expect(mod.getBackupEncryptionKey()).toBeNull();
    });
  });
});
