/**
 * Cold event archive — real-SQLite tests (issue #809).
 *
 * Runs under `jest.sqlite.config.js` because the cold tier depends on real
 * SQLite transactions and on real gzip/checksum files, which a stub cannot
 * exercise. Each test uses its own temporary database and archive directory.
 */

import fs from "fs";
import os from "os";
import path from "path";
import Database from "better-sqlite3";
import { ARCHIVE_DDL } from "../../src/events/eventArchive";
import { EventColdArchive, COLD_ARCHIVE_FILE } from "../../src/events/eventColdArchive";

const NOW = new Date("2026-10-18T12:00:00.000Z");
const HOT_DAYS = 7;
const COLD_DAYS = 90;

let tmpDir: string;
let archiveDir: string;
let db: Database.Database;
let nextSeq: number;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ainet-cold-archive-"));
  archiveDir = path.join(tmpDir, "archive");
  db = new Database(path.join(tmpDir, "events.db"));
  db.exec(ARCHIVE_DDL);
  nextSeq = 1;
});

afterEach(() => {
  db.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

/** Insert one archived event row at `occurredAt`. */
function insertArchivedRow(occurredAt: string, taskId = "task_a"): void {
  const seq = nextSeq;
  nextSeq += 1;
  db.prepare(
    `INSERT INTO task_event_archive
       (global_seq, task_seq, version, type, task_id, node_id, occurred_at, payload, archived_at)
     VALUES (?, ?, 1, 'TaskCreated', ?, '', ?, '{"n":1}', ?)`,
  ).run(seq, seq, taskId, occurredAt, occurredAt);
}

function archiveRowCount(): number {
  return (db.prepare("SELECT COUNT(*) AS n FROM task_event_archive").get() as { n: number }).n;
}

function makeArchive(now: Date = NOW): EventColdArchive {
  return new EventColdArchive(db, {
    archiveDir,
    hotRetentionDays: HOT_DAYS,
    coldRetentionDays: COLD_DAYS,
    now: () => now,
  });
}

function dayFile(day: string): string {
  const [y, m, d] = day.split("-");
  return path.join(archiveDir, y, m, d, COLD_ARCHIVE_FILE);
}

describe("EventColdArchive.runCycle", () => {
  it("moves whole days older than the hot window to cold files and keeps recent rows in SQLite", () => {
    insertArchivedRow("2026-10-01T05:00:00.000Z");
    insertArchivedRow("2026-10-10T23:00:00.000Z");
    // 2026-10-11 is the cutoff day, so it is not a complete cold day yet.
    insertArchivedRow("2026-10-11T01:00:00.000Z");
    insertArchivedRow("2026-10-17T00:00:00.000Z");

    const stats = makeArchive().runCycle();

    expect(stats).toMatchObject({ daysArchived: 2, eventsArchived: 2, daysPurged: 0 });
    expect(archiveRowCount()).toBe(2);
    expect(fs.existsSync(dayFile("2026-10-01"))).toBe(true);
    expect(fs.existsSync(dayFile("2026-10-10"))).toBe(true);
    expect(fs.existsSync(`${dayFile("2026-10-01")}.sha256`)).toBe(true);
  });

  it("writes a SHA-256 sidecar in sha256sum format", () => {
    insertArchivedRow("2026-10-01T05:00:00.000Z");
    makeArchive().runCycle();

    const sidecar = fs.readFileSync(`${dayFile("2026-10-01")}.sha256`, "utf8");
    expect(sidecar).toMatch(new RegExp(`^[0-9a-f]{64}  ${COLD_ARCHIVE_FILE}\\n$`));
  });

  it("does nothing on a second pass over the same data", () => {
    insertArchivedRow("2026-10-01T05:00:00.000Z");
    makeArchive().runCycle();

    expect(makeArchive().runCycle()).toMatchObject({ daysArchived: 0, eventsArchived: 0 });
  });
});

describe("EventColdArchive.restoreRange", () => {
  it("round-trips archived events back into the archive table", () => {
    insertArchivedRow("2026-10-01T05:00:00.000Z", "task_a");
    insertArchivedRow("2026-10-10T23:00:00.000Z", "task_b");
    makeArchive().runCycle();
    expect(archiveRowCount()).toBe(0);

    const restored = makeArchive().restoreRange("2026-10-01", "2026-10-10");

    expect(restored).toBe(2);
    const rows = db
      .prepare("SELECT task_id, payload FROM task_event_archive ORDER BY task_id")
      .all() as Array<{ task_id: string; payload: string }>;
    expect(rows).toEqual([
      { task_id: "task_a", payload: '{"n":1}' },
      { task_id: "task_b", payload: '{"n":1}' },
    ]);
  });

  it("refuses a file whose contents no longer match its checksum", () => {
    insertArchivedRow("2026-10-01T05:00:00.000Z");
    makeArchive().runCycle();
    fs.appendFileSync(dayFile("2026-10-01"), "tampered");

    expect(() => makeArchive().restoreRange("2026-10-01", "2026-10-01")).toThrow(/checksum mismatch/);
  });
});

describe("EventColdArchive merge and failure handling", () => {
  it("merges a late row into an existing day file without duplicating earlier rows", () => {
    insertArchivedRow("2026-10-01T05:00:00.000Z", "task_a");
    makeArchive().runCycle();

    insertArchivedRow("2026-10-01T06:00:00.000Z", "task_late");
    makeArchive().runCycle();

    // Both rows come back, each exactly once.
    expect(makeArchive().restoreRange("2026-10-01", "2026-10-01")).toBe(2);
  });

  it("keeps SQLite rows and writes nothing when the existing file fails its checksum", () => {
    insertArchivedRow("2026-10-01T05:00:00.000Z", "task_a");
    makeArchive().runCycle();
    fs.appendFileSync(dayFile("2026-10-01"), "tampered");

    insertArchivedRow("2026-10-01T06:00:00.000Z", "task_late");
    expect(() => makeArchive().archiveDay("2026-10-01")).toThrow(/checksum mismatch/);

    expect(archiveRowCount()).toBe(1);
  });
});

describe("EventColdArchive.purgeExpired", () => {
  it("deletes day files older than the cold window and keeps newer ones", () => {
    insertArchivedRow("2026-06-01T10:00:00.000Z", "task_old");
    insertArchivedRow("2026-10-01T10:00:00.000Z", "task_recent");

    const stats = makeArchive().runCycle();

    expect(stats.daysPurged).toBe(1);
    expect(fs.existsSync(dayFile("2026-06-01"))).toBe(false);
    expect(fs.existsSync(dayFile("2026-10-01"))).toBe(true);
  });
});
