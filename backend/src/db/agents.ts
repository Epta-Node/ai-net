import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import path from "path";
import { migrateToLatest } from "./migrator";
import type { ReputationBreakdown } from "../services/qualityScorer.types";
import { createPool, type SqlitePool } from "./pool";
import { decodeCursor, encodeCursor, type CursorPage } from "./cursor";
import { ValidationError } from "../errors";
import { createErrorRegistryStore, getErrorDb } from "./errorRegistry";
import { safeJsonArray } from "../utils/safeJson";

const MIGRATIONS_DIR = path.join(__dirname, "migrations", "agents");

/** Map a raw `agents` row to an {@link AgentRecord}. */
function toAgentRecord(row: any): AgentRecord {
  return {
    id: row.id,
    capabilities: JSON.parse(row.capabilities || "[]"),
    pricingXLM: row.pricingXLM,
    endpoint: row.endpoint,
    stellarPublicKey: row.stellarPublicKey,
    reputationScore: row.reputationScore,
    lastSeenAt: row.lastSeenAt,
    status: row.status,
    bondAmountXLM: row.bondAmountXLM,
    tasksCompleted: row.tasksCompleted,
    tasksFailed: row.tasksFailed,
    lastActiveAt: row.lastActiveAt ?? undefined,
  };
}

export interface AgentRecord {
  id: string;
  capabilities: string[];
  pricingXLM: number;
  endpoint: string;
  stellarPublicKey: string;
  reputationScore: number;
  lastSeenAt: string;
  status: 'online' | 'offline';
  bondAmountXLM?: number;
  tasksCompleted?: number;
  tasksFailed?: number;
  lastActiveAt?: string;
  reputation?: ReputationBreakdown;
}

export interface AgentCursorOptions {
  /** Opaque cursor from a previous page's nextCursor field. */
  cursor?: string;
  /** Max items per page (1–100, default 20). */
  limit?: number;
  capability?: string;
  minReputation?: number;
  maxPriceXLM?: number;
  status?: string;
}

/** A persisted watchdog alert, as stored in `agent_alerts`. */
export interface AgentAlertRow {
  id: string;
  agentId: string;
  type: string;
  severity: string;
  message: string;
  lastSeenAt: string | null;
  detectedAt: string;
  resolvedAt: string | null;
  metadata: Record<string, unknown>;
}

let _agentPool: SqlitePool | null = null;
let _agentPoolClosing: Promise<void> | null = null;

/**
 * Memoised `AgentDb` wrappers, keyed by the underlying SQLite handle.
 *
 * `createAgentDb` is called from request handlers (and from background
 * services) with the pool's writer handle, so without this cache every call
 * would rebuild the wrapper's closure graph. Keying on the handle keeps the
 * cache correct when the pool is closed and reopened: a new writer is a new
 * key, and the stale entry becomes unreachable.
 */
const _agentDbCache = new WeakMap<Database.Database, AgentDb>();

export function ensureAgentTable(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS agents (
      id               TEXT PRIMARY KEY,
      capabilities     TEXT NOT NULL,
      pricingXLM       REAL NOT NULL,
      endpoint         TEXT NOT NULL,
      stellarPublicKey TEXT NOT NULL,
      reputationScore  REAL NOT NULL DEFAULT 2.5,
      lastSeenAt       TEXT NOT NULL,
      status           TEXT NOT NULL DEFAULT 'online',
      bondAmountXLM    REAL NOT NULL DEFAULT 0,
      tasksCompleted   INTEGER NOT NULL DEFAULT 0,
      tasksFailed      INTEGER NOT NULL DEFAULT 0,
      lastActiveAt     TEXT
    )
  `);
  const migrations = [
    "ALTER TABLE agents ADD COLUMN status TEXT NOT NULL DEFAULT 'offline'",
    "ALTER TABLE agents ADD COLUMN bondAmountXLM REAL NOT NULL DEFAULT 0",
    "ALTER TABLE agents ADD COLUMN tasksCompleted INTEGER NOT NULL DEFAULT 0",
    "ALTER TABLE agents ADD COLUMN tasksFailed INTEGER NOT NULL DEFAULT 0",
    "ALTER TABLE agents ADD COLUMN lastActiveAt TEXT",
    // Watchdog grace-period clock (Issue #379).
    "ALTER TABLE agents ADD COLUMN staleSince TEXT",
  ];
  for (const sql of migrations) {
    try {
      db.exec(sql);
    } catch {
      // Ignored if column already exists
    }
  }
  db.exec("CREATE INDEX IF NOT EXISTS idx_agents_listing ON agents (lastSeenAt DESC, id DESC)");

  // Mirrors migration 002 so an in-memory test database (which never runs the
  // migrations directory) still has the alert table.
  db.exec(`
    CREATE TABLE IF NOT EXISTS agent_alerts (
      id         TEXT PRIMARY KEY,
      agentId    TEXT NOT NULL,
      type       TEXT NOT NULL,
      severity   TEXT NOT NULL,
      message    TEXT NOT NULL,
      lastSeenAt TEXT,
      detectedAt TEXT NOT NULL,
      resolvedAt TEXT,
      metadata   TEXT NOT NULL DEFAULT '{}'
    )
  `);
  db.exec("CREATE INDEX IF NOT EXISTS idx_agent_alerts_detectedAt ON agent_alerts (detectedAt DESC)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_agent_alerts_agentId ON agent_alerts (agentId, detectedAt DESC)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_agents_staleSince ON agents (staleSince)");
}

/** Lazily open (or reopen) the pooled agent database. */
export function getAgentPool(dbPath?: string): SqlitePool {
  if (_agentPoolClosing) throw new Error("Agent database is closing");
  if (!_agentPool || _agentPool.closed) {
    const filePath = dbPath ?? path.join(process.cwd(), "agents.db");
    _agentPool = createPool({
      filePath,
      name: "agents",
      min: 1,
      max: 4,
      acquireTimeoutMs: 5_000,
      // Schema setup runs exactly once per pool here, on the writer, before
      // any reader attaches to the file. It deliberately does not live in
      // `createAgentDb`: that is a per-request mapping, and running DDL there
      // meant every agents request opened a write transaction and took the
      // write lock just to re-discover a schema that already existed.
      onCreate: (db) => {
        migrateToLatest(db, MIGRATIONS_DIR);
        ensureAgentTable(db);
      },
    });
  }
  return _agentPool;
}

/**
 * The writer connection, for the synchronous `createAgentDb` API.
 *
 * New code should prefer `getAgentPool().read(...)`.
 */
export function getAgentDb(dbPath?: string): Database.Database {
  return getAgentPool(dbPath).writer;
}

/** The agent pool if one is open, else null. Used by the metrics endpoint. */
export function currentAgentPool(): SqlitePool | null {
  return _agentPool && !_agentPool.closed ? _agentPool : null;
}

export function closeAgentDb(): Promise<void> {
  if (_agentPoolClosing) return _agentPoolClosing;
  const pool = _agentPool;
  if (!pool) return Promise.resolve();
  _agentPoolClosing = pool.close().finally(() => {
    if (_agentPool === pool) _agentPool = null;
    _agentPoolClosing = null;
  });
  return _agentPoolClosing;
}

export interface AgentDb {
  upsert(agent: AgentRecord): void;
  findById(id: string): AgentRecord | undefined;
  /** Bounded convenience wrapper: defaults to 20, at most 100 records. */
  list(options?: AgentCursorOptions): AgentRecord[];
  /**
   * Cursor-based list — stable under concurrent writes.
   * Keyset: (lastSeenAt DESC, id DESC).
   */
  listCursor(options?: AgentCursorOptions): CursorPage<AgentRecord>;
  delete(id: string): void;
  updateReputation(id: string, delta: number): void;
  updateReputationWithStats(id: string, delta: number, outcome?: 'success' | 'failure'): void;
  countByStellarKey(stellarPublicKey: string): number;
  markAllOffline(): void;
  updateLastSeen(agentId: string): void;
  markStaleAgents(staleThresholdMinutes?: number): number;
  deleteOfflineAgents(offlineThresholdHours?: number): number;

  // ── Heartbeat watchdog (Issue #379) ────────────────────────────────────────
  /**
   * Quarantine an agent: withdraw it from dispatch and start its grace clock.
   *
   * Setting `staleSince` is not enough on its own — the coordinator dispatches
   * to `status = 'online'` agents, so an agent left online stays reachable for
   * the whole grace window. Flipping the status is what makes a stale agent
   * unavailable *within* the grace period.
   */
  markStale(agentId: string, staleSince: string): void;
  /**
   * Clear the grace-period clock and restore dispatch eligibility.
   *
   * Only safe to call once liveness has been proven (a fresh heartbeat), which
   * is the only thing the watchdog's recovery path checks before calling it.
   */
  clearStale(agentId: string): void;
  /** Epoch ms the agent was first seen missing, or null if never. */
  getStaleSince(agentId: string): number | null;
  /** Agents currently inside their grace period. */
  listStaleAgents(): AgentRecord[];
  /** Persist a watchdog alert for the dashboard and the audit trail. */
  recordAlert(alert: {
    agentId: string;
    type: string;
    severity: string;
    message: string;
    lastSeenAt?: string | null;
    metadata?: Record<string, unknown>;
  }): string;
  /** Most recent alerts first; optionally filtered to unresolved ones. */
  listAlerts(options?: { limit?: number; agentId?: string; unresolvedOnly?: boolean }): AgentAlertRow[];

  // Optional on-chain event handlers used by registry/sync.ts. Not every
  // AgentDb implementation mirrors contract state, so call sites use `?.`.
  remove?(id: string): void;
  setFrozen?(agentId: string, frozen: boolean): void;
  updatePricing?(agentId: string, pricingXLM: number): void;
  upsertError?(error: {
    id: string;
    reporter: string;
    resolved: boolean;
    resolution: string | null;
    reportedAt: string;
  }): void;
  resolveError?(errorId: string, resolution: string): void;
}

/**
 * Map an already-initialised SQLite handle onto the `AgentDb` API.
 *
 * Pure mapping: no DDL, no other side effects. The agents schema is created
 * once by `getAgentPool`'s `onCreate` hook when the handle is first opened.
 *
 * The result is memoised per handle, so repeated calls return the *same*
 * object reference rather than a structurally identical copy — callers such as
 * the agents route's `createAgentDb(getAgentDb())` pay a map lookup instead of
 * rebuilding the wrapper and discarding its prepared-statement cache.
 */
export function createAgentDb(db: Database.Database): AgentDb {
  const cached = _agentDbCache.get(db);
  if (cached) return cached;

  const agentDb: AgentDb = {
    upsert(agent: AgentRecord): void {
      const rep = agent.reputationScore !== undefined ? Math.max(0.0, Math.min(5.0, agent.reputationScore)) : 2.5;
      db.prepare(`
        INSERT INTO agents (id, capabilities, pricingXLM, endpoint, stellarPublicKey, reputationScore, lastSeenAt, status, bondAmountXLM, tasksCompleted, tasksFailed, lastActiveAt)
        VALUES (@id, @capabilities, @pricingXLM, @endpoint, @stellarPublicKey, @reputationScore, @lastSeenAt, @status, @bondAmountXLM, @tasksCompleted, @tasksFailed, @lastActiveAt)
        ON CONFLICT(id) DO UPDATE SET
          capabilities = excluded.capabilities,
          pricingXLM = excluded.pricingXLM,
          endpoint = excluded.endpoint,
          stellarPublicKey = excluded.stellarPublicKey,
          lastSeenAt = excluded.lastSeenAt,
          status = excluded.status,
          bondAmountXLM = excluded.bondAmountXLM,
          tasksCompleted = excluded.tasksCompleted,
          tasksFailed = excluded.tasksFailed,
          lastActiveAt = excluded.lastActiveAt
      `).run({
        ...agent,
        capabilities: JSON.stringify(agent.capabilities),
        status: agent.status ?? 'offline',
        reputationScore: rep,
        bondAmountXLM: agent.bondAmountXLM ?? 0,
        tasksCompleted: agent.tasksCompleted ?? 0,
        tasksFailed: agent.tasksFailed ?? 0,
        lastActiveAt: agent.lastActiveAt ?? agent.lastSeenAt ?? new Date().toISOString(),
      });
    },

    findById(id: string): AgentRecord | undefined {
      const row = db.prepare("SELECT * FROM agents WHERE id = ?").get(id) as any;
      if (!row) return undefined;
      return {
        ...row,
        capabilities: safeJsonArray(row.capabilities, "agents.findById", row.id),
        status: row.status ?? 'offline',
        reputationScore: Number(row.reputationScore ?? 2.5),
        bondAmountXLM: Number(row.bondAmountXLM ?? 0),
        tasksCompleted: Number(row.tasksCompleted ?? 0),
        tasksFailed: Number(row.tasksFailed ?? 0),
        lastActiveAt: row.lastActiveAt ?? row.lastSeenAt,
      };
    },

    list(options: AgentCursorOptions = {}): AgentRecord[] {
      return this.listCursor(options).items;
    },

    listCursor(options: AgentCursorOptions = {}): CursorPage<AgentRecord> {
      const limit = options.limit ?? 20;
      if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
        throw new ValidationError("limit must be an integer between 1 and 100");
      }

      const conditions: string[] = ["1=1"];
      const params: unknown[] = [];

      if (options.minReputation !== undefined) {
        conditions.push("reputationScore >= ?");
        params.push(options.minReputation);
      }
      if (options.maxPriceXLM !== undefined) {
        conditions.push("pricingXLM <= ?");
        params.push(options.maxPriceXLM);
      }
      if (options.capability !== undefined) {
        // Rows whose `capabilities` column is not valid JSON are skipped
        // instead of aborting the whole query (#645). `json_each` is handed a
        // sanitized document so even an eager planner cannot reach the bad
        // value.
        conditions.push(
          "json_valid(capabilities) AND EXISTS (SELECT 1 FROM json_each(CASE WHEN json_valid(capabilities) THEN capabilities ELSE '[]' END) WHERE value = ?)",
        );
        params.push(options.capability);
      }
      if (options.status !== undefined) {
        conditions.push("status = ?");
        params.push(options.status);
      }

      let cursorCondition = "";
      const cursorParams: unknown[] = [];

      if (options.cursor !== undefined) {
        const payload = decodeCursor(options.cursor);
        if (!payload || typeof payload.lastSeenAt !== "string" || !payload.lastSeenAt ||
            typeof payload.id !== "string" || !payload.id) {
          throw new ValidationError("Invalid agent cursor");
        }
        // Compound keyset: rows that come after (lastSeenAt DESC, id DESC)
        cursorCondition = "AND (lastSeenAt < ? OR (lastSeenAt = ? AND id < ?))";
        cursorParams.push(payload.lastSeenAt, payload.lastSeenAt, payload.id);
      }

      const whereClause = conditions.join(" AND ");
      // Fetch limit+1 to detect whether a next page exists without a COUNT query
      const rows = db
        .prepare(
          `SELECT id, capabilities, pricingXLM, endpoint, stellarPublicKey,
                  reputationScore, lastSeenAt, status, bondAmountXLM,
                  tasksCompleted, tasksFailed, lastActiveAt FROM agents
           WHERE ${whereClause} ${cursorCondition}
           ORDER BY lastSeenAt DESC, id DESC
           LIMIT ?`,
        )
        .all(...params, ...cursorParams, limit + 1) as Array<Omit<AgentRecord, "capabilities"> & { capabilities: string }>;

      const hasMore = rows.length > limit;
      const pageRows = hasMore ? rows.slice(0, limit) : rows;

      const agents: AgentRecord[] = pageRows.map((row) => ({
        ...row,
        capabilities: safeJsonArray(row.capabilities, "agents.listCursor", row.id),
        status: row.status ?? 'offline',
        reputationScore: Number(row.reputationScore ?? 2.5),
        bondAmountXLM: Number(row.bondAmountXLM ?? 0),
        tasksCompleted: Number(row.tasksCompleted ?? 0),
        tasksFailed: Number(row.tasksFailed ?? 0),
        lastActiveAt: row.lastActiveAt ?? row.lastSeenAt,
      }));

      const result: CursorPage<AgentRecord> = { items: agents };
      if (hasMore) {
        const last = pageRows[pageRows.length - 1];
        result.nextCursor = encodeCursor({ lastSeenAt: last.lastSeenAt, id: last.id });
      }
      return result;
    },

    delete(id: string): void {
      db.prepare("DELETE FROM agents WHERE id = ?").run(id);
    },

    updateReputation(id: string, delta: number): void {
      db.prepare(`
        UPDATE agents
        SET reputationScore = MAX(0.0, MIN(5.0, reputationScore + ?))
        WHERE id = ?
      `).run(delta, id);
    },

    updateReputationWithStats(id: string, delta: number, outcome?: 'success' | 'failure'): void {
      const now = new Date().toISOString();
      if (outcome === 'success') {
        db.prepare(`
          UPDATE agents
          SET reputationScore = MAX(0.0, MIN(5.0, reputationScore + ?)),
              tasksCompleted = tasksCompleted + 1,
              lastActiveAt = ?,
              lastSeenAt = ?
          WHERE id = ?
        `).run(delta, now, now, id);
      } else if (outcome === 'failure') {
        db.prepare(`
          UPDATE agents
          SET reputationScore = MAX(0.0, MIN(5.0, reputationScore + ?)),
              tasksFailed = tasksFailed + 1,
              lastActiveAt = ?,
              lastSeenAt = ?
          WHERE id = ?
        `).run(delta, now, now, id);
      } else {
        db.prepare(`
          UPDATE agents
          SET reputationScore = MAX(0.0, MIN(5.0, reputationScore + ?)),
              lastActiveAt = ?,
              lastSeenAt = ?
          WHERE id = ?
        `).run(delta, now, now, id);
      }
    },

    countByStellarKey(stellarPublicKey: string): number {
      const row = db.prepare("SELECT COUNT(*) as count FROM agents WHERE stellarPublicKey = ?").get(stellarPublicKey) as { count: number } | undefined;
      return row ? Number(row.count) : 0;
    },

    markAllOffline(): void {
      db.prepare("UPDATE agents SET status = 'offline' WHERE status = 'online'").run();
    },

    updateLastSeen(agentId: string): void {
      // Store an ISO-8601 UTC timestamp (same format upsert uses). The raw
      // SQLite `datetime('now')` output lacks a timezone designator and gets
      // parsed as *local* time by JS `new Date()`, shifting timestamps by the
      // machine's UTC offset.
      db.prepare(`
        UPDATE agents
        SET lastSeenAt = ?,
            status = 'online'
        WHERE id = ?
      `).run(new Date().toISOString(), agentId);
    },

    markStaleAgents(staleThresholdMinutes: number = 5): number {
      const result = db.prepare(`
        UPDATE agents
        SET status = 'offline'
        WHERE status = 'online'
          AND datetime(lastSeenAt, '+' || ? || ' minutes') < datetime('now')
      `).run(staleThresholdMinutes);
      return result.changes;
    },

    deleteOfflineAgents(offlineThresholdHours: number = 24): number {
      const result = db.prepare(`
        DELETE FROM agents
        WHERE status = 'offline'
          AND datetime(lastSeenAt, '+' || ? || ' hours') < datetime('now')
      `).run(offlineThresholdHours);
      return result.changes;
    },

    // ── Heartbeat watchdog (Issue #379) ──────────────────────────────────────

    markStale(agentId: string, staleSince: string): void {
      // COALESCE so a second miss does not re-arm the grace clock: eviction is
      // measured from the *first* missed tick, not from the latest one.
      // `status = 'offline'` withdraws the agent from dispatch immediately.
      db.prepare(`
        UPDATE agents
        SET staleSince = COALESCE(staleSince, ?),
            status = 'offline'
        WHERE id = ?
      `).run(staleSince, agentId);
    },

    clearStale(agentId: string): void {
      // Restore dispatch eligibility as well as clearing the clock. The caller
      // has just seen a fresh heartbeat, so 'online' is the truthful status
      // even if the heartbeat write path did not set it.
      db.prepare(`
        UPDATE agents
        SET staleSince = NULL,
            status = 'online'
        WHERE id = ?
      `).run(agentId);
    },

    getStaleSince(agentId: string): number | null {
      const row = db.prepare("SELECT staleSince FROM agents WHERE id = ?").get(agentId) as
        | { staleSince: string | null }
        | undefined;
      if (!row?.staleSince) return null;
      const parsed = Date.parse(row.staleSince);
      return Number.isFinite(parsed) ? parsed : null;
    },

    listStaleAgents(): AgentRecord[] {
      const rows = db
        .prepare("SELECT * FROM agents WHERE staleSince IS NOT NULL ORDER BY staleSince ASC")
        .all() as any[];
      return rows.map(toAgentRecord);
    },

    recordAlert(alert: {
      agentId: string;
      type: string;
      severity: string;
      message: string;
      lastSeenAt?: string | null;
      metadata?: Record<string, unknown>;
    }): string {
      const id = randomUUID();
      const detectedAt = new Date().toISOString();
      db.prepare(`
        INSERT INTO agent_alerts
          (id, agentId, type, severity, message, lastSeenAt, detectedAt, resolvedAt, metadata)
        VALUES
          (?, ?, ?, ?, ?, ?, ?, NULL, ?)
      `).run(
        id,
        alert.agentId,
        alert.type,
        alert.severity,
        alert.message,
        alert.lastSeenAt ?? null,
        detectedAt,
        JSON.stringify(alert.metadata ?? {}),
      );
      return id;
    },

    listAlerts(
      options: { limit?: number; agentId?: string; unresolvedOnly?: boolean } = {},
    ): AgentAlertRow[] {
      const limit = options.limit ?? 50;
      const clauses: string[] = [];
      const params: unknown[] = [];

      if (options.agentId) {
        clauses.push("agentId = ?");
        params.push(options.agentId);
      }
      if (options.unresolvedOnly) {
        clauses.push("resolvedAt IS NULL");
      }

      const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
      const rows = db
        .prepare(
          `SELECT * FROM agent_alerts ${where} ORDER BY detectedAt DESC LIMIT ?`,
        )
        .all(...params, limit) as any[];

      return rows.map((row) => {
        let metadata: Record<string, unknown> = {};
        try {
          metadata = JSON.parse(row.metadata ?? "{}");
        } catch {
          // Corrupt metadata must not make the whole alert list unreadable.
          metadata = {};
        }
        return {
          id: row.id,
          agentId: row.agentId,
          type: row.type,
          severity: row.severity,
          message: row.message,
          lastSeenAt: row.lastSeenAt ?? null,
          detectedAt: row.detectedAt,
          resolvedAt: row.resolvedAt ?? null,
          metadata,
        };
      });
    },

    upsertError(error: {
      id: string;
      reporter: string;
      resolved: boolean;
      resolution: string | null;
      reportedAt: string;
    }): void {
      const errorsDb = getErrorDb();
      errorsDb.prepare(
        `INSERT OR IGNORE INTO errors
          (id, errorCode, message, agentId, reporter, status, resolution, rentStroops, maintenanceAccount, createdAt, expiresAt, resolvedAt)
         VALUES
          (?, 0, '', '', ?, 'active', NULL, '0', '', ?, '', NULL)`,
      ).run(error.id, error.reporter ?? "", error.reportedAt ?? new Date().toISOString());
    },

    resolveError(errorId: string, resolution: string): void {
      const store = createErrorRegistryStore(getErrorDb());
      store.resolve(errorId, resolution);
    }
  };

  _agentDbCache.set(db, agentDb);
  return agentDb;
}
