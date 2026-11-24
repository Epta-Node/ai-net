import Database from "better-sqlite3";
import {
  AUDIT_CHAIN_CSV_HEADER,
  AuditLog,
  GENESIS_AUDIT_HASH,
  auditChainRowToCsv,
  ensureAuditChainColumns,
  type AuditAppendInput,
} from "./auditLog";

/** The admin audit table as it existed before hash chaining (#808). */
function makeLegacyDb(): Database.Database {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE admin_audit_log (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      at         TEXT NOT NULL,
      actor      TEXT NOT NULL,
      action     TEXT NOT NULL,
      target     TEXT,
      statusCode INTEGER NOT NULL,
      requestId  TEXT,
      details    TEXT
    )
  `);
  ensureAuditChainColumns(db);
  return db;
}

function entry(n: number, action = "admin.agent.suspend"): AuditAppendInput {
  return {
    at: `2026-10-0${n}T00:00:00.000Z`,
    actor: "wallet-admin",
    action,
    target: `agent-${n}`,
    statusCode: 200,
    requestId: `req-${n}`,
    details: JSON.stringify({ n }),
  };
}

describe("AuditLog hash chain", () => {
  it("links each entry to the hash of the one before it", () => {
    const log = new AuditLog(makeLegacyDb());
    const first = log.append(entry(1));
    const second = log.append(entry(2));

    expect(first.prevHash).toBe(GENESIS_AUDIT_HASH);
    expect(second.prevHash).toBe(first.hash);
    expect(second.hash).not.toBe(first.hash);
  });

  it("verifies an untampered chain as valid", () => {
    const log = new AuditLog(makeLegacyDb());
    log.append(entry(1));
    log.append(entry(2));
    log.append(entry(3));

    expect(log.verify()).toEqual({ valid: true, checked: 3, legacyRows: 0 });
  });

  it("reports the first entry whose content was edited", () => {
    const db = makeLegacyDb();
    const log = new AuditLog(db);
    log.append(entry(1));
    log.append(entry(2));
    log.append(entry(3));

    db.prepare("UPDATE admin_audit_log SET actor = 'mallory' WHERE id = 2").run();

    expect(log.verify()).toMatchObject({ valid: false, firstBrokenAt: "2" });
  });

  it("reports the row after a deleted entry from the middle of the chain", () => {
    const db = makeLegacyDb();
    const log = new AuditLog(db);
    log.append(entry(1));
    log.append(entry(2));
    log.append(entry(3));

    db.prepare("DELETE FROM admin_audit_log WHERE id = 2").run();

    expect(log.verify()).toMatchObject({ valid: false, firstBrokenAt: "3" });
  });

  it("treats retention pruning of the oldest rows as valid", () => {
    const db = makeLegacyDb();
    const log = new AuditLog(db);
    log.append(entry(1));
    log.append(entry(2));
    log.append(entry(3));

    db.prepare("DELETE FROM admin_audit_log WHERE id = 1").run();

    expect(log.verify()).toEqual({ valid: true, checked: 2, legacyRows: 0 });
  });

  it("counts pre-chaining rows as legacy and chains new entries from genesis", () => {
    const db = makeLegacyDb();
    db.prepare(
      "INSERT INTO admin_audit_log (id, at, actor, action, statusCode) VALUES (1, ?, 'legacy', 'old.action', 200)",
    ).run("2025-01-01T00:00:00.000Z");
    const log = new AuditLog(db);
    const appended = log.append(entry(2));

    expect(appended.prevHash).toBe(GENESIS_AUDIT_HASH);
    expect(log.verify()).toEqual({ valid: true, checked: 1, legacyRows: 1 });
  });

  it("flags a legacy row that appears after the chain has started", () => {
    const db = makeLegacyDb();
    const log = new AuditLog(db);
    log.append(entry(1));
    db.prepare(
      "INSERT INTO admin_audit_log (id, at, actor, action, statusCode) VALUES (5, ?, 'injected', 'x', 200)",
    ).run("2026-10-09T00:00:00.000Z");

    expect(log.verify()).toMatchObject({ valid: false, firstBrokenAt: "5" });
  });
});

describe("AuditLog listing", () => {
  it("pages newest first and parses stored details", () => {
    const log = new AuditLog(makeLegacyDb());
    for (let n = 1; n <= 5; n += 1) log.append(entry(n));

    const page = log.list({ page: 1, pageSize: 2 });

    expect(page.map((e) => e.id)).toEqual([5, 4]);
    expect(page[0]!.details).toEqual({ n: 5 });
    expect(log.list({ page: 3, pageSize: 2 }).map((e) => e.id)).toEqual([1]);
  });

  it("filters by exact action name", () => {
    const log = new AuditLog(makeLegacyDb());
    log.append(entry(1, "admin.agent.suspend"));
    log.append(entry(2, "admin.dlq.replay"));
    log.append(entry(3, "admin.agent.suspend"));

    const suspends = log.list({ page: 1, pageSize: 10, action: "admin.agent.suspend" });

    expect(suspends.map((e) => e.id)).toEqual([3, 1]);
  });
});

describe("AuditLog CSV export", () => {
  it("truncates both hashes to 16 characters and keeps the header in step", () => {
    const log = new AuditLog(makeLegacyDb());
    const row = log.append(entry(1));
    const line = auditChainRowToCsv(row);

    expect(line).toContain(row.hash!.slice(0, 16));
    expect(line).not.toContain(row.hash!);
    expect(AUDIT_CHAIN_CSV_HEADER.split(",")).toHaveLength(10);
    expect(line.split(",")).toHaveLength(10);
  });

  it("neutralises formula-like cells", () => {
    const log = new AuditLog(makeLegacyDb());
    const row = log.append({ ...entry(1), actor: "=HYPERLINK(\"http://evil\")" });

    // A leading apostrophe stops spreadsheet apps evaluating the cell as a formula.
    expect(auditChainRowToCsv(row)).toContain("\"'=HYPERLINK");
  });

  it("streams rows newest first in bounded batches", () => {
    const log = new AuditLog(makeLegacyDb());
    for (let n = 1; n <= 4; n += 1) log.append(entry(n));

    const ids = [...log.iterateRows(3)].flat().map((row) => row.id);

    expect(ids).toEqual([4, 3, 2]);
  });
});
