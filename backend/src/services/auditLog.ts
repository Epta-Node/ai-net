/**
 * Tamper-evident, hash-chained admin audit log (issue #808).
 *
 * Every entry stores `prevHash` (the `hash` of the entry before it) and `hash`
 * (SHA-256 over this entry's canonical fields plus `prevHash`). Editing any row
 * breaks the chain at that row, and deleting a row from the middle breaks it at
 * the row after the gap. {@link AuditLog.verify} reports the first id where it
 * breaks.
 *
 * Rows written before chaining existed carry `hash = NULL`. They are counted
 * as `legacyRows` and skipped, provided they all sit before the first chained
 * row. A legacy row that appears after a chained one is treated as tampering.
 *
 * The log lives in the admin audit database, which is already separate from
 * the agent, task and payment stores, so truncating those cannot erase it.
 */

import { createHash } from "crypto";
import type Database from "better-sqlite3";

/** `prevHash` of the first chained entry ever written. */
export const GENESIS_AUDIT_HASH = "0".repeat(64);

/** Hashes are truncated to this many characters in CSV exports. */
export const AUDIT_CSV_HASH_CHARS = 16;

/** Rows fetched per query while streaming an export. */
const EXPORT_BATCH_SIZE = 500;

/** A stored row, exactly as it sits in `admin_audit_log`. */
export interface AuditChainRow {
  id: number;
  at: string;
  actor: string;
  action: string;
  target: string | null;
  statusCode: number;
  requestId: string | null;
  /** Serialised, already-redacted JSON, or null. */
  details: string | null;
  prevHash: string | null;
  hash: string | null;
}

/** An entry as returned to API callers: details parsed, hashes included. */
export interface AuditEntryView extends Omit<AuditChainRow, "details"> {
  details?: unknown;
}

/** Fields the caller supplies when appending. `details` is already serialised. */
export interface AuditAppendInput {
  at: string;
  actor: string;
  action: string;
  target?: string | null;
  statusCode: number;
  requestId?: string | null;
  details?: string | null;
}

export interface AuditListOptions {
  /** 1-based page number. */
  page: number;
  pageSize: number;
  /** Only entries with this exact action name. */
  action?: string;
}

export interface AuditChainVerification {
  valid: boolean;
  /** Id of the first entry that fails verification, as a string. */
  firstBrokenAt?: string;
  /** Chained entries that verified. */
  checked: number;
  /** Pre-chaining entries that were skipped. */
  legacyRows: number;
}

type HashedFields = Omit<AuditChainRow, "prevHash" | "hash">;

/**
 * SHA-256 over a fixed-order JSON array of the entry's fields and `prevHash`.
 * An array keeps the serialisation canonical without depending on key order.
 */
export function computeAuditHash(fields: HashedFields, prevHash: string): string {
  const canonical = JSON.stringify([
    prevHash,
    fields.id,
    fields.at,
    fields.actor,
    fields.action,
    fields.target,
    fields.statusCode,
    fields.requestId,
    fields.details,
  ]);
  return createHash("sha256").update(canonical).digest("hex");
}

/** Cells that spreadsheet apps would evaluate as formulas. */
const CSV_FORMULA_PREFIX = /^[=+\-@\t\r]/;

function csvCell(value: unknown): string {
  let text = value === undefined || value === null ? "" : String(value);
  if (CSV_FORMULA_PREFIX.test(text)) text = `'${text}`;
  return `"${text.replace(/"/g, '""')}"`;
}

export const AUDIT_CHAIN_CSV_HEADER = [
  "id",
  "at",
  "actor",
  "action",
  "target",
  "statusCode",
  "requestId",
  "details",
  "prevHash",
  "hash",
].join(",");

/** One CSV line for a stored row. Hashes are truncated for readability. */
export function auditChainRowToCsv(row: AuditChainRow): string {
  const truncate = (value: string | null): string | null =>
    value === null ? null : value.slice(0, AUDIT_CSV_HASH_CHARS);
  return [
    row.id,
    row.at,
    row.actor,
    row.action,
    row.target,
    row.statusCode,
    row.requestId,
    row.details,
    truncate(row.prevHash),
    truncate(row.hash),
  ]
    .map(csvCell)
    .join(",");
}

/** Ensure the chain columns exist on a database created before #808. */
export function ensureAuditChainColumns(db: Database.Database): void {
  const columns = db.prepare("PRAGMA table_info(admin_audit_log)").all() as Array<{ name: string }>;
  const names = new Set(columns.map((column) => column.name));
  if (!names.has("prevHash")) db.exec("ALTER TABLE admin_audit_log ADD COLUMN prevHash TEXT");
  if (!names.has("hash")) db.exec("ALTER TABLE admin_audit_log ADD COLUMN hash TEXT");
}

const SELECT_COLUMNS = "id, at, actor, action, target, statusCode, requestId, details, prevHash, hash";

function parseDetails(raw: string | null): unknown {
  if (!raw) return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    // A row written by hand can hold non-JSON text; return it as-is rather than failing the list.
    return raw;
  }
}

function toView(row: AuditChainRow): AuditEntryView {
  return { ...row, details: parseDetails(row.details) };
}

/**
 * The chained audit log over one `admin_audit_log` table. Methods are
 * synchronous because better-sqlite3 is; `append` runs read-last-hash and
 * insert in one transaction, so concurrent writers cannot fork the chain.
 */
export class AuditLog {
  constructor(private readonly db: Database.Database) {}

  /** Append an entry, linking it to the current chain head. */
  append(input: AuditAppendInput): AuditChainRow {
    const write = this.db.transaction((): AuditChainRow => {
      const head = this.db
        .prepare("SELECT id, hash FROM admin_audit_log ORDER BY id DESC LIMIT 1")
        .get() as { id: number; hash: string | null } | undefined;
      const id = (head?.id ?? 0) + 1;
      const prevHash = head?.hash ?? GENESIS_AUDIT_HASH;

      const fields: HashedFields = {
        id,
        at: input.at,
        actor: input.actor,
        action: input.action,
        target: input.target ?? null,
        statusCode: input.statusCode,
        requestId: input.requestId ?? null,
        details: input.details ?? null,
      };
      const row: AuditChainRow = { ...fields, prevHash, hash: computeAuditHash(fields, prevHash) };

      this.db
        .prepare(
          `INSERT INTO admin_audit_log
             (id, at, actor, action, target, statusCode, requestId, details, prevHash, hash)
           VALUES
             (@id, @at, @actor, @action, @target, @statusCode, @requestId, @details, @prevHash, @hash)`,
        )
        .run(row);
      return row;
    });
    return write();
  }

  /** One page of entries, newest first, optionally filtered by action. */
  list(options: AuditListOptions): AuditEntryView[] {
    const pageSize = Math.min(Math.max(options.pageSize, 1), 200);
    const offset = (Math.max(options.page, 1) - 1) * pageSize;
    const rows = options.action
      ? (this.db
          .prepare(
            `SELECT ${SELECT_COLUMNS} FROM admin_audit_log
             WHERE action = ? ORDER BY id DESC LIMIT ? OFFSET ?`,
          )
          .all(options.action, pageSize, offset) as AuditChainRow[])
      : (this.db
          .prepare(`SELECT ${SELECT_COLUMNS} FROM admin_audit_log ORDER BY id DESC LIMIT ? OFFSET ?`)
          .all(pageSize, offset) as AuditChainRow[]);
    return rows.map(toView);
  }

  /**
   * Walk the chain oldest-first and recompute every hash. Streams rows with
   * `iterate()`, so memory stays flat however large the log grows.
   */
  verify(): AuditChainVerification {
    const statement = this.db.prepare(`SELECT ${SELECT_COLUMNS} FROM admin_audit_log ORDER BY id ASC`);
    let previousHash: string | null = null;
    let checked = 0;
    let legacyRows = 0;

    for (const row of statement.iterate() as IterableIterator<AuditChainRow>) {
      if (row.hash === null) {
        // Legacy rows may only precede the chain.
        if (previousHash !== null) {
          return { valid: false, firstBrokenAt: String(row.id), checked, legacyRows };
        }
        legacyRows += 1;
        continue;
      }

      // The first surviving chained row anchors the chain: retention pruning
      // removes the oldest rows, so its `prevHash` cannot be checked against
      // genesis. It is still covered by the row's own hash.
      const broken =
        row.prevHash === null ||
        (previousHash !== null && row.prevHash !== previousHash) ||
        computeAuditHash(row, row.prevHash) !== row.hash;
      if (broken) {
        return { valid: false, firstBrokenAt: String(row.id), checked, legacyRows };
      }
      previousHash = row.hash;
      checked += 1;
    }

    return { valid: true, checked, legacyRows };
  }

  /**
   * Newest-first batches for export, keyset-paginated and capped at `maxRows`.
   */
  *iterateRows(maxRows: number): Generator<AuditChainRow[]> {
    const statement = this.db.prepare(
      `SELECT ${SELECT_COLUMNS} FROM admin_audit_log WHERE id < ? ORDER BY id DESC LIMIT ?`,
    );
    let remaining = Math.max(0, maxRows);
    let beforeId = Number.MAX_SAFE_INTEGER;

    while (remaining > 0) {
      const rows = statement.all(beforeId, Math.min(EXPORT_BATCH_SIZE, remaining)) as AuditChainRow[];
      if (rows.length === 0) return;
      yield rows;
      remaining -= rows.length;
      beforeId = rows[rows.length - 1]!.id;
    }
  }
}
