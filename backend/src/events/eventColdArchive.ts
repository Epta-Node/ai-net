/**
 * Cold tier for archived task events (issue #809).
 *
 * The retention pass (`EventRetentionService`, issue #383) moves compacted task
 * events into the `task_event_archive` table of the event database. This module
 * ages those rows out of SQLite into one gzip-compressed JSONL file per UTC day:
 *
 *   <EVENT_ARCHIVE_DIR>/YYYY/MM/DD/events.jsonl.gz          one JSON row per line
 *   <EVENT_ARCHIVE_DIR>/YYYY/MM/DD/events.jsonl.gz.sha256   SHA-256 sidecar
 *
 * Tiers
 * ─────
 * • hot   — `task_event_archive` rows newer than `EVENT_HOT_RETENTION_DAYS`
 * • cold  — day files for days older than that window, kept for
 *           `EVENT_COLD_RETENTION_DAYS`
 * • purge — day files older than the cold window are deleted
 *
 * Safety properties
 * ─────────────────
 * • Whole days only. A day moves to cold storage only when every row for it is
 *   older than the hot window, so a day is never split across tiers.
 * • Verify before delete. The file is written, its checksum is checked and its
 *   row count is read back, all before the SQLite rows are deleted. Each day's
 *   write and delete run in one SQLite transaction, so a failure leaves the rows
 *   where they were.
 * • Fail closed on read. A cold file whose checksum is missing or does not match
 *   is never trusted; restore throws instead.
 * • Idempotent. Re-archiving a day merges with the existing file, keyed by
 *   `(task_id, task_seq)`, so a repeated run never duplicates a row.
 * • Restore goes to `task_event_archive` (the queryable SQLite copy), using
 *   `INSERT OR IGNORE`. The live `task_events` table is not written, because the
 *   compaction pipeline owns it.
 *
 * The SQLite connection is injected, and this module imports only types from
 * `better-sqlite3`, so the Prometheus collector can import the size helpers
 * without opening a database.
 */

import { createHash } from "crypto";
import fs, { type Dirent } from "fs";
import path from "path";
import zlib from "zlib";
import type Database from "better-sqlite3";
import { getConfig } from "../config";
import { createLogger } from "../utils/logger";

const logger = createLogger({ component: "event-cold-archive" });

const MS_PER_DAY = 24 * 60 * 60 * 1000;
export const COLD_ARCHIVE_FILE = "events.jsonl.gz";
export const COLD_ARCHIVE_CHECKSUM_FILE = `${COLD_ARCHIVE_FILE}.sha256`;

/** One `task_event_archive` row, exactly as written to a JSONL line. */
export interface ColdArchiveRow {
  global_seq: number;
  task_seq: number;
  version: number;
  type: string;
  task_id: string;
  node_id: string;
  occurred_at: string;
  payload: string | null;
  archived_at: string;
}

export interface EventColdArchiveOptions {
  /** Root directory for the day files. */
  archiveDir: string;
  /** Days a row stays in the SQLite archive table before its day moves to cold storage. */
  hotRetentionDays: number;
  /** Days a day file is kept before it is purged. */
  coldRetentionDays: number;
  /** Clock, injectable for tests. */
  now?: () => Date;
}

export interface ColdArchiveCycleStats {
  daysArchived: number;
  eventsArchived: number;
  daysPurged: number;
}

/** `YYYY-MM-DD` for the UTC day containing an ISO-8601 timestamp. */
export function utcDayOf(iso: string): string {
  return iso.slice(0, 10);
}

/** Inclusive start and exclusive end of a `YYYY-MM-DD` UTC day, as ISO strings. */
function dayBounds(day: string): { start: string; end: string } {
  const start = new Date(`${day}T00:00:00.000Z`);
  const end = new Date(start.getTime() + MS_PER_DAY);
  return { start: start.toISOString(), end: end.toISOString() };
}

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** Path of a day's data file: `<root>/YYYY/MM/DD/events.jsonl.gz`. */
function dayFilePath(root: string, day: string): string {
  const [year, month, dayOfMonth] = day.split("-");
  return path.join(root, year, month, dayOfMonth, COLD_ARCHIVE_FILE);
}

/**
 * Read a day file, verifying its checksum first. Returns `[]` when the file does
 * not exist. A missing or mismatched checksum throws.
 */
function readDayFile(file: string): ColdArchiveRow[] {
  if (!fs.existsSync(file)) return [];
  const bytes = fs.readFileSync(file);
  const checksumPath = `${file}.sha256`;
  if (!fs.existsSync(checksumPath)) {
    throw new Error(`[event-cold-archive] checksum sidecar missing for ${file}; refusing to read`);
  }
  const expected = fs.readFileSync(checksumPath, "utf8").trim().split(/\s+/)[0];
  const actual = sha256(bytes);
  if (expected !== actual) {
    throw new Error(`[event-cold-archive] checksum mismatch for ${file}; refusing to read`);
  }
  const text = zlib.gunzipSync(bytes).toString("utf8");
  return text
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as ColdArchiveRow);
}

/** Write a day file atomically, with its checksum sidecar, then verify it by reading it back. */
function writeDayFile(file: string, rows: readonly ColdArchiveRow[]): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const body = zlib.gzipSync(rows.map((row) => `${JSON.stringify(row)}\n`).join(""));
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, body);
  fs.renameSync(tmp, file);
  fs.writeFileSync(`${file}.sha256`, `${sha256(body)}  ${COLD_ARCHIVE_FILE}\n`);

  const readBack = readDayFile(file);
  if (readBack.length !== rows.length) {
    throw new Error(
      `[event-cold-archive] read-back of ${file} returned ${readBack.length} rows, expected ${rows.length}`,
    );
  }
}

/** Union of two row sets, keyed by `(task_id, task_seq)`. Existing rows win. */
function mergeRows(existing: readonly ColdArchiveRow[], incoming: readonly ColdArchiveRow[]): ColdArchiveRow[] {
  const byKey = new Map<string, ColdArchiveRow>();
  for (const row of [...existing, ...incoming]) {
    const key = `${row.task_id}\u0000${row.task_seq}`;
    if (!byKey.has(key)) byKey.set(key, row);
  }
  return [...byKey.values()].sort(
    (a, b) =>
      a.occurred_at.localeCompare(b.occurred_at) ||
      a.task_id.localeCompare(b.task_id) ||
      a.task_seq - b.task_seq,
  );
}

/** Day directories under the archive root as `YYYY-MM-DD`, oldest first. */
function listArchivedDays(root: string): string[] {
  const days: string[] = [];
  const years = readDirNames(root, /^\d{4}$/);
  for (const year of years) {
    for (const month of readDirNames(path.join(root, year), /^\d{2}$/)) {
      for (const dayOfMonth of readDirNames(path.join(root, year, month), /^\d{2}$/)) {
        days.push(`${year}-${month}-${dayOfMonth}`);
      }
    }
  }
  return days.sort();
}

function readDirNames(dir: string, pattern: RegExp): string[] {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && pattern.test(entry.name))
      .map((entry) => entry.name)
      .sort();
  } catch {
    return [];
  }
}

/** Total size in bytes of every file under `dir`. Zero when the directory is absent. */
export function directorySizeBytes(dir: string): number {
  let total = 0;
  let entries: Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) total += directorySizeBytes(full);
    else if (entry.isFile()) total += fs.statSync(full).size;
  }
  return total;
}

export class EventColdArchive {
  private readonly db: Database.Database;
  private readonly options: EventColdArchiveOptions;

  constructor(db: Database.Database, options: EventColdArchiveOptions) {
    this.db = db;
    this.options = options;
  }

  private now(): Date {
    return this.options.now ? this.options.now() : new Date();
  }

  /**
   * One full cycle: move every complete day older than the hot window to cold
   * storage, then purge day files older than the cold window.
   */
  runCycle(): ColdArchiveCycleStats {
    const hotCutoff = new Date(this.now().getTime() - this.options.hotRetentionDays * MS_PER_DAY);
    const cutoffDayStart = dayBounds(utcDayOf(hotCutoff.toISOString())).start;

    const candidates = this.db
      .prepare(
        `SELECT DISTINCT substr(occurred_at, 1, 10) AS day
           FROM task_event_archive
          WHERE occurred_at < ?
          ORDER BY day ASC`,
      )
      .all(cutoffDayStart) as Array<{ day: string }>;

    let daysArchived = 0;
    let eventsArchived = 0;
    for (const { day } of candidates) {
      const moved = this.archiveDay(day);
      if (moved > 0) {
        daysArchived += 1;
        eventsArchived += moved;
      }
    }

    const daysPurged = this.purgeExpired();
    const stats = { daysArchived, eventsArchived, daysPurged };
    logger.info({ ...stats }, "event cold archive cycle completed");
    return stats;
  }

  /**
   * Move one UTC day's rows from the archive table into its day file, then delete
   * them from SQLite, in one transaction. Returns how many rows moved.
   */
  archiveDay(day: string): number {
    const { start, end } = dayBounds(day);
    const tx = this.db.transaction((): number => {
      const rows = this.db
        .prepare(
          `SELECT global_seq, task_seq, version, type, task_id, node_id, occurred_at, payload, archived_at
             FROM task_event_archive
            WHERE occurred_at >= ? AND occurred_at < ?
            ORDER BY occurred_at ASC, task_id ASC, task_seq ASC`,
        )
        .all(start, end) as ColdArchiveRow[];
      if (rows.length === 0) return 0;

      const file = dayFilePath(this.options.archiveDir, day);
      const merged = mergeRows(readDayFile(file), rows);
      writeDayFile(file, merged);

      this.db
        .prepare("DELETE FROM task_event_archive WHERE occurred_at >= ? AND occurred_at < ?")
        .run(start, end);
      return rows.length;
    });
    return tx();
  }

  /**
   * Load every archived event whose day falls between `fromDay` and `toDay`
   * (inclusive, `YYYY-MM-DD`) back into `task_event_archive`. Returns how many
   * rows were newly inserted. Rows already present are skipped.
   */
  restoreRange(fromDay: string, toDay: string): number {
    const days = listArchivedDays(this.options.archiveDir).filter((day) => day >= fromDay && day <= toDay);
    const insert = this.db.prepare(
      `INSERT OR IGNORE INTO task_event_archive
         (global_seq, task_seq, version, type, task_id, node_id, occurred_at, payload, archived_at)
       VALUES (@global_seq, @task_seq, @version, @type, @task_id, @node_id, @occurred_at, @payload, @archived_at)`,
    );
    const tx = this.db.transaction((): number => {
      let inserted = 0;
      for (const day of days) {
        for (const row of readDayFile(dayFilePath(this.options.archiveDir, day))) {
          inserted += insert.run(row).changes;
        }
      }
      return inserted;
    });
    return tx();
  }

  /** Delete day directories older than the cold retention window. Returns how many days were purged. */
  purgeExpired(): number {
    const coldCutoffDay = utcDayOf(
      new Date(this.now().getTime() - this.options.coldRetentionDays * MS_PER_DAY).toISOString(),
    );
    let purged = 0;
    for (const day of listArchivedDays(this.options.archiveDir)) {
      if (day >= coldCutoffDay) break;
      const [year, month, dayOfMonth] = day.split("-");
      fs.rmSync(path.join(this.options.archiveDir, year, month, dayOfMonth), { recursive: true, force: true });
      purged += 1;
    }
    return purged;
  }
}

/** Size of the event database file in bytes (0 for `:memory:` or a missing file). */
export function getEventStoreHotSizeBytes(): number {
  try {
    const storePath = getConfig().EVENT_STORE_PATH;
    if (storePath === ":memory:") return 0;
    return fs.statSync(storePath).size;
  } catch {
    return 0;
  }
}

/** Total size in bytes of the cold day files. */
export function getEventStoreColdSizeBytes(): number {
  try {
    return directorySizeBytes(getConfig().EVENT_ARCHIVE_DIR);
  } catch {
    return 0;
  }
}

/**
 * Run the cold cycle against the live event database, using the connection and
 * config values at call time. Returns `null` when no event database is open
 * (for example, `:memory:`). Scheduled daily by `DbMaintenanceService`.
 */
export function runDefaultEventColdArchive(): ColdArchiveCycleStats | null {
  // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires
  const { getEventStoreConnection } = require("./eventStore") as typeof import("./eventStore");
  const connection = getEventStoreConnection();
  if (!connection) return null;
  const cfg = getConfig();
  const archive = new EventColdArchive(connection, {
    archiveDir: cfg.EVENT_ARCHIVE_DIR,
    hotRetentionDays: cfg.EVENT_HOT_RETENTION_DAYS,
    coldRetentionDays: cfg.EVENT_COLD_RETENTION_DAYS,
  });
  return archive.runCycle();
}
