import fs from "fs";
import path from "path";
import type Database from "better-sqlite3";
import {
  ensureMigrationsTable,
  getAppliedMigrations,
  recordMigration,
  removeMigration,
  isApplied,
} from "./tracker";

export interface Migration {
  version: string;
  name: string;
  filename: string;
  up: string;
  down: string;
}

export interface MigrationStatus {
  version: string;
  name: string;
  filename: string;
  applied: boolean;
  appliedAt?: string;
}

export interface MigrationResult {
  migrated: string[];
  rolledBack: string[];
  pending: string[];
  dryRun: boolean;
}

export interface MigrationOptions {
  migrationsDir?: string;
  targetVersion?: string;
  dryRun?: boolean;
}

export interface RollbackOptions {
  migrationsDir?: string;
  steps?: number;
  targetVersion?: string;
  dryRun?: boolean;
}

/**
 * Splits SQL migration content into UP and DOWN statements using `-- DOWN` comments.
 */
export function parseMigrationSql(content: string): { up: string; down: string } {
  const downMarker = /^--\s*(-{2}\s*)?DOWN\b/im;
  const match = content.match(downMarker);
  if (match && match.index !== undefined) {
    const up = content.substring(0, match.index).trim();
    const downIndex = match.index + match[0].length;
    const down = content.substring(downIndex).trim();
    return { up, down };
  }
  return { up: content.trim(), down: "" };
}

/**
 * Discovers and loads all .sql migration files from a directory, sorted by filename.
 */
export function loadMigrations(dirPath?: string): Migration[] {
  const directory = dirPath ?? __dirname;
  if (!fs.existsSync(directory)) {
    return [];
  }

  const files = fs
    .readdirSync(directory)
    .filter((file) => file.endsWith(".sql"))
    .sort((a, b) => a.localeCompare(b));

  return files.map((filename) => {
    const filePath = path.join(directory, filename);
    const content = fs.readFileSync(filePath, "utf-8");
    const { up, down } = parseMigrationSql(content);

    // Extract version prefix (e.g., "001" from "001_add_stats_indexes.sql")
    const match = filename.match(/^(\d+|[a-zA-Z0-9_\-]+?)(?:_|\.sql)/);
    const version = match ? match[1] : filename.replace(/\.sql$/, "");

    return {
      version,
      name: filename,
      filename,
      up,
      down,
    };
  });
}

/**
 * Gets the status of all available migrations against the database.
 */
export function getStatus(db: Database.Database, migrationsDir?: string): MigrationStatus[] {
  ensureMigrationsTable(db);
  const migrations = loadMigrations(migrationsDir);
  const appliedList = getAppliedMigrations(db);

  const appliedMap = new Map<string, string>();
  for (const item of appliedList) {
    appliedMap.set(item.version, item.applied_at);
  }

  return migrations.map((m) => ({
    version: m.version,
    name: m.name,
    filename: m.filename,
    applied: appliedMap.has(m.version),
    appliedAt: appliedMap.get(m.version),
  }));
}

/**
 * Runs pending migrations in order (UP).
 */
export function runUp(db: Database.Database, options: MigrationOptions = {}): MigrationResult {
  ensureMigrationsTable(db);
  const { migrationsDir, targetVersion, dryRun = false } = options;
  const migrations = loadMigrations(migrationsDir);

  const pending: Migration[] = [];
  for (const m of migrations) {
    if (!isApplied(db, m.version)) {
      pending.push(m);
      if (
        targetVersion &&
        (m.version === targetVersion || m.filename === targetVersion || m.name === targetVersion)
      ) {
        break;
      }
    }
  }

  if (dryRun) {
    return {
      migrated: pending.map((m) => m.version),
      rolledBack: [],
      pending: migrations
        .filter((m) => !isApplied(db, m.version) && !pending.includes(m))
        .map((m) => m.version),
      dryRun: true,
    };
  }

  const migrated: string[] = [];
  for (const m of pending) {
    if (isApplied(db, m.version)) {
      continue;
    }

    const runTx = db.transaction(() => {
      if (m.up.length > 0) {
        db.exec(m.up);
      }
      recordMigration(db, m.version, m.name);
    });

    runTx();
    migrated.push(m.version);
  }

  const remainingPending = migrations
    .filter((m) => !isApplied(db, m.version))
    .map((m) => m.version);

  return {
    migrated,
    rolledBack: [],
    pending: remainingPending,
    dryRun: false,
  };
}

/**
 * Rolls back applied migrations in reverse order (DOWN).
 */
export function runDown(db: Database.Database, options: RollbackOptions = {}): MigrationResult {
  ensureMigrationsTable(db);
  const { migrationsDir, steps = 1, targetVersion, dryRun = false } = options;

  const allMigrations = loadMigrations(migrationsDir);
  const migrationMap = new Map<string, Migration>();
  for (const m of allMigrations) {
    migrationMap.set(m.version, m);
  }

  const appliedList = getAppliedMigrations(db);
  // Reverse applied migrations so latest is first
  const reversedApplied = [...appliedList].reverse();

  let toRollback: { version: string; name: string; downSql: string }[] = [];

  if (targetVersion) {
    // Rollback down to (excluding) targetVersion, or rollback targetVersion and all later?
    // Standard convention: rollback all migrations until targetVersion is the current version.
    for (const app of reversedApplied) {
      if (
        app.version === targetVersion ||
        app.name === targetVersion
      ) {
        break;
      }
      const def = migrationMap.get(app.version);
      toRollback.push({
        version: app.version,
        name: app.name,
        downSql: def ? def.down : "",
      });
    }
  } else {
    // Take `steps` migrations
    const count = Math.min(steps, reversedApplied.length);
    const slice = reversedApplied.slice(0, count);
    toRollback = slice.map((app) => {
      const def = migrationMap.get(app.version);
      return {
        version: app.version,
        name: app.name,
        downSql: def ? def.down : "",
      };
    });
  }

  if (dryRun) {
    return {
      migrated: [],
      rolledBack: toRollback.map((r) => r.version),
      pending: [],
      dryRun: true,
    };
  }

  const rolledBack: string[] = [];
  for (const r of toRollback) {
    const rollbackTx = db.transaction(() => {
      if (r.downSql.length > 0) {
        db.exec(r.downSql);
      }
      removeMigration(db, r.version);
    });

    rollbackTx();
    rolledBack.push(r.version);
  }

  const remainingPending = allMigrations
    .filter((m) => !isApplied(db, m.version))
    .map((m) => m.version);

  return {
    migrated: [],
    rolledBack,
    pending: remainingPending,
    dryRun: false,
  };
}
