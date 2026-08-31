import Database from "better-sqlite3";
import path from "path";
import { migrateToLatest } from "./migrator";

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

let _agentDb: Database.Database | null = null;

export function getAgentDb(dbPath?: string): Database.Database {
  if (!_agentDb) {
    const filePath = dbPath ?? path.join(process.cwd(), "agents.db");
    _agentDb = new Database(filePath);
    migrateToLatest(_agentDb, MIGRATIONS_DIR);
  }
  return _agentDb;
}

export function closeAgentDb(): void {
  _agentDb?.close();
  _agentDb = null;
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
  return {
    upsert(agent: AgentRecord): void {
      db.prepare(`
        INSERT INTO agents (id, capabilities, pricingXLM, endpoint, stellarPublicKey, reputationScore, lastSeenAt, status)
        VALUES (@id, @capabilities, @pricingXLM, @endpoint, @stellarPublicKey, @reputationScore, @lastSeenAt, @status)
        ON CONFLICT(id) DO UPDATE SET
          capabilities = excluded.capabilities,
          pricingXLM = excluded.pricingXLM,
          endpoint = excluded.endpoint,
          stellarPublicKey = excluded.stellarPublicKey,
          lastSeenAt = excluded.lastSeenAt,
          status = excluded.status
      `).run({
        ...agent,
        capabilities: JSON.stringify(agent.capabilities),
        status: agent.status ?? 'offline'
      });
    },

    findById(id: string): AgentRecord | undefined {
      const row = db.prepare("SELECT * FROM agents WHERE id = ?").get(id) as any;
      if (!row) return undefined;
      return {
        ...row,
        capabilities: JSON.parse(row.capabilities),
        status: row.status ?? 'offline'
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
        status: row.status ?? 'offline'
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
      db.prepare("UPDATE agents SET reputationScore = reputationScore + ? WHERE id = ?").run(delta, id);
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
    }
  };
}
