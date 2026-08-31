import fs from "fs";
import path from "path";
import type { Request } from "express";
import Database from "better-sqlite3";
import { createAgentDb, getAgentDb, type AgentRecord } from "../db/agents";
import { getDb as getPaymentDb } from "../db";
import { getTaskDb } from "../db/tasks";
import { getJobDb } from "../queue";
import { createLogger } from "../utils/logger";

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
  enabled: process.env.AI_NET_READ_ONLY === "true",
  reason: process.env.AI_NET_READ_ONLY_REASON,
  changedAt: new Date().toISOString(),
  changedBy: "boot",
};

let auditDb: Database.Database | null = null;

function getAuditDb(): Database.Database {
  if (!auditDb) {
    const dbPath = process.env.ADMIN_AUDIT_DB_PATH ?? DEFAULT_AUDIT_DB;
    auditDb = new Database(dbPath);
    auditDb.pragma("busy_timeout = 5000");
    auditDb.pragma("journal_mode = WAL");
    auditDb.exec(`
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
  }
  return auditDb;
}

export function getReadOnlyState(): ReadOnlyState {
  return { ...readOnlyState };
}

export function isReadOnly(): boolean {
  return readOnlyState.enabled;
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

export function recordAdminAudit(entry: AdminAuditEntry): void {
  try {
    getAuditDb()
      .prepare(
        `
        INSERT INTO admin_audit_log (at, actor, action, target, statusCode, requestId, details)
        VALUES (@at, @actor, @action, @target, @statusCode, @requestId, @details)
      `,
      )
      .run({
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

export function auditLogToCsv(entries: AdminAuditEntry[]): string {
  const escape = (value: unknown): string => {
    const text = value === undefined || value === null ? "" : String(value);
    return `"${text.replace(/"/g, '""')}"`;
  };
  const header = ["id", "at", "actor", "action", "target", "statusCode", "requestId", "details"];
  const rows = entries.map((entry) =>
    [
      entry.id,
      entry.at,
      entry.actor,
      entry.action,
      entry.target,
      entry.statusCode,
      entry.requestId,
      entry.details === undefined ? "" : JSON.stringify(entry.details),
    ]
      .map(escape)
      .join(","),
  );
  return [header.join(","), ...rows].join("\n");
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
  const targetDir = directory ?? process.env.ADMIN_BACKUP_DIR ?? DEFAULT_BACKUP_DIR;
  fs.mkdirSync(targetDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");

  const results: MaintenanceResult[] = [];
  for (const { name, db } of databases()) {
    const file = path.join(targetDir, `${name}-${stamp}.sqlite`);
    try {
      await db.backup(file);
      results.push({ database: name, ok: true, file });
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
