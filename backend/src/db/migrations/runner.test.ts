import Database from "better-sqlite3";
import fs from "fs";
import path from "path";
import os from "os";
import request from "supertest";
import {
  runMigrations,
  rollbackMigrations,
  getMigrationStatus,
  loadMigrations,
  parseMigrationSql,
  getAppliedMigrations,
  isApplied,
} from "./index";
import { createApp } from "../../api/app";

describe("Database Migrations System", () => {
  let db: Database.Database;
  let tempDir: string;

  beforeEach(() => {
    db = new Database(":memory:");

    // Create a temp directory for test migration SQL files
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "migration-test-"));

    // Create 001_create_users.sql
    fs.writeFileSync(
      path.join(tempDir, "001_create_users.sql"),
      `-- UP
CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT);
-- DOWN
DROP TABLE IF EXISTS users;
`,
    );

    // Create 002_create_posts.sql
    fs.writeFileSync(
      path.join(tempDir, "002_create_posts.sql"),
      `-- UP
CREATE TABLE posts (id INTEGER PRIMARY KEY, title TEXT, user_id INTEGER);
-- DOWN
DROP TABLE IF EXISTS posts;
`,
    );

    // Create 003_add_index.sql
    fs.writeFileSync(
      path.join(tempDir, "003_add_index.sql"),
      `-- UP
CREATE INDEX idx_posts_user_id ON posts(user_id);
-- DOWN
DROP INDEX IF EXISTS idx_posts_user_id;
`,
    );
  });

  afterEach(() => {
    db.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  describe("SQL File Parsing & Discovery", () => {
    it("should parse UP and DOWN sections from SQL migration files", () => {
      const sqlContent = `-- Header
CREATE TABLE dummy (id INT);

-- DOWN
DROP TABLE dummy;
`;
      const parsed = parseMigrationSql(sqlContent);
      expect(parsed.up).toContain("CREATE TABLE dummy");
      expect(parsed.down).toContain("DROP TABLE dummy");
    });

    it("should discover and load migrations in alphabetical/numeric order", () => {
      const migrations = loadMigrations(tempDir);
      expect(migrations.length).toBe(3);
      expect(migrations[0].version).toBe("001");
      expect(migrations[1].version).toBe("002");
      expect(migrations[2].version).toBe("003");
    });
  });

  describe("Version Tracking & Schema Initialization", () => {
    it("should initialize schema_migrations table and track applied migrations", () => {
      const statusBefore = getMigrationStatus(db, { migrationsDir: tempDir });
      expect(statusBefore.length).toBe(3);
      expect(statusBefore.every((s) => !s.applied)).toBe(true);

      const result = runMigrations(db, { migrationsDir: tempDir });
      expect(result.migrated).toEqual(["001", "002", "003"]);

      const applied = getAppliedMigrations(db);
      expect(applied.length).toBe(3);
      expect(applied.map((a) => a.version)).toEqual(["001", "002", "003"]);

      expect(isApplied(db, "001")).toBe(true);
      expect(isApplied(db, "002")).toBe(true);
      expect(isApplied(db, "003")).toBe(true);

      // Verify actual tables created in sqlite
      const tables = db
        .prepare("SELECT name FROM sqlite_master WHERE type='table'")
        .all()
        .map((r: any) => r.name);
      expect(tables).toContain("users");
      expect(tables).toContain("posts");
      expect(tables).toContain("schema_migrations");
    });
  });

  describe("Idempotency", () => {
    it("should be safe to run migrations multiple times without error or duplicates", () => {
      const run1 = runMigrations(db, { migrationsDir: tempDir });
      expect(run1.migrated).toEqual(["001", "002", "003"]);

      const run2 = runMigrations(db, { migrationsDir: tempDir });
      expect(run2.migrated).toEqual([]);

      const applied = getAppliedMigrations(db);
      expect(applied.length).toBe(3);
    });
  });

  describe("Dry-Run Mode", () => {
    it("should report migrations to be applied without executing them in dry-run mode", () => {
      const result = runMigrations(db, { migrationsDir: tempDir, dryRun: true });
      expect(result.dryRun).toBe(true);
      expect(result.migrated).toEqual(["001", "002", "003"]);

      // Verify tables were NOT created
      const tables = db
        .prepare("SELECT name FROM sqlite_master WHERE type='table'")
        .all()
        .map((r: any) => r.name);
      expect(tables).not.toContain("users");
      expect(tables).not.toContain("posts");

      // Verify no records in schema_migrations
      const applied = getAppliedMigrations(db);
      expect(applied.length).toBe(0);
    });

    it("should report migrations to be rolled back without executing in dry-run mode", () => {
      runMigrations(db, { migrationsDir: tempDir });

      const rollbackResult = rollbackMigrations(db, {
        migrationsDir: tempDir,
        steps: 2,
        dryRun: true,
      });

      expect(rollbackResult.dryRun).toBe(true);
      expect(rollbackResult.rolledBack).toEqual(["003", "002"]);

      // Verify tables still exist
      const tables = db
        .prepare("SELECT name FROM sqlite_master WHERE type='table'")
        .all()
        .map((r: any) => r.name);
      expect(tables).toContain("users");
      expect(tables).toContain("posts");

      const applied = getAppliedMigrations(db);
      expect(applied.length).toBe(3);
    });
  });

  describe("Rollback Support (DOWN Migrations)", () => {
    it("should roll back migrations by steps", () => {
      runMigrations(db, { migrationsDir: tempDir });

      // Rollback 1 step (003)
      const res1 = rollbackMigrations(db, { migrationsDir: tempDir, steps: 1 });
      expect(res1.rolledBack).toEqual(["003"]);
      expect(isApplied(db, "003")).toBe(false);
      expect(isApplied(db, "002")).toBe(true);

      // Rollback 2 steps (002, 001)
      const res2 = rollbackMigrations(db, { migrationsDir: tempDir, steps: 2 });
      expect(res2.rolledBack).toEqual(["002", "001"]);
      expect(isApplied(db, "002")).toBe(false);
      expect(isApplied(db, "001")).toBe(false);

      const tables = db
        .prepare("SELECT name FROM sqlite_master WHERE type='table'")
        .all()
        .map((r: any) => r.name);
      expect(tables).not.toContain("users");
      expect(tables).not.toContain("posts");
    });

    it("should roll back down to target version", () => {
      runMigrations(db, { migrationsDir: tempDir });

      // Target version "001": rollback 003 and 002 so state is at 001
      const res = rollbackMigrations(db, { migrationsDir: tempDir, targetVersion: "001" });
      expect(res.rolledBack).toEqual(["003", "002"]);
      expect(isApplied(db, "001")).toBe(true);
      expect(isApplied(db, "002")).toBe(false);
      expect(isApplied(db, "003")).toBe(false);
    });
  });

  describe("Default Workspace Migrations", () => {
    it("should successfully run existing project migrations (001, 002, 003)", () => {
      const realMigrationsDir = path.join(__dirname);
      const result = runMigrations(db, { migrationsDir: realMigrationsDir });
      expect(result.migrated).toContain("001");
      expect(result.migrated).toContain("002");
      expect(result.migrated).toContain("003");

      const status = getMigrationStatus(db, { migrationsDir: realMigrationsDir });
      expect(status.every((s) => s.applied)).toBe(true);
    });
  });

  describe("GET /migrations API Endpoint", () => {
    it("should return migration status via HTTP GET /migrations", async () => {
      const { httpServer, close } = createApp();
      try {
        const res = await request(httpServer).get("/migrations");
        expect(res.status).toBe(200);
        expect(res.body.status).toBe("ok");
        expect(Array.isArray(res.body.migrations)).toBe(true);
      } finally {
        close();
      }
    });
  });
});
