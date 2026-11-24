/**
 * SQLite database maintenance service.
 *
 * Long-term data integrity for the node's on-disk SQLite databases
 * (`payments.db`, `tasks.db`, `agents.db`, `jobs.db`). SQLite in WAL mode
 * grows its `-wal` sidecar and accumulates free pages over time; without
 * maintenance the journal and file fragmentation slowly degrade insert/scan
 * latency. This service runs three periodic upkeep jobs:
 *
 * 1. **WAL checkpoint** — `PRAGMA wal_checkpoint(TRUNCATE)` removes committed
 *    frames from the `-wal` file so it cannot grow unbounded.
 * 2. **Incremental vacuum** — when the free-page ratio exceeds a threshold the
 *    `VACUUM` command compacts the database file, reclaiming space and
 *    reordering pages for locality.
 * 3. **Scheduled backup** — a consistent snapshot is taken via SQLite's online
 *    backup API (`db.backup()`) so it can run against a live connection, with a
 *    retention policy that prunes the oldest snapshots.
 *
 * Every run is recorded in {@link DbMaintenanceMetrics} so operators can
 * observe upkeep via the health dashboard and logs. The service is
 * intentionally self-contained: callers register the databases to maintain,
 * and it never assumes ownership of those connections (it never closes a
 * connection it did not open).
 */

import path from "path";
import fs from "fs";
import { createLogger } from "../utils/logger";
import type Database from "better-sqlite3";
import { encryptBackupFile, ENCRYPTED_BACKUP_SUFFIX } from "./backup/encryption";

const logger = createLogger({ component: "db-maintenance" });

/** A database the maintenance service knows how to keep healthy. */
export interface MaintenanceDb {
  /** Stable identifier used in metrics and backup file names. */
  name: string;
  /** Absolute path to the main database file. */
  path: string;
  /** Returns the live connection used by the rest of the application. */
  getConnection: () => Database.Database;
}

/** Result of a single maintenance pass across all registered databases. */
export interface DbMaintenanceMetrics {
  lastRunAt: string | null;
  databasesCheckpointed: number;
  databasesVacuumed: number;
  databasesBackedUp: number;
  backupsDeleted: number;
  /** Admin audit entries pruned by the retention hook during the last pass. */
  auditLogsPruned: number;
  /** Per-database roll-up keyed by database name. */
  byDatabase: Record<
    string,
    {
      checkpointed: boolean;
      vacuumed: boolean;
      backedUp: boolean;
      backupPath: string | null;
      freePages: number;
      totalPages: number;
    }
  >;
}

export interface DbMaintenanceOptions {
  /** How often (ms) the maintenance pass runs. Default: 6 hours. */
  intervalMs?: number;
  /** Free-page ratio (0..1) above which `VACUUM` runs. Default: 0.2. */
  vacuumThreshold?: number;
  /** Directory where backups are written. Default: `<cwd>/backups`. */
  backupDir?: string;
  /** Maximum number of snapshots retained per database. Default: 14. */
  backupRetentionCount?: number;
  /** Days to keep admin audit entries; older ones are pruned each pass. 0 or unset disables pruning. */
  auditLogRetentionDays?: number;
  /**
   * Job that moves aged event archive rows to cold storage (issue #809). When
   * set, it runs once a day at `coldArchiveHourUtc`. Unset means no daily job.
   */
  runColdArchive?: () => unknown;
  /** UTC hour (0–23) for the daily cold archive run. Default: 2 (02:00 UTC). */
  coldArchiveHourUtc?: number;
}

const DEFAULT_INTERVAL_MS = 6 * 60 * 60 * 1000;
const DEFAULT_VACUUM_THRESHOLD = 0.2;
const DEFAULT_BACKUP_RETENTION = 14;
const DEFAULT_COLD_ARCHIVE_HOUR_UTC = 2;

/**
 * Milliseconds from `now` until the next occurrence of `hour`:00 UTC. An exact
 * match counts as already passed, so the next run is a full day later.
 */
export function msUntilNextUtcHour(now: Date, hour: number): number {
  const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), hour));
  if (next.getTime() <= now.getTime()) next.setUTCDate(next.getUTCDate() + 1);
  return next.getTime() - now.getTime();
}

/**
 * Query the SQLite pagination state for free-page accounting.
 *
 * `PRAGMA freelist_count` reports pages available for reuse; `PRAGMA
 * page_count` reports the current file size in pages. The free ratio is used
 * to decide whether a vacuum is worthwhile.
 */
export function readPageStats(db: Database.Database): { freePages: number; totalPages: number } {
  const freeRows = db.pragma("freelist_count", { simple: true });
  const totalRows = db.pragma("page_count", { simple: true });
  const freePages = Array.isArray(freeRows) ? Number(freeRows[0]) : Number(freeRows);
  const totalPages = Array.isArray(totalRows) ? Number(totalRows[0]) : Number(totalRows);
  return { freePages: Number.isFinite(freePages) ? freePages : 0, totalPages: Number.isFinite(totalPages) ? totalPages : 0 };
}

export class DbMaintenanceService {
  private readonly intervalMs: number;
  private readonly vacuumThreshold: number;
  private readonly backupDir: string;
  private readonly backupRetentionCount: number;
  private readonly auditLogRetentionDays: number;
  private readonly databases: MaintenanceDb[];
  private readonly runColdArchive?: () => unknown;
  private readonly coldArchiveHourUtc: number;
  private timer: NodeJS.Timeout | null = null;
  private coldArchiveTimer: NodeJS.Timeout | null = null;
  private stopped = false;
  private currentRun: Promise<void> | null = null;
  private metrics: DbMaintenanceMetrics = emptyMetrics();

  constructor(databases: MaintenanceDb[], options: DbMaintenanceOptions = {}) {
    this.databases = databases;
    this.intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
    this.vacuumThreshold = options.vacuumThreshold ?? DEFAULT_VACUUM_THRESHOLD;
    this.backupRetentionCount = options.backupRetentionCount ?? DEFAULT_BACKUP_RETENTION;
    this.backupDir = options.backupDir ?? path.join(process.cwd(), "backups");
    this.auditLogRetentionDays = options.auditLogRetentionDays ?? 0;
    this.runColdArchive = options.runColdArchive;
    this.coldArchiveHourUtc = options.coldArchiveHourUtc ?? DEFAULT_COLD_ARCHIVE_HOUR_UTC;
  }

  start(): void {
    if (this.timer) return;
    this.stopped = false;
    fs.mkdirSync(this.backupDir, { recursive: true });
    this.timer = setInterval(() => {
      void this.run().catch((error) => {
        logger.error({ err: error }, "database maintenance run failed");
      });
    }, this.intervalMs);
    // Run once (not awaited) shortly after startup for an immediate baseline.
    void this.run().catch((error) => {
      logger.error({ err: error }, "database maintenance run failed");
    });
    if (this.runColdArchive) this.scheduleColdArchive();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.coldArchiveTimer) {
      clearTimeout(this.coldArchiveTimer);
      this.coldArchiveTimer = null;
    }
    await this.currentRun;
  }

  /** Arm a one-shot timer for the next cold-archive hour, then re-arm after each run (#809). */
  private scheduleColdArchive(): void {
    if (this.stopped) return;
    const delay = msUntilNextUtcHour(new Date(), this.coldArchiveHourUtc);
    this.coldArchiveTimer = setTimeout(() => {
      this.coldArchiveTimer = null;
      this.runColdArchivePass();
      this.scheduleColdArchive();
    }, delay);
  }

  /** Run the cold archive job, logging rather than throwing so the schedule survives a failure. */
  private runColdArchivePass(): void {
    if (!this.runColdArchive) return;
    try {
      this.runColdArchive();
    } catch (error) {
      logger.error({ err: error }, "event cold archive run failed");
    }
  }

  getMetrics(): DbMaintenanceMetrics {
    return this.metrics;
  }

  /** Run a full maintenance pass now. Safe to call more than once. */
  run(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    if (this.currentRun) return this.currentRun;
    this.currentRun = this.runPass().finally(() => {
      this.currentRun = null;
    });
    return this.currentRun;
  }

  private async runPass(): Promise<void> {
    const startedAt = Date.now();
    const snapshot = emptyMetrics();
    let backupsDeleted = 0;

    for (const db of this.databases) {
      const entry = snapshot.byDatabase[db.name] ?? {
        checkpointed: false,
        vacuumed: false,
        backedUp: false,
        backupPath: null,
        freePages: 0,
        totalPages: 0,
      };
      try {
        const connection = db.getConnection();
        const pageStats = readPageStats(connection);
        entry.freePages = pageStats.freePages;
        entry.totalPages = pageStats.totalPages;

        // 1. WAL checkpoint (TRUNCATE) so the journal sidecar stays bounded.
        connection.pragma("wal_checkpoint(TRUNCATE)");
        entry.checkpointed = true;

        // 2. Incremental vacuum when free pages exceed the threshold.
        const freeRatio =
          pageStats.totalPages > 0 ? pageStats.freePages / pageStats.totalPages : 0;
        if (freeRatio > this.vacuumThreshold) {
          connection.exec("VACUUM");
          entry.vacuumed = true;
        }

        // 3. Online backup with retention.
        const backupPath = await this.createBackup(db);
        entry.backedUp = true;
        entry.backupPath = backupPath;
        backupsDeleted += this.applyRetention(db.name);
      } catch (error) {
        logger.error({ err: error, database: db.name }, "maintenance tick failed for database");
      }
      snapshot.byDatabase[db.name] = entry;
    }

    snapshot.databasesCheckpointed = Object.values(snapshot.byDatabase).filter((d) => d.checkpointed).length;
    snapshot.databasesVacuumed = Object.values(snapshot.byDatabase).filter((d) => d.vacuumed).length;
    snapshot.databasesBackedUp = Object.values(snapshot.byDatabase).filter((d) => d.backedUp).length;
    snapshot.backupsDeleted = backupsDeleted;
    if (this.auditLogRetentionDays > 0) {
      try {
        // Lazy require: adminControl pulls in every database module.
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { pruneAdminAuditLog } = require("./adminControl") as typeof import("./adminControl");
        snapshot.auditLogsPruned = pruneAdminAuditLog(this.auditLogRetentionDays);
      } catch (error) {
        logger.error({ err: error }, "audit log retention pruning failed");
      }
    }
    snapshot.lastRunAt = new Date().toISOString();
    this.metrics = snapshot;

    logger.info(
      {
        elapsedMs: Date.now() - startedAt,
        checkpointed: snapshot.databasesCheckpointed,
        vacuumed: snapshot.databasesVacuumed,
        backedUp: snapshot.databasesBackedUp,
        backupsDeleted,
        auditLogsPruned: snapshot.auditLogsPruned,
      },
      "database maintenance pass completed",
    );
  }

  /**
   * Take a consistent snapshot of a live database using SQLite's online backup
   * API, then encrypt it at rest (Issue #747). Each snapshot is timestamped
   * and prefixed with the database name so retention can identify siblings.
   *
   * Fails closed: when `DB_BACKUP_ENCRYPTION_KEY` is unset the raw snapshot
   * is never left on disk — `encryptBackupFile` throws before writing one.
   */
  private async createBackup(db: MaintenanceDb): Promise<string> {
    const rawPath = path.join(this.backupDir, `${db.name}-${Date.now()}.db`);
    const connection = db.getConnection();
    await connection.backup(rawPath);
    return encryptBackupFile(rawPath, { source: db.name });
  }

  /**
   * Trim a database's snapshots down to the retention count, deleting oldest
   * first. Plain `.db` and encrypted `.db.enc` snapshots share one budget, so
   * turning encryption on cannot double the on-disk footprint. Returns how
   * many files were removed.
   */
  private applyRetention(dbName: string): number {
    let files: string[] = [];
    try {
      files = fs
        .readdirSync(this.backupDir)
        .filter(
          (f) =>
            f.startsWith(`${dbName}-`) &&
            (f.endsWith(".db") || f.endsWith(ENCRYPTED_BACKUP_SUFFIX)),
        );
    } catch {
      return 0;
    }
    files.sort();
    const toDelete = files.length - this.backupRetentionCount;
    let deleted = 0;
    for (let i = 0; i < toDelete; i += 1) {
      const file = files[i];
      if (!file) continue;
      try {
        fs.unlinkSync(path.join(this.backupDir, file));
        deleted += 1;
        logger.info(
          { database: dbName, file, retention: this.backupRetentionCount },
          "pruned expired backup",
        );
      } catch (error) {
        logger.error({ err: error, database: dbName, file }, "failed to prune backup");
      }
    }
    return deleted;
  }
}

function emptyMetrics(): DbMaintenanceMetrics {
  return {
    lastRunAt: null,
    databasesCheckpointed: 0,
    databasesVacuumed: 0,
    databasesBackedUp: 0,
    backupsDeleted: 0,
    auditLogsPruned: 0,
    byDatabase: {},
  };
}

/**
 * The default maintenance registry for this node: the four on-disk WAL
 * databases the application actually persists to.
 */
export function defaultMaintenanceDatabases(): MaintenanceDb[] {
  // The event store is included so WAL checkpointing and vacuum cover the table
  // that grows fastest (issue #383).  It is skipped when configured as
  // `:memory:`, since there is no file to checkpoint and nothing to back up.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const eventStorePath = require("../events/eventStore").getEventStorePath() as string;
  const eventStoreDb: MaintenanceDb[] =
    eventStorePath === ":memory:"
      ? []
      : [
          {
            name: "events",
            path: eventStorePath,
            getConnection: () => {
              // eslint-disable-next-line @typescript-eslint/no-var-requires
              // eslint-disable-next-line @typescript-eslint/no-var-requires
              const { getEventStoreConnection } = require("../events/eventStore") as typeof import("../events/eventStore");
              const connection = getEventStoreConnection();
              if (!connection) {
                throw new Error("event store connection requested before the store was opened");
              }
              return connection;
            },
          },
        ];

  return [
    ...eventStoreDb,
    {
      name: "payments",
      path: path.join(process.cwd(), "payments.db"),
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      getConnection: () => require("../db").getDb(),
    },
    {
      name: "tasks",
      path: path.join(process.cwd(), "tasks.db"),
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      getConnection: () => require("../db/tasks").getTaskDb(),
    },
    {
      name: "agents",
      path: path.join(process.cwd(), "agents.db"),
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      getConnection: () => require("../db/agents").getAgentDb(),
    },
    {
      name: "jobs",
      path: path.join(process.cwd(), "jobs.db"),
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      getConnection: () => require("../queue/jobStore").getJobDb(),
    },
  ];
}
