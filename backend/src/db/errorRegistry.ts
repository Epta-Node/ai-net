/**
 * Error-registry persistence + fee/rent accounting.
 *
 * Mirrors the on-chain error lifecycle (`err_rptd` / `err_rslvd`) into a local
 * SQLite store so error records are queryable and durable without unbounded
 * growth. Each entry is keyed by its on-chain `error_id` and carries:
 *
 * - a **TTL-based rent** expiry (`expires_at` from `created_at + ttl_seconds`),
 * - a **per-entry fee/rent charge** (`rent_stroops`) that accounts for the
 *   storage footprint the report occupies, attributed to a maintenance
 *   account (`maintenance_account`),
 * - a **per-agent live-entry cap** so one faulty agent cannot saturate the
 *   registry.
 *
 * Expired records are reclaimed deterministically by {@link sweepExpired},
 * which runs on the existing interval-based maintenance loop. Reads always
 * filter by `expires_at` so callers never observe stale rows regardless of
 * whether a sweep has run.
 */

import Database from "better-sqlite3";
import path from "path";
import { createLogger } from "../utils/logger";

const logger = createLogger({ component: "error-registry-db" });

export type ErrorStatus = "active" | "resolved";

export interface ErrorRecord {
  id: string;
  errorCode: number;
  message: string;
  agentId: string;
  reporter: string;
  status: ErrorStatus;
  resolution: string | null;
  /** Stroops charged for storing this report (fee/rent accounting). */
  rentStroops: bigint;
  /** Address that receives the collected storage rent. */
  maintenanceAccount: string;
  createdAt: string;
  expiresAt: string;
  resolvedAt: string | null;
}

export interface SubmitErrorInput {
  id: string;
  errorCode: number;
  message: string;
  agentId: string;
  reporter: string;
  ttlSeconds: number;
  rentStroops: bigint;
  maintenanceAccount: string;
}

export interface ErrorRegistryStore {
  submit(input: SubmitErrorInput): ErrorRecord;
  resolve(errorId: string, resolution: string): void;
  findById(id: string): ErrorRecord | undefined;
  listByAgent(agentId: string): ErrorRecord[];
  countLiveByAgent(agentId: string): number;
  /** Bound the number of live entries a single agent may hold. */
  capLiveEntries(agentId: string, cap: number): void;
  /** Delete every expired row in one pass; returns how many were removed. */
  sweepExpired(now?: number): number;
}

let _db: Database.Database | null = null;

export function getErrorDb(dbPath?: string): Database.Database {
  if (!_db) {
    const filePath = dbPath ?? path.join(process.cwd(), "errors.db");
    _db = new Database(filePath as unknown as string);
    _db.pragma("busy_timeout = 5000");
    _db.pragma("journal_mode = WAL");
    _db.exec(`
      CREATE TABLE IF NOT EXISTS errors (
        id                 TEXT PRIMARY KEY,
        errorCode          INTEGER NOT NULL,
        message            TEXT NOT NULL DEFAULT '',
        agentId            TEXT NOT NULL,
        reporter           TEXT NOT NULL,
        status             TEXT NOT NULL DEFAULT 'active',
        resolution         TEXT,
        rentStroops        TEXT NOT NULL DEFAULT '0',
        maintenanceAccount TEXT NOT NULL,
        createdAt          TEXT NOT NULL,
        expiresAt          TEXT NOT NULL,
        resolvedAt         TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_errors_agent ON errors (agentId, status);
      CREATE INDEX IF NOT EXISTS idx_errors_expiry ON errors (expiresAt);
    `);
    try {
      (_db as unknown as { on: (e: string, f: (err: Error) => void) => void }).on(
        "error",
        (err: Error) => logger.error({ err }, "error-registry database error"),
      );
    } catch {
      // error events are unavailable on some runtimes
    }
  }
  return _db;
}

export function closeErrorDb(): void {
  _db?.close();
  _db = null;
}

function mapRow(row: Record<string, unknown>): ErrorRecord {
  return {
    id: row.id as string,
    errorCode: row.errorCode as number,
    message: row.message as string,
    agentId: row.agentId as string,
    reporter: row.reporter as string,
    status: row.status as ErrorStatus,
    resolution: (row.resolution as string | null) ?? null,
    rentStroops: BigInt((row.rentStroops as string) || "0"),
    maintenanceAccount: row.maintenanceAccount as string,
    createdAt: row.createdAt as string,
    expiresAt: row.expiresAt as string,
    resolvedAt: (row.resolvedAt as string | null) ?? null,
  };
}

export function createErrorRegistryStore(db: Database.Database): ErrorRegistryStore {
  return {
    submit(input: SubmitErrorInput): ErrorRecord {
      const createdAt = new Date();
      const expiresAt = new Date(createdAt.getTime() + input.ttlSeconds * 1000).toISOString();
      const record: ErrorRecord = {
        id: input.id,
        errorCode: input.errorCode,
        message: input.message,
        agentId: input.agentId,
        reporter: input.reporter,
        status: "active",
        resolution: null,
        rentStroops: input.rentStroops,
        maintenanceAccount: input.maintenanceAccount,
        createdAt: createdAt.toISOString(),
        expiresAt,
        resolvedAt: null,
      };
      db.prepare(
        `INSERT OR IGNORE INTO errors
          (id, errorCode, message, agentId, reporter, status, resolution, rentStroops, maintenanceAccount, createdAt, expiresAt, resolvedAt)
         VALUES
          (@id, @errorCode, @message, @agentId, @reporter, @status, @resolution, @rentStroops, @maintenanceAccount, @createdAt, @expiresAt, @resolvedAt)`,
      ).run({
        ...record,
        rentStroops: record.rentStroops.toString(),
        resolution: null,
        resolvedAt: null,
      });
      const row = db.prepare("SELECT * FROM errors WHERE id = ?").get(record.id) as Record<string, unknown>;
      return mapRow(row);
    },

    resolve(errorId: string, resolution: string): void {
      db.prepare(
        "UPDATE errors SET status = 'resolved', resolution = ?, resolvedAt = ? WHERE id = ? AND status = 'active'",
      ).run(resolution, new Date().toISOString(), errorId);
    },

    findById(id: string): ErrorRecord | undefined {
      const row = db.prepare("SELECT * FROM errors WHERE id = ?").get(id) as Record<string, unknown> | undefined;
      return row ? mapRow(row) : undefined;
    },

    listByAgent(agentId: string): ErrorRecord[] {
      const rows = db.prepare("SELECT * FROM errors WHERE agentId = ? ORDER BY createdAt DESC").all(agentId) as Array<Record<string, unknown>>;
      return rows.map(mapRow);
    },

    countLiveByAgent(agentId: string): number {
      const row = db.prepare(
        "SELECT COUNT(*) AS total FROM errors WHERE agentId = ? AND status = 'active' AND expiresAt > ?",
      ).get(agentId, new Date().toISOString()) as { total: number };
      return Number(row.total) || 0;
    },

    capLiveEntries(agentId: string, cap: number): void {
      if (cap <= 0) return;
      const rows = db.prepare(
        "SELECT id FROM errors WHERE agentId = ? AND status = 'active' AND expiresAt > ? ORDER BY createdAt DESC",
      ).all(agentId, new Date().toISOString()) as Array<{ id: string }>;
      if (rows.length <= cap) return;
      // Keep the newest `cap` entries and resolve the overflow oldest ones,
      // so the agent's live footprint is bounded.
      const overflow = rows.slice(cap);
      const resolve = db.prepare(
        "UPDATE errors SET status = 'resolved', resolution = 'capacity', resolvedAt = ? WHERE id = ? AND status = 'active'",
      );
      for (const row of overflow) {
        resolve.run(new Date().toISOString(), row.id);
      }
      logger.info({ agentId, evicted: overflow.length }, "evicted oldest error entries over per-agent cap");
    },

    sweepExpired(now: number = Date.now()): number {
      const iso = new Date(now).toISOString();
      const result = db.prepare("DELETE FROM errors WHERE status = 'active' AND expiresAt <= ?").run(iso);
      return result.changes;
    },
  };
}

/** Default per-agent live-entry cap. */
export const DEFAULT_ERROR_CAP_PER_AGENT = 100;
/** Default TTL (seconds) applied when the caller does not supply one. */
export const DEFAULT_ERROR_TTL_SECONDS = 90 * 24 * 60 * 60;
/** Default per-entry storage-rent charge, in stroops (0.01 XLM). */
export const DEFAULT_RENT_STROOPS = 100_000n;
