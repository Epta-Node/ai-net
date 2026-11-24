/**
 * AuditLogger — Issue #1004
 *
 * Tamper-evident append-only audit log backed by SQLite.
 *
 * Each record carries:
 *   hash = SHA-256(prevHash || timestamp || action || entityType || entityId || payload)
 *
 * The first record uses '0'.repeat(64) as its prevHash (genesis sentinel).
 * verifyChain() re-computes every hash from genesis to detect tampering.
 *
 * The table is intentionally write-once: the application never issues UPDATE or
 * DELETE against audit_log. The SQLite trigger below enforces this at the DB
 * level for defence-in-depth.
 */
import { createHash } from "crypto";
import Database from "better-sqlite3";
import path from "path";
import { createLogger } from "./logger";

const log = createLogger({ component: "audit-logger" });

const GENESIS_HASH = "0".repeat(64);

// ── Types ─────────────────────────────────────────────────────────────────────

export type AuditAction =
  | "task_created"
  | "task_cancelled"
  | "agent_registered"
  | "agent_deregistered"
  | "payment_locked"
  | "payment_released"
  | "payment_refunded"
  | "dlq_item_replayed"
  | "admin_login"
  | "quota_reset";

export interface AuditRecord {
  id: number;
  action: AuditAction;
  entityType: string;
  entityId: string;
  actorPublicKey: string;
  payload: unknown;
  prevHash: string;
  hash: string;
  timestamp: string;
}

export interface VerifyResult {
  valid: boolean;
  firstBreak?: number;
}

// ── Database singleton ────────────────────────────────────────────────────────

let _db: Database.Database | null = null;

export function getAuditDb(dbPath?: string): Database.Database {
  if (!_db) {
    const filePath = dbPath ?? path.join(process.cwd(), "audit.db");
    _db = new Database(filePath);
    _db.pragma("journal_mode = WAL");
    _db.pragma("busy_timeout = 5000");
    _db.exec(`
      CREATE TABLE IF NOT EXISTS audit_log (
        id             INTEGER PRIMARY KEY AUTOINCREMENT,
        action         TEXT    NOT NULL,
        entityType     TEXT    NOT NULL,
        entityId       TEXT    NOT NULL,
        actorPublicKey TEXT    NOT NULL DEFAULT '',
        payload        TEXT    NOT NULL DEFAULT '{}',
        prevHash       TEXT    NOT NULL,
        hash           TEXT    NOT NULL,
        timestamp      TEXT    NOT NULL
      );

      -- Prevent UPDATE and DELETE to enforce immutability at the DB level
      CREATE TRIGGER IF NOT EXISTS audit_log_no_update
        BEFORE UPDATE ON audit_log
      BEGIN
        SELECT RAISE(ABORT, 'audit_log is immutable: UPDATE not permitted');
      END;

      CREATE TRIGGER IF NOT EXISTS audit_log_no_delete
        BEFORE DELETE ON audit_log
      BEGIN
        SELECT RAISE(ABORT, 'audit_log is immutable: DELETE not permitted');
      END;
    `);
    log.info({ dbPath: filePath }, "audit database opened");
  }
  return _db;
}

export function closeAuditDb(): void {
  _db?.close();
  _db = null;
}

// ── Hash helper ───────────────────────────────────────────────────────────────

function computeHash(
  prevHash: string,
  timestamp: string,
  action: string,
  entityType: string,
  entityId: string,
  payload: string,
): string {
  return createHash("sha256")
    .update(prevHash + timestamp + action + entityType + entityId + payload)
    .digest("hex");
}

// ── AuditLogger ───────────────────────────────────────────────────────────────

export class AuditLogger {
  private db: Database.Database;

  constructor(db?: Database.Database) {
    this.db = db ?? getAuditDb();
  }

  /**
   * Append a new audit record, chaining it to the tip of the log.
   */
  log(
    action: AuditAction,
    entityType: string,
    entityId: string,
    actorPublicKey: string,
    payload: unknown,
  ): void {
    const timestamp = new Date().toISOString();
    const payloadStr = JSON.stringify(payload ?? {});

    // Fetch the hash of the most recent record (tip of chain)
    const tip = this.db
      .prepare("SELECT hash FROM audit_log ORDER BY id DESC LIMIT 1")
      .get() as { hash: string } | undefined;

    const prevHash = tip?.hash ?? GENESIS_HASH;

    const hash = computeHash(
      prevHash,
      timestamp,
      action,
      entityType,
      entityId,
      payloadStr,
    );

    this.db
      .prepare(
        `INSERT INTO audit_log
           (action, entityType, entityId, actorPublicKey, payload, prevHash, hash, timestamp)
         VALUES
           (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        action,
        entityType,
        entityId,
        actorPublicKey,
        payloadStr,
        prevHash,
        hash,
        timestamp,
      );
  }

  /**
   * Re-compute every hash from genesis and report the first discrepancy.
   */
  verifyChain(): VerifyResult {
    const rows = this.db
      .prepare("SELECT * FROM audit_log ORDER BY id ASC")
      .all() as AuditRecord[];

    if (rows.length === 0) {
      return { valid: true };
    }

    let expectedPrevHash = GENESIS_HASH;

    for (const row of rows) {
      // Check prevHash linkage
      if (row.prevHash !== expectedPrevHash) {
        return { valid: false, firstBreak: row.id };
      }

      // Re-compute and verify hash
      const recomputed = computeHash(
        row.prevHash,
        row.timestamp,
        row.action,
        row.entityType,
        row.entityId,
        typeof row.payload === "string"
          ? row.payload
          : JSON.stringify(row.payload),
      );

      if (recomputed !== row.hash) {
        return { valid: false, firstBreak: row.id };
      }

      expectedPrevHash = row.hash;
    }

    return { valid: true };
  }
}

// ── Module-level singleton ────────────────────────────────────────────────────

let _auditLogger: AuditLogger | null = null;

export function getAuditLogger(): AuditLogger {
  if (!_auditLogger) {
    _auditLogger = new AuditLogger();
  }
  return _auditLogger;
}
