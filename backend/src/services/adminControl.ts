import fs from "fs";
import path from "path";
import type { Request } from "express";
import Database from "better-sqlite3";
import { createAgentDb, getAgentDb, type AgentRecord } from "../db/agents";
import { getDb as getPaymentDb } from "../db";
import { getTaskDb } from "../db/tasks";
import { getJobDb } from "../queue";
import { createLogger } from "../utils/logger";
import { config } from "../config";

import { getConfig } from "../config";
import { encryptBackupFile } from "./backup/encryption";
import { AuditLog, ensureAuditChainColumns } from "./auditLog";

const logger = createLogger({ component: "admin-control" });

const DEFAULT_AUDIT_DB = path.join(process.cwd(), "admin_audit.db");
const DEFAULT_BACKUP_DIR = path.join(process.cwd(), "backups", "admin");

export interface ReadOnlyState {
  enabled: boolean;
  reason?: string;
  changedAt?: string;
  changedBy?: string;
}

export interface AdminAuditEntry {
  id?: number;
  at: string;
  actor: string;
  action: string;
  target?: string;
  statusCode: number;
  requestId?: string;
  details?: unknown;
}

let readOnlyState: ReadOnlyState = {
  enabled: config.AI_NET_READ_ONLY,
  reason: config.AI_NET_READ_ONLY_REASON,
  changedAt: new Date().toISOString(),
  changedBy: "boot",
};

let auditDb: Database.Database | null = null;

function getAuditDb(): Database.Database {
  if (!auditDb) {
    const configured = config.ADMIN_AUDIT_DB_PATH;
    auditDb = openAuditDb(configured?.trim() ? configured : DEFAULT_AUDIT_DB);
  }
  return auditDb;
}

/**
 * Open (and create, including its parent directory) the audit database.
 *
 * A configured path that cannot be opened — missing volume, permission
 * denied — falls back to the default location once, so audit writes degrade
 * instead of taking the admin API down with them.
 */
function openAuditDb(dbPath: string): Database.Database {
  try {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    const db = new Database(dbPath);
    db.pragma("busy_timeout = 5000");
    db.pragma("journal_mode = WAL");
    db.exec(`
      CREATE TABLE IF NOT EXISTS admin_audit_log (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        at         TEXT NOT NULL,
        actor      TEXT NOT NULL,
        action     TEXT NOT NULL,
        target     TEXT,
        statusCode INTEGER NOT NULL,
        requestId  TEXT,
        details    TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_admin_audit_log_at
        ON admin_audit_log (at);
      CREATE INDEX IF NOT EXISTS idx_admin_audit_log_action
        ON admin_audit_log (action);
    `);
    // Databases created before hash chaining (#808) gain prevHash/hash in place.
    ensureAuditChainColumns(db);
    return db;
  } catch (err) {
    logger.error({ err, dbPath }, "failed to open admin audit database");
    if (dbPath !== DEFAULT_AUDIT_DB) {
      return openAuditDb(DEFAULT_AUDIT_DB);
    }
    throw err;
  }
}

export function setReadOnlyState(enabled: boolean, actor: string, reason?: string): ReadOnlyState {
  readOnlyState = {
    enabled,
    reason: reason?.trim() || undefined,
    changedAt: new Date().toISOString(),
    changedBy: actor,
  };
  return getReadOnlyState();
}

/** Current read-only state, copied so callers cannot mutate the live value. */
export function getReadOnlyState(): ReadOnlyState {
  return { ...readOnlyState };
}

/** Whether the API is currently refusing mutations. */
export function isReadOnly(): boolean {
  return readOnlyState.enabled;
}

export function actorFromRequest(req: Request): string {
  const actorHeader = req.headers["x-admin-actor"];
  const actor = Array.isArray(actorHeader) ? actorHeader[0] : actorHeader;
  if (actor?.trim()) return actor.trim();
  return req.ip || "admin";
}

function redact(value: unknown): unknown {
  if (!value || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(redact);

  const redacted: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (/key|secret|token|authorization|password/i.test(key)) {
      redacted[key] = "[redacted]";
    } else {
      redacted[key] = redact(item);
    }
  }
  return redacted;
}

/**
 * The hash-chained view over the admin audit database (#808). Created per call
 * because it is a thin wrapper; the connection itself is cached by `getAuditDb`.
 */
export function getAdminAuditLog(): AuditLog {
  return new AuditLog(getAuditDb());
}

export function recordAdminAudit(entry: AdminAuditEntry): void {
  try {
    getAdminAuditLog().append({
      at: entry.at,
      actor: entry.actor,
      action: entry.action,
      target: entry.target ?? null,
      statusCode: entry.statusCode,
      requestId: entry.requestId ?? null,
      details: entry.details === undefined ? null : JSON.stringify(redact(entry.details)),
    });
  } catch (err) {
    logger.error({ err, action: entry.action }, "failed to write admin audit entry");
  }
}

export function listAdminAuditLog(limit = 200, offset = 0): AdminAuditEntry[] {
  const rows = getAuditDb()
    .prepare(
      `
      SELECT id, at, actor, action, target, statusCode, requestId, details
      FROM admin_audit_log
      ORDER BY id DESC
      LIMIT ? OFFSET ?
    `,
    )
    .all(Math.min(Math.max(limit, 1), 1000), Math.max(offset, 0)) as Array<
    AdminAuditEntry & { details: string | null }
  >;

  return rows.map((row) => ({
    ...row,
    details: row.details ? JSON.parse(row.details) : undefined,
  }));
}

/** Rows fetched per query while streaming an export. */
const AUDIT_EXPORT_BATCH_SIZE = 500;
/** Hard upper bound on rows in a single export, regardless of the requested limit. */
export const AUDIT_EXPORT_MAX_ROWS = 100_000;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** Cells starting with these characters are interpreted as formulas by spreadsheet apps. */
const CSV_FORMULA_PREFIX = /^[=+\-@\t\r]/;

export const AUDIT_LOG_CSV_HEADER = [
  "id",
  "at",
  "actor",
  "action",
  "target",
  "statusCode",
  "requestId",
  "details",
].join(",");

function csvCell(value: unknown): string {
  let text = value === undefined || value === null ? "" : String(value);
  // Neutralise CSV/formula injection (actor, target and details are caller-controlled).
  if (CSV_FORMULA_PREFIX.test(text)) text = `'${text}`;
  return `"${text.replace(/"/g, '""')}"`;
}

export function auditLogEntryToCsvRow(entry: AdminAuditEntry): string {
  return [
    entry.id,
    entry.at,
    entry.actor,
    entry.action,
    entry.target,
    entry.statusCode,
    entry.requestId,
    entry.details === undefined ? "" : JSON.stringify(entry.details),
  ]
    .map(csvCell)
    .join(",");
}

export function auditLogToCsv(entries: AdminAuditEntry[]): string {
  return [AUDIT_LOG_CSV_HEADER, ...entries.map(auditLogEntryToCsvRow)].join("\n");
}

/**
 * Walk the audit log newest-first in bounded batches using keyset pagination,
 * yielding at most `maxRows` entries in total, so an export never loads the
 * whole table into memory.
 */
export function* iterateAdminAuditLog(
  maxRows = AUDIT_EXPORT_MAX_ROWS,
  batchSize = AUDIT_EXPORT_BATCH_SIZE,
): Generator<AdminAuditEntry[]> {
  const statement = getAuditDb().prepare(
    `
      SELECT id, at, actor, action, target, statusCode, requestId, details
      FROM admin_audit_log
      WHERE id < ?
      ORDER BY id DESC
      LIMIT ?
    `,
  );
  let remaining = Math.min(Math.max(maxRows, 0), AUDIT_EXPORT_MAX_ROWS);
  let beforeId = Number.MAX_SAFE_INTEGER;

  while (remaining > 0) {
    const rows = statement.all(beforeId, Math.min(batchSize, remaining)) as Array<
      AdminAuditEntry & { id: number; details: string | null }
    >;
    if (rows.length === 0) return;

    yield rows.map((row) => ({
      ...row,
      details: row.details ? JSON.parse(row.details) : undefined,
    }));

    remaining -= rows.length;
    beforeId = rows[rows.length - 1].id;
  }
}

/**
 * Delete audit entries older than `retentionDays`. A non-positive value
 * disables pruning. Returns the number of rows removed.
 */
export function pruneAdminAuditLog(retentionDays: number, now: Date = new Date()): number {
  if (!Number.isFinite(retentionDays) || retentionDays <= 0) return 0;
  const cutoff = new Date(now.getTime() - retentionDays * MS_PER_DAY).toISOString();
  return getAuditDb().prepare("DELETE FROM admin_audit_log WHERE at < ?").run(cutoff).changes;
}

export function listAgentsForAdmin(status?: "online" | "offline"): AgentRecord[] {
  const db = createAgentDb(getAgentDb());
  return db.list(status ? { status } : undefined);
}

export function setAgentEnabled(agentId: string, enabled: boolean): AgentRecord | undefined {
  const db = createAgentDb(getAgentDb());
  const agent = db.findById(agentId);
  if (!agent) return undefined;

  const updated: AgentRecord = {
    ...agent,
    status: enabled ? "online" : "offline",
    lastSeenAt: new Date().toISOString(),
  };
  db.upsert(updated);
  return updated;
}

export interface MaintenanceResult {
  database: string;
  ok: boolean;
  file?: string;
  error?: string;
}

function databases(): Array<{ name: string; db: Database.Database }> {
  return [
    { name: "tasks", db: getTaskDb() },
    { name: "agents", db: getAgentDb() },
    { name: "jobs", db: getJobDb() },
    { name: "payments", db: getPaymentDb() },
    { name: "admin_audit", db: getAuditDb() },
  ];
}

export function vacuumDatabases(): MaintenanceResult[] {
  return databases().map(({ name, db }) => {
    try {
      db.pragma("wal_checkpoint(TRUNCATE)");
      db.exec("VACUUM");
      return { database: name, ok: true };
    } catch (err) {
      return {
        database: name,
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  });
}

export async function backupDatabases(directory?: string): Promise<MaintenanceResult[]> {
  const targetDir = directory ?? (config.ADMIN_BACKUP_DIR || DEFAULT_BACKUP_DIR);
  fs.mkdirSync(targetDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");

  const results: MaintenanceResult[] = [];
  for (const { name, db } of databases()) {
    const file = path.join(targetDir, `${name}-${stamp}.sqlite`);
    try {
      await db.backup(file);
      // Encrypt at rest (Issue #747); fails closed when no key is configured.
      const encryptedFile = encryptBackupFile(file, { source: name });
      results.push({ database: name, ok: true, file: encryptedFile });
    } catch (err) {
      results.push({
        database: name,
        ok: false,
        file,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return results;
}
