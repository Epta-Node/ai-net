import fs from "fs";
import os from "os";
import path from "path";
import Database from "better-sqlite3";
import {
  loadMigrations,
  getAppliedMigrations,
  getPendingMigrations,
  migrateToLatest,
  rollback,
} from "./migrator";

function writeMigration(
  dir: string,
  version: number,
  name: string,
  upSql: string,
  downSql: string,
): void {
  fs.writeFileSync(path.join(dir, `${version}_${name}.up.sql`), upSql);
  fs.writeFileSync(path.join(dir, `${version}_${name}.down.sql`), downSql);
}

describe("migrator", () => {
  let dir: string;
  let db: Database.Database;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "migrator-test-"));
    db = new Database(":memory:");
  });

  afterEach(() => {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  describe("loadMigrations", () => {
    it("returns an empty array for a directory that doesn't exist", () => {
      expect(loadMigrations(path.join(dir, "nope"))).toEqual([]);
    });

    it("pairs up .up.sql / .down.sql files and sorts by version", () => {
      writeMigration(dir, 2, "second", "CREATE TABLE b (id TEXT);", "DROP TABLE b;");
      writeMigration(dir, 1, "first", "CREATE TABLE a (id TEXT);", "DROP TABLE a;");

      const migrations = loadMigrations(dir);

      expect(migrations.map((m) => m.version)).toEqual([1, 2]);
      expect(migrations[0].name).toBe("first");
      expect(migrations[1].name).toBe("second");
    });

    it("throws when an up migration has no matching down file", () => {
      fs.writeFileSync(path.join(dir, "1_orphan.up.sql"), "CREATE TABLE a (id TEXT);");

      expect(() => loadMigrations(dir)).toThrow(/no matching \.down\.sql/);
    });

    it("throws on a duplicate version number", () => {
      writeMigration(dir, 1, "first", "CREATE TABLE a (id TEXT);", "DROP TABLE a;");
      writeMigration(dir, 1, "duplicate", "CREATE TABLE a2 (id TEXT);", "DROP TABLE a2;");

      expect(() => loadMigrations(dir)).toThrow(/Duplicate migration version/);
    });
  });

  describe("migrateToLatest — from scratch and from latest", () => {
    it("applies every pending migration in order and records them in the ledger", () => {
      writeMigration(dir, 1, "create_users", "CREATE TABLE users (id TEXT PRIMARY KEY);", "DROP TABLE users;");
      writeMigration(
        dir,
        2,
        "add_email",
        "ALTER TABLE users ADD COLUMN email TEXT;",
        "ALTER TABLE users DROP COLUMN email;",
      );

      const { applied } = migrateToLatest(db, dir);

      expect(applied).toEqual(["1_create_users", "2_add_email"]);
      expect(
        db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='users'").get(),
      ).toBeTruthy();
      expect(db.prepare("PRAGMA table_info(users)").all()).toEqual(
        expect.arrayContaining([expect.objectContaining({ name: "email" })]),
      );

      const ledger = getAppliedMigrations(db);
      expect(ledger.map((m) => m.version)).toEqual([1, 2]);
    });

    it("is a no-op when already at the latest version (from scratch, then again)", () => {
      writeMigration(dir, 1, "create_users", "CREATE TABLE users (id TEXT PRIMARY KEY);", "DROP TABLE users;");

      migrateToLatest(db, dir);
      const second = migrateToLatest(db, dir);

      expect(second.applied).toEqual([]);
      expect(getAppliedMigrations(db)).toHaveLength(1);
    });

    it("only applies newly-added migrations when run again after more are added", () => {
      writeMigration(dir, 1, "create_users", "CREATE TABLE users (id TEXT PRIMARY KEY);", "DROP TABLE users;");
      migrateToLatest(db, dir);

      writeMigration(dir, 2, "create_posts", "CREATE TABLE posts (id TEXT PRIMARY KEY);", "DROP TABLE posts;");
      const { applied } = migrateToLatest(db, dir);

      expect(applied).toEqual(["2_create_posts"]);
    });

    it("getPendingMigrations reflects only what hasn't been applied yet", () => {
      writeMigration(dir, 1, "create_users", "CREATE TABLE users (id TEXT PRIMARY KEY);", "DROP TABLE users;");
      writeMigration(dir, 2, "create_posts", "CREATE TABLE posts (id TEXT PRIMARY KEY);", "DROP TABLE posts;");

      expect(getPendingMigrations(db, dir).map((m) => m.version)).toEqual([1, 2]);
      migrateToLatest(db, dir);
      expect(getPendingMigrations(db, dir)).toEqual([]);
    });

    it("rolls the whole migration back if one statement in it fails", () => {
      writeMigration(dir, 1, "create_users", "CREATE TABLE users (id TEXT PRIMARY KEY);", "DROP TABLE users;");
      writeMigration(
        dir,
        2,
        "broken",
        "CREATE TABLE ok (id TEXT); THIS IS NOT VALID SQL;",
        "DROP TABLE ok;",
      );

      expect(() => migrateToLatest(db, dir)).toThrow();
      // Migration 1 still applied (its own transaction succeeded); migration
      // 2's table creation must not have partially landed.
      expect(getAppliedMigrations(db).map((m) => m.version)).toEqual([1]);
      expect(
        db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='ok'").get(),
      ).toBeUndefined();
    });

    it("detects checksum drift on an already-applied migration and refuses to run", () => {
      writeMigration(dir, 1, "create_users", "CREATE TABLE users (id TEXT PRIMARY KEY);", "DROP TABLE users;");
      migrateToLatest(db, dir);

      // Simulate someone editing an already-applied migration file in place.
      fs.writeFileSync(
        path.join(dir, "1_create_users.up.sql"),
        "CREATE TABLE users (id TEXT PRIMARY KEY, extra TEXT);",
      );

      expect(() => migrateToLatest(db, dir)).toThrow(/Checksum mismatch/);
    });
  });

  describe("rollback — to a prior version", () => {
    it("undoes the most recently applied migration by default", () => {
      writeMigration(dir, 1, "create_users", "CREATE TABLE users (id TEXT PRIMARY KEY);", "DROP TABLE users;");
      writeMigration(dir, 2, "create_posts", "CREATE TABLE posts (id TEXT PRIMARY KEY);", "DROP TABLE posts;");
      migrateToLatest(db, dir);

      const { rolledBack } = rollback(db, dir);

      expect(rolledBack).toEqual(["2_create_posts"]);
      expect(
        db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='posts'").get(),
      ).toBeUndefined();
      expect(
        db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='users'").get(),
      ).toBeTruthy();
      expect(getAppliedMigrations(db).map((m) => m.version)).toEqual([1]);
    });

    it("rolls back multiple steps in reverse order", () => {
      writeMigration(dir, 1, "create_users", "CREATE TABLE users (id TEXT PRIMARY KEY);", "DROP TABLE users;");
      writeMigration(dir, 2, "create_posts", "CREATE TABLE posts (id TEXT PRIMARY KEY);", "DROP TABLE posts;");
      writeMigration(dir, 3, "create_comments", "CREATE TABLE comments (id TEXT PRIMARY KEY);", "DROP TABLE comments;");
      migrateToLatest(db, dir);

      const { rolledBack } = rollback(db, dir, 2);

      expect(rolledBack).toEqual(["3_create_comments", "2_create_posts"]);
      expect(getAppliedMigrations(db).map((m) => m.version)).toEqual([1]);
    });

    it("a rolled-back database can be migrated forward again", () => {
      writeMigration(dir, 1, "create_users", "CREATE TABLE users (id TEXT PRIMARY KEY);", "DROP TABLE users;");
      writeMigration(dir, 2, "create_posts", "CREATE TABLE posts (id TEXT PRIMARY KEY);", "DROP TABLE posts;");
      migrateToLatest(db, dir);
      rollback(db, dir, 1);

      const { applied } = migrateToLatest(db, dir);

      expect(applied).toEqual(["2_create_posts"]);
      expect(
        db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='posts'").get(),
      ).toBeTruthy();
    });

    it("is a no-op when nothing has been applied", () => {
      writeMigration(dir, 1, "create_users", "CREATE TABLE users (id TEXT PRIMARY KEY);", "DROP TABLE users;");

      const { rolledBack } = rollback(db, dir);

      expect(rolledBack).toEqual([]);
    });
  });
});
