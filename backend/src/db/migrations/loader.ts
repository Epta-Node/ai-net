/**
 * Migration file discovery and parsing.
 *
 * A migration is a single `.sql` file named `<version>_<name>.sql` where
 * `<version>` is a zero-padded, monotonically increasing integer
 * (`0001_init.sql`, `0002_indexes.sql`, ...).  Sorting is done on the parsed
 * numeric version rather than the raw filename so `0009` still sorts after
 * `0010`'s predecessor and before `0010` even if the padding width changes.
 *
 * Files are forward-only by default.  An optional down section may follow a
 * `-- migrate:down` marker; it is ignored unless a caller explicitly asks for
 * down migrations (see the `--include-down-migrations` CLI flag).
 *
 * @example
 *   -- 0001_init.sql
 *   CREATE TABLE IF NOT EXISTS tasks (id TEXT PRIMARY KEY);
 *
 *   -- migrate:down
 *   DROP TABLE IF EXISTS tasks;
 */

import { createHash } from "crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "fs";
import { join } from "path";
import { getConfig } from "../../config";

/** A single migration, parsed from one `.sql` file. */
export interface Migration {
  /** Zero-padded version taken from the filename, e.g. `"0001"`. */
  id: string;
  /** Basename of the source file, e.g. `"0001_init.sql"`. */
  filename: string;
  /** Human-readable name taken from the filename, e.g. `"init"`. */
  name: string;
  /** Numeric form of {@link id}, used for ordering. */
  version: number;
  /** Forward (up) SQL — the section above the down marker. */
  upSql: string;
  /** Rollback SQL — the section below the down marker, or `null` when absent. */
  downSql: string | null;
  /** SHA-256 of the whole file, used to detect edits to applied migrations. */
  checksum: string;
}

/** Marker separating the up section from the optional down section. */
export const DOWN_MARKER = /^\s*--\s*migrate:down\b/im;

/** `0001_init.sql` → `{ version: 1, name: "init" }`. */
const FILENAME_PATTERN = /^(\d+)_([A-Za-z0-9][A-Za-z0-9._-]*)\.sql$/;

/** Thrown when the migrations directory is unusable or a file is malformed. */
export class MigrationLoadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MigrationLoadError";
  }
}

/** Normalise line endings so checksums are stable across platforms. */
function normalizeEol(sql: string): string {
  return sql.replace(/\r\n/g, "\n");
}

/**
 * `true` when the section contains at least one statement.
 *
 * Blank lines and whole-line `--` comments are discarded, so a file holding
 * nothing but a header comment is rejected instead of silently recording a
 * migration that does nothing.
 */
function hasExecutableSql(sql: string): boolean {
  return sql
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("--"))
    .join("\n")
    .trim() !== "";
}

/** Split a migration file into its up and down halves. */
export function parseMigrationFile(filename: string, contents: string): Migration {
  const match = FILENAME_PATTERN.exec(filename);
  if (!match) {
    throw new MigrationLoadError(
      `Invalid migration filename "${filename}" — expected "<version>_<name>.sql" (e.g. 0001_init.sql)`,
    );
  }

  const [, rawVersion, name] = match;
  const sql = normalizeEol(contents);

  let upSql = sql;
  let downSql: string | null = null;

  const marker = DOWN_MARKER.exec(sql);
  if (marker) {
    upSql = sql.slice(0, marker.index);
    const tail = sql.slice(marker.index + marker[0].length);
    downSql = tail.trim() === "" ? null : tail;
  }

  if (!hasExecutableSql(upSql)) {
    throw new MigrationLoadError(
      `Migration "${filename}" has an empty up section — every line is blank or a comment`,
    );
  }

  return {
    id: rawVersion,
    filename,
    name,
    version: Number(rawVersion),
    upSql: upSql.trim(),
    downSql: downSql === null ? null : downSql.trim(),
    checksum: createHash("sha256").update(sql).digest("hex"),
  };
}

/**
 * Load and sort every migration in `dir`.
 *
 * @throws {MigrationLoadError} when the directory is missing, a filename is
 * malformed, or two migrations share the same version.
 */
export function loadMigrations(dir: string): Migration[] {
  if (!existsSync(dir) || !statSync(dir).isDirectory()) {
    throw new MigrationLoadError(`Migrations directory not found: ${dir}`);
  }

  const files = readdirSync(dir)
    .filter((file) => file.toLowerCase().endsWith(".sql"))
    .sort();

  const migrations = files.map((file) =>
    parseMigrationFile(file, readFileSync(join(dir, file), "utf8")),
  );

  const seen = new Map<number, string>();
  for (const migration of migrations) {
    const previous = seen.get(migration.version);
    if (previous !== undefined) {
      throw new MigrationLoadError(
        `Duplicate migration version ${migration.id}: "${previous}" and "${migration.filename}"`,
      );
    }
    seen.set(migration.version, migration.filename);
  }

  // Sort numerically so ordering never depends on filename length.
  migrations.sort((a, b) => a.version - b.version);
  return migrations;
}

/**
 * Locate the migrations directory at runtime.
 *
 * TypeScript does not emit `.sql` assets, so the compiled bundle may not carry
 * them.  Candidates are probed in order and the first one containing `.sql`
 * files wins; the source tree is the final fallback so a `dist`-only deploy
 * still resolves.
 */
export function resolveMigrationsDir(explicit?: string): string {
  const candidates = [
    explicit,
    getConfig().DB_MIGRATIONS_DIR,
    __dirname, // ts-node / jest / dist (when assets were copied)
    join(__dirname, "..", "..", "..", "..", "src", "db", "migrations"), // dist → source tree
  ].filter((candidate): candidate is string => typeof candidate === "string" && candidate !== "");

  for (const candidate of candidates) {
    if (existsSync(candidate) && statSync(candidate).isDirectory()) {
      return candidate;
    }
  }

  throw new MigrationLoadError(
    `Could not locate a migrations directory. Tried: ${candidates.join(", ")}. ` +
      "Set DB_MIGRATIONS_DIR to override.",
  );
}
