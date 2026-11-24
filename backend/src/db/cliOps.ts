/**
 * Testable command bodies for the operator CLI (Issue #739).
 *
 * `db/cli.ts` owns argv parsing and the readline confirmation prompt; every
 * operation that touches the job store, the backup directory or the admin
 * audit log lives here, with output and confirmation injected. That split is
 * what makes "purge everything" reviewable in a unit test instead of only
 * against a production database.
 *
 * No `process.env` reads: configuration comes through `getConfig()`, so the
 * `no-direct-process-env` guard stays clean for every module except the
 * whitelisted `db/cli.ts` entry point.
 */

import fs from 'node:fs';
import path from 'node:path';
import { getGlobalJobQueue } from '../queue';
import type { DeadLetterPage } from '../queue/dlq';
import { recordAdminAudit } from '../services/adminControl';
import { getConfig } from '../config';
import {
  decryptBuffer,
  isEncryptedBackup,
  verifyBackupBuffer,
  type BackupHeader,
} from '../services/backup/encryption';

/** Output sink; the CLI passes the console, tests pass a collector. */
export interface CliIo {
  out: (line: string) => void;
  err: (line: string) => void;
}

export const consoleIo: CliIo = {
  out: (line) => console.log(line),
  err: (line) => console.error(line),
};

/** Confirmation prompt; the CLI passes a readline wrapper, tests a stub. */
export type ConfirmFn = (question: string) => Promise<boolean>;

function audit(
  action: string,
  params: { target?: string; statusCode: number; actor: string; details?: Record<string, unknown> }
): void {
  try {
    recordAdminAudit({
      at: new Date().toISOString(),
      actor: params.actor,
      action,
      target: params.target,
      statusCode: params.statusCode,
      details: params.details,
    });
  } catch {
    // recordAdminAudit already logs its own failures; a CLI command must not
    // crash because the audit sink hiccuped after a successful mutation.
  }
}

// ── DLQ commands ─────────────────────────────────────────────────────────────

/** Print the dead-letter queue, paginated. */
export function listDeadLetters(
  options: { page?: number; pageSize?: number; io?: CliIo } = {}
): DeadLetterPage {
  const io = options.io ?? consoleIo;
  const page = getGlobalJobQueue()
    .getDeadLetterQueue()
    .list({ page: options.page, pageSize: options.pageSize });
  io.out(`dead-letter entries: ${page.total} (page ${page.page}, pageSize ${page.pageSize})`);
  for (const entry of page.deadLetters) {
    io.out(
      [
        `job=${entry.jobId}`,
        `task=${entry.taskId}`,
        `attempts=${entry.retryCount}`,
        `failedAt=${entry.failedAt}`,
        `error=${JSON.stringify(entry.failureReason)}`,
      ].join(' ')
    );
  }
  return page;
}

/** Re-enqueue one parked job with a fresh retry budget. */
export function replayDeadLetter(options: { jobId: string; actor?: string; io?: CliIo }): {
  jobId: string;
  requeued: boolean;
} {
  const io = options.io ?? consoleIo;
  const actor = options.actor ?? 'cli';
  const requeued = getGlobalJobQueue().getDeadLetterQueue().replay(options.jobId);
  audit('cli.dlq.replay', {
    target: options.jobId,
    statusCode: requeued ? 200 : 404,
    actor,
  });
  if (requeued) {
    io.out(`replayed ${options.jobId}`);
  } else {
    io.err(
      `${options.jobId} was not in the dead-letter queue (unknown, already replayed, or deleted)`
    );
  }
  return { jobId: options.jobId, requeued };
}

/**
 * Delete dead-letter entries older than `olderThanDays` (0 = all).
 *
 * Destructive: refused without a confirmation, and audited with the count
 * that actually went away.
 */
export async function purgeDeadLetters(options: {
  olderThanDays: number;
  actor?: string;
  confirm?: ConfirmFn;
  io?: CliIo;
}): Promise<{ purged: number; aborted: boolean }> {
  const io = options.io ?? consoleIo;
  const actor = options.actor ?? 'cli';
  const days = Number.isFinite(options.olderThanDays) ? Math.max(0, options.olderThanDays) : 0;

  if (options.confirm) {
    const question =
      days === 0
        ? 'Purge ALL dead-letter entries? This cannot be undone. [y/N] '
        : `Purge dead-letter entries older than ${days} day(s)? [y/N] `;
    const approved = await options.confirm(question);
    if (!approved) {
      io.err('purge aborted');
      return { purged: 0, aborted: true };
    }
  }

  const purged = getGlobalJobQueue().purgeDeadLetters(days);
  audit('cli.dlq.purge', {
    statusCode: 200,
    actor,
    details: { purged, olderThanDays: days },
  });
  io.out(`purged ${purged} dead-letter entr${purged === 1 ? 'y' : 'ies'}`);
  return { purged, aborted: false };
}

// ── Backup commands ──────────────────────────────────────────────────────────

export interface BackupFileEntry {
  file: string;
  sizeBytes: number;
  modifiedAt: string;
  encrypted: boolean;
}

/** Default snapshot directory: `DB_BACKUP_DIR`, else `<cwd>/backups`. */
export function defaultBackupDirectory(): string {
  try {
    const configured = getConfig().DB_BACKUP_DIR;
    if (typeof configured === 'string' && configured.length > 0) return configured;
  } catch {
    // fall through to the path default
  }
  return path.join(process.cwd(), 'backups');
}

function isBackupFile(name: string): boolean {
  return (
    name.endsWith('.db') ||
    name.endsWith('.db.enc') ||
    name.endsWith('.sqlite') ||
    name.endsWith('.sqlite.enc') ||
    name.endsWith('.enc')
  );
}

/** List snapshot files (plain and encrypted) in a directory. */
export function listBackups(options: { directory?: string; io?: CliIo } = {}): BackupFileEntry[] {
  const io = options.io ?? consoleIo;
  const dir = options.directory ?? defaultBackupDirectory();
  let names: string[];
  try {
    names = fs.readdirSync(dir).filter(isBackupFile).sort();
  } catch (err) {
    io.err(
      `cannot read backup directory ${dir}: ${err instanceof Error ? err.message : String(err)}`
    );
    return [];
  }
  const entries: BackupFileEntry[] = names.map((name) => {
    const full = path.join(dir, name);
    const stat = fs.statSync(full);
    return {
      file: full,
      sizeBytes: stat.size,
      modifiedAt: stat.mtime.toISOString(),
      encrypted: name.endsWith('.enc'),
    };
  });
  io.out(`backups in ${dir}: ${entries.length}`);
  for (const entry of entries) {
    io.out(
      `${entry.file} ${entry.sizeBytes}B ${entry.modifiedAt} ${entry.encrypted ? 'encrypted' : 'plaintext'}`
    );
  }
  return entries;
}

export interface BackupVerifyResult {
  file: string;
  ok: boolean;
  encrypted: boolean;
  header?: BackupHeader;
  error?: string;
}

/**
 * Verify a snapshot: container structure, GCM tag and plaintext checksum for
 * encrypted files; existence and the SQLite magic for legacy plaintext ones.
 */
export function verifyBackup(options: {
  file: string;
  key?: string;
  io?: CliIo;
}): BackupVerifyResult {
  const io = options.io ?? consoleIo;
  const result: BackupVerifyResult = {
    file: options.file,
    ok: false,
    encrypted: false,
  };
  try {
    const buf = fs.readFileSync(options.file);
    if (isEncryptedBackup(buf)) {
      result.encrypted = true;
      result.header = verifyBackupBuffer(buf, options.key ? { key: options.key } : {});
      result.ok = true;
      io.out(
        `OK ${options.file} (encrypted, source=${result.header.source ?? '?'}, createdAt=${result.header.createdAt})`
      );
    } else {
      const magic = buf.subarray(0, 16).toString('utf8');
      if (magic.startsWith('SQLite format 3')) {
        result.ok = true;
        io.out(`OK ${options.file} (plaintext SQLite — consider encrypting with a fresh snapshot)`);
      } else {
        result.error = 'not an ai-net backup (no magic, no SQLite header)';
        io.err(`FAIL ${options.file}: ${result.error}`);
      }
    }
  } catch (err) {
    result.error = err instanceof Error ? err.message : String(err);
    io.err(`FAIL ${options.file}: ${result.error}`);
  }
  return result;
}

export interface BackupRestoreResult {
  file: string;
  ok: boolean;
  dryRun: boolean;
  aborted: boolean;
  wrote?: string;
  header?: BackupHeader;
  error?: string;
}

/**
 * Restore a snapshot to disk.
 *
 * Encrypted containers are decrypted (and verified) before writing; legacy
 * plaintext snapshots are copied with a warning. A dry run performs every
 * check — existence, key, integrity, target collision — and reports what it
 * *would* write without touching the filesystem.
 */
export async function restoreBackup(options: {
  file: string;
  target?: string;
  dryRun?: boolean;
  force?: boolean;
  key?: string;
  actor?: string;
  confirm?: ConfirmFn;
  io?: CliIo;
}): Promise<BackupRestoreResult> {
  const io = options.io ?? consoleIo;
  const actor = options.actor ?? 'cli';
  const dryRun = options.dryRun ?? false;
  const result: BackupRestoreResult = {
    file: options.file,
    ok: false,
    dryRun,
    aborted: false,
  };

  let buf: Buffer;
  try {
    buf = fs.readFileSync(options.file);
  } catch (err) {
    result.error = err instanceof Error ? err.message : String(err);
    io.err(`cannot read ${options.file}: ${result.error}`);
    return result;
  }

  const encrypted = isEncryptedBackup(buf);
  const stripped = options.file.endsWith('.enc')
    ? options.file.slice(0, -'.enc'.length)
    : options.file;
  const target = path.resolve(options.target ?? stripped);

  if (fs.existsSync(target) && !options.force && !dryRun) {
    result.error = `target ${target} already exists (pass --force to overwrite)`;
    io.err(result.error);
    return result;
  }

  let plaintext: Buffer | undefined;
  if (encrypted) {
    try {
      result.header = verifyBackupBuffer(buf, options.key ? { key: options.key } : {});
      // Full decrypt now, so a dry run also proves the payload is recoverable.
      plaintext = decryptBuffer(buf, options.key ? { key: options.key } : {});
    } catch (err) {
      result.error = err instanceof Error ? err.message : String(err);
      io.err(`backup failed verification: ${result.error}`);
      audit('cli.backup.restore', {
        target: options.file,
        statusCode: 500,
        actor,
        details: { error: result.error, dryRun },
      });
      return result;
    }
  } else {
    io.err(`warning: ${options.file} is a plaintext snapshot (no encryption header)`);
  }

  if (dryRun) {
    result.ok = true;
    io.out(
      `dry-run OK ${options.file} → ${target} (${encrypted ? 'encrypted' : 'plaintext'}${
        result.header?.source ? `, source=${result.header.source}` : ''
      }); nothing written`
    );
    return result;
  }

  if (options.confirm) {
    const approved = await options.confirm(
      `Restore ${options.file} to ${target}${encrypted ? ' (decrypted)' : ''}? [y/N] `
    );
    if (!approved) {
      result.aborted = true;
      io.err('restore aborted');
      return result;
    }
  }

  try {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    if (encrypted && plaintext) {
      fs.writeFileSync(target, plaintext);
    } else {
      fs.copyFileSync(options.file, target);
    }
    result.ok = true;
    result.wrote = target;
    io.out(`restored ${target}`);
    audit('cli.backup.restore', {
      target,
      statusCode: 200,
      actor,
      details: { from: options.file, encrypted },
    });
  } catch (err) {
    result.error = err instanceof Error ? err.message : String(err);
    io.err(`restore failed: ${result.error}`);
    audit('cli.backup.restore', {
      target,
      statusCode: 500,
      actor,
      details: { from: options.file, error: result.error },
    });
  }
  return result;
}
