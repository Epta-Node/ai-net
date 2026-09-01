import Database from "better-sqlite3";
import path from "path";
import { migrateToLatest } from "./migrator";
import type { ReputationBreakdown } from "../services/qualityScorer.types";
import { createPool, type SqlitePool } from "./pool";
import { decodeCursor, encodeCursor, type CursorPage } from "./cursor";
import { createErrorRegistryStore, getErrorDb } from "./errorRegistry";

const MIGRATIONS_DIR = path.join(__dirname, "migrations", "agents");

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

let _agentPool: SqlitePool | null = null;

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
  ];
  for (const sql of migrations) {
    try {
      db.exec(sql);
    } catch {
      // Ignored if column already exists
    }
  }
}

/** Lazily open (or reopen) the pooled agent database. */
export function getAgentPool(dbPath?: string): SqlitePool {
  if (!_agentPool || _agentPool.closed) {
    const filePath = dbPath ?? path.join(process.cwd(), "agents.db");
    _agentPool = createPool({
      filePath,
      min: 1,
      max: 4,
      acquireTimeoutMs: 5_000,
      onCreate: (db) => {
        migrateToLatest(db, MIGRATIONS_DIR);
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

export function closeAgentDb(): void {
  void _agentPool?.close();
  _agentPool = null;
}

export interface AgentDb {
  upsert(agent: AgentRecord): void;
  findById(id: string): AgentRecord | undefined;
  list(filters?: { capability?: string; minReputation?: number; maxPriceXLM?: number; status?: string }): AgentRecord[];
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

export function createAgentDb(db: Database.Database): AgentDb {
  ensureAgentTable(db);
  return {
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
        capabilities: JSON.parse(row.capabilities),
        status: row.status ?? 'offline',
        reputationScore: Number(row.reputationScore ?? 2.5),
        bondAmountXLM: Number(row.bondAmountXLM ?? 0),
        tasksCompleted: Number(row.tasksCompleted ?? 0),
        tasksFailed: Number(row.tasksFailed ?? 0),
        lastActiveAt: row.lastActiveAt ?? row.lastSeenAt,
      };
    },

    list(filters?: { capability?: string; minReputation?: number; maxPriceXLM?: number; status?: string }): AgentRecord[] {
      let query = "SELECT * FROM agents WHERE 1=1";
      const params: any[] = [];
      
      if (filters?.minReputation !== undefined) {
        query += " AND reputationScore >= ?";
        params.push(filters.minReputation);
      }
      if (filters?.maxPriceXLM !== undefined) {
        query += " AND pricingXLM <= ?";
        params.push(filters.maxPriceXLM);
      }
      if (filters?.capability !== undefined) {
        query += " AND EXISTS (SELECT 1 FROM json_each(capabilities) WHERE value = ?)";
        params.push(filters.capability);
      }
      if (filters?.status !== undefined) {
        query += " AND status = ?";
        params.push(filters.status);
      }

      const rows = db.prepare(query).all(...params) as any[];
      return rows.map(row => ({
        ...row,
        capabilities: JSON.parse(row.capabilities),
        status: row.status ?? 'offline',
        reputationScore: Number(row.reputationScore ?? 2.5),
        bondAmountXLM: Number(row.bondAmountXLM ?? 0),
        tasksCompleted: Number(row.tasksCompleted ?? 0),
        tasksFailed: Number(row.tasksFailed ?? 0),
        lastActiveAt: row.lastActiveAt ?? row.lastSeenAt,
      }));
    },

    listCursor(options: AgentCursorOptions = {}): CursorPage<AgentRecord> {
      const limit = Math.min(Math.max(options.limit ?? 20, 1), 100);

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
        conditions.push("EXISTS (SELECT 1 FROM json_each(capabilities) WHERE value = ?)");
        params.push(options.capability);
      }
      if (options.status !== undefined) {
        conditions.push("status = ?");
        params.push(options.status);
      }

      let cursorCondition = "";
      const cursorParams: unknown[] = [];

      if (options.cursor) {
        const payload = decodeCursor(options.cursor);
        if (payload?.lastSeenAt && payload?.id) {
          // Compound keyset: rows that come after (lastSeenAt DESC, id DESC)
          cursorCondition = "AND (lastSeenAt < ? OR (lastSeenAt = ? AND id < ?))";
          cursorParams.push(payload.lastSeenAt, payload.lastSeenAt, payload.id);
        }
      }

      const whereClause = conditions.join(" AND ");
      // Fetch limit+1 to detect whether a next page exists without a COUNT query
      const rows = db
        .prepare(
          `SELECT * FROM agents
           WHERE ${whereClause} ${cursorCondition}
           ORDER BY lastSeenAt DESC, id DESC
           LIMIT ?`,
        )
        .all(...params, ...cursorParams, limit + 1) as any[];

      const hasMore = rows.length > limit;
      const pageRows = hasMore ? rows.slice(0, limit) : rows;

      const agents: AgentRecord[] = pageRows.map((row) => ({
        ...row,
        capabilities: JSON.parse(row.capabilities),
        status: row.status ?? 'offline',
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
}
