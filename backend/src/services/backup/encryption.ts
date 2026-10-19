/**
 * Encrypted SQLite backups (Issue #747).
 *
 * Backups contain every wallet address, payment hash and prompt the node has
 * ever seen — a plaintext copy on disk is a standing liability. This module
 * wraps each snapshot in a single self-describing file:
 *
 * ```text
 *   "AINETBAK"            8-byte magic, so a restore can refuse foreign files
 *   headerLen             u32, big-endian
 *   header                JSON: { algo, iv, authTag, checksum, createdAt,
 *                                 schemaVersion, source }
 *   ciphertext            AES-256-GCM of the raw SQLite file
 * ```
 *
 * The key is derived from `DB_BACKUP_ENCRYPTION_KEY` with scrypt (salt fixed
 * and public: the key *is* the secret) so operators never handle raw 32-byte
 * material. Integrity is double-covered: GCM's auth tag rejects tampering,
 * and a SHA-256 checksum of the plaintext in the header catches truncation
 * or a wrong-key decrypt that somehow verifies.
 *
 * **Fail closed**: when no key is configured, {@link encryptBackupFile}
 * throws rather than writing a plaintext snapshot. A silent downgrade would
 * mean the absence of an encryption key is indistinguishable from a healthy
 * encrypted backup — exactly the failure mode an auditor needs to be able to
 * rule out.
 */

import { createCipheriv, createDecipheriv, createHash, randomBytes, scryptSync } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { getConfig } from '../../config';

/** File suffix appended to an encrypted snapshot (`payments-…-db.enc`). */
export const ENCRYPTED_BACKUP_SUFFIX = '.enc';

/** Magic prefix; a restore refuses files that do not carry it. */
export const BACKUP_MAGIC = 'AINETBAK';

/** Backup container format version (not the SQLite `user_version`). */
export const BACKUP_FORMAT_VERSION = 1;

const ALGO = 'aes-256-gcm';
const KEY_LENGTH = 32;
const IV_LENGTH = 12;
const SCRYPT_SALT = 'ai-net.db.backup.v1';

export interface BackupHeader {
  algo: typeof ALGO;
  /** Base64 GCM initialisation vector. */
  iv: string;
  /** Base64 GCM authentication tag. */
  authTag: string;
  /** Hex SHA-256 of the plaintext snapshot. */
  checksum: string;
  createdAt: string;
  /** SQLite `PRAGMA user_version` at snapshot time, when readable. */
  schemaVersion?: number;
  /** Database name the snapshot came from (payments, tasks, …). */
  source?: string;
  /** Container format version. */
  formatVersion: number;
}

/** Raised for every encryption/decryption failure; message is operator-safe. */
export class BackupEncryptionError extends Error {
  readonly cause?: unknown;
  constructor(message: string, options?: { cause?: unknown }) {
    // `lib: ES2020` has no `ErrorOptions`, so the cause is assigned manually.
    super(message);
    this.name = 'BackupEncryptionError';
    this.cause = options?.cause;
  }
}

/**
 * The configured backup key, or `null` when encryption is not configured.
 *
 * Read through `getConfig()` (never `process.env` directly) so tests can swap
 * the config module and the `no-direct-process-env` guard stays green.
 */
export function getBackupEncryptionKey(): string | null {
  try {
    const key = getConfig().DB_BACKUP_ENCRYPTION_KEY;
    return typeof key === 'string' && key.length > 0 ? key : null;
  } catch {
    return null;
  }
}

function deriveKey(secret: string): Buffer {
  return scryptSync(secret, SCRYPT_SALT, KEY_LENGTH);
}

function sha256Hex(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}

/**
 * Serialise header + ciphertext into the on-disk container.
 *
 * Exported for tests that build fixtures byte-by-byte; application code
 * should call {@link encryptBuffer} instead.
 */
export function packBackupFile(header: BackupHeader, ciphertext: Buffer): Buffer {
  const headerJson = Buffer.from(JSON.stringify(header), 'utf8');
  const prefix = Buffer.alloc(BACKUP_MAGIC.length + 4);
  prefix.write(BACKUP_MAGIC, 0, 'ascii');
  prefix.writeUInt32BE(headerJson.length, BACKUP_MAGIC.length);
  return Buffer.concat([prefix, headerJson, ciphertext]);
}

/** Split a container into its header and ciphertext payloads. */
export function unpackBackupFile(buf: Buffer): { header: BackupHeader; ciphertext: Buffer } {
  if (buf.length < BACKUP_MAGIC.length + 4) {
    throw new BackupEncryptionError('Backup file is truncated');
  }
  if (buf.subarray(0, BACKUP_MAGIC.length).toString('ascii') !== BACKUP_MAGIC) {
    throw new BackupEncryptionError('Not an ai-net backup file (bad magic)');
  }
  const headerLen = buf.readUInt32BE(BACKUP_MAGIC.length);
  const headerStart = BACKUP_MAGIC.length + 4;
  const headerEnd = headerStart + headerLen;
  if (headerEnd > buf.length) {
    throw new BackupEncryptionError('Backup header is truncated');
  }
  let header: BackupHeader;
  try {
    header = JSON.parse(buf.subarray(headerStart, headerEnd).toString('utf8')) as BackupHeader;
  } catch (err) {
    throw new BackupEncryptionError('Backup header is not valid JSON', { cause: err });
  }
  return { header, ciphertext: buf.subarray(headerEnd) };
}

/** Encrypt raw snapshot bytes. Throws when no key is configured (fail closed). */
export function encryptBuffer(
  plaintext: Buffer,
  options: { key?: string; source?: string; schemaVersion?: number; now?: Date } = {}
): Buffer {
  const key = options.key !== undefined ? options.key : getBackupEncryptionKey();
  if (!key) {
    throw new BackupEncryptionError(
      'DB_BACKUP_ENCRYPTION_KEY is not configured — refusing to write a plaintext backup'
    );
  }
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGO, deriveKey(key), iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const header: BackupHeader = {
    algo: ALGO,
    iv: iv.toString('base64'),
    authTag: cipher.getAuthTag().toString('base64'),
    checksum: sha256Hex(plaintext),
    createdAt: (options.now ?? new Date()).toISOString(),
    schemaVersion: options.schemaVersion,
    source: options.source,
    formatVersion: BACKUP_FORMAT_VERSION,
  };
  return packBackupFile(header, ciphertext);
}

/** Decrypt a container back to raw snapshot bytes, verifying tag and checksum. */
export function decryptBuffer(buf: Buffer, options: { key?: string } = {}): Buffer {
  const key = options.key ?? getBackupEncryptionKey();
  if (!key) {
    throw new BackupEncryptionError('DB_BACKUP_ENCRYPTION_KEY is not configured');
  }
  const { header, ciphertext } = unpackBackupFile(buf);
  if (header.algo !== ALGO) {
    throw new BackupEncryptionError(`Unsupported backup algorithm: ${String(header.algo)}`);
  }
  try {
    const decipher = createDecipheriv(ALGO, deriveKey(key), Buffer.from(header.iv, 'base64'));
    decipher.setAuthTag(Buffer.from(header.authTag, 'base64'));
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    const checksum = sha256Hex(plaintext);
    if (checksum !== header.checksum) {
      throw new BackupEncryptionError('Backup checksum mismatch after decrypt');
    }
    return plaintext;
  } catch (err) {
    if (err instanceof BackupEncryptionError) throw err;
    throw new BackupEncryptionError('Backup decryption failed (wrong key or corrupted file)', {
      cause: err,
    });
  }
}

/** Read the header of a container without decrypting the payload. */
export function readBackupHeader(buf: Buffer): BackupHeader {
  return unpackBackupFile(buf).header;
}

/**
 * Read a snapshot's SQLite `user_version` (the schema migration stamp) for
 * the backup header. Best-effort: an unreadable page just omits the field.
 */
function readSchemaVersion(plaintext: Buffer): number | undefined {
  // `user_version` lives at byte offset 60 of the 100-byte SQLite header,
  // stored big-endian as a 4-byte integer.
  if (plaintext.length < 64) return undefined;
  const version = plaintext.readUInt32BE(60);
  return Number.isFinite(version) ? version : undefined;
}

/**
 * Encrypt a snapshot file in place: `<file>` → `<file>.enc`, raw file removed.
 *
 * Returns the encrypted path. Throws {@link BackupEncryptionError} when no
 * key is configured (fail closed) or the source cannot be read.
 */
export function encryptBackupFile(
  rawPath: string,
  options: { key?: string; source?: string } = {}
): string {
  const key = options.key ?? getBackupEncryptionKey();
  if (!key) {
    throw new BackupEncryptionError(
      'DB_BACKUP_ENCRYPTION_KEY is not configured — refusing to write a plaintext backup'
    );
  }
  const plaintext = fs.readFileSync(rawPath);
  const encrypted = encryptBuffer(plaintext, {
    key,
    source: options.source ?? path.basename(rawPath),
    schemaVersion: readSchemaVersion(plaintext),
  });
  const encPath = `${rawPath}${ENCRYPTED_BACKUP_SUFFIX}`;
  fs.writeFileSync(encPath, encrypted);
  fs.unlinkSync(rawPath);
  return encPath;
}

/**
 * Decrypt a container file to `destination` (defaults to the path with the
 * `.enc` suffix stripped). Used by the restore path in the CLI (#739).
 */
export function decryptBackupFile(
  encPath: string,
  destination?: string,
  options: { key?: string } = {}
): string {
  const buf = fs.readFileSync(encPath);
  const plaintext = decryptBuffer(buf, options);
  const out =
    destination ??
    (encPath.endsWith(ENCRYPTED_BACKUP_SUFFIX)
      ? encPath.slice(0, -ENCRYPTED_BACKUP_SUFFIX.length)
      : `${encPath}.decrypted`);
  fs.writeFileSync(out, plaintext);
  return out;
}

/** True when the file carries the backup magic (encrypted container). */
export function isEncryptedBackup(buf: Buffer): boolean {
  return (
    buf.length >= BACKUP_MAGIC.length &&
    buf.subarray(0, BACKUP_MAGIC.length).toString('ascii') === BACKUP_MAGIC
  );
}

/**
 * Verify a backup file end-to-end: container structure, GCM tag, checksum.
 * Returns the parsed header on success; throws on any failure.
 */
export function verifyBackupBuffer(buf: Buffer, options: { key?: string } = {}): BackupHeader {
  const { header } = unpackBackupFile(buf);
  decryptBuffer(buf, options);
  return header;
}
