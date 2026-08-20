import type Database from "better-sqlite3";

export interface AppliedMigration {
  id?: number;
  version: string;
  name: string;
  applied_at: string;
}

/**
 * Ensures the `schema_migrations` table exists in the database.
 */
export function ensureMigrationsTable(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      version     TEXT NOT NULL UNIQUE,
      name        TEXT NOT NULL,
      applied_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
}

/**
 * Retrieves all applied migrations from the database, sorted by version.
 */
export function getAppliedMigrations(db: Database.Database): AppliedMigration[] {
  ensureMigrationsTable(db);
  const rows = db
    .prepare("SELECT id, version, name, applied_at FROM schema_migrations ORDER BY version ASC, id ASC")
    .all() as AppliedMigration[];
  return rows;
}

/**
 * Records an applied migration in the `schema_migrations` table.
 */
export function recordMigration(db: Database.Database, version: string, name: string): void {
  ensureMigrationsTable(db);
  db.prepare(`
    INSERT INTO schema_migrations (version, name, applied_at)
    VALUES (?, ?, ?)
  `).run(version, name, new Date().toISOString());
}

/**
 * Removes a migration record from the `schema_migrations` table during rollback.
 */
export function removeMigration(db: Database.Database, version: string): void {
  ensureMigrationsTable(db);
  db.prepare("DELETE FROM schema_migrations WHERE version = ?").run(version);
}

/**
 * Checks if a specific migration version has already been applied.
 */
export function isApplied(db: Database.Database, version: string): boolean {
  ensureMigrationsTable(db);
  const row = db
    .prepare("SELECT 1 FROM schema_migrations WHERE version = ?")
    .get(version);
  return Boolean(row);
}
