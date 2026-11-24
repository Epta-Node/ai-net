import Database from "better-sqlite3";
import path from "path";
import type { Task, TaskStatus } from "../types/task";
import type { QualityScoreRecord } from "../services/qualityScorer.types";
import { ValidationError } from "../errors";
import { createLogger } from "../utils/logger";
import { migrateToLatest } from "./migrator";
import { createPool, type SqlitePool } from "./pool";
import { decodeCursor, encodeCursor, type CursorPage } from "./cursor";

const logger = createLogger({ component: "task-db" });
const MIGRATIONS_DIR = path.join(__dirname, "migrations", "tasks");

let _taskPool: SqlitePool | null = null;
let _taskPoolClosing: Promise<void> | null = null;

/** Lazily open (or reopen) the pooled task database. */
export function getTaskPool(dbPath?: string): SqlitePool {
  if (_taskPoolClosing) throw new Error("Task database is closing");
  if (!_taskPool || _taskPool.closed) {
    const filePath = dbPath ?? path.join(process.cwd(), "tasks.db");
    _taskPool = createPool({
      filePath,
      name: "tasks",
      min: 1,
      max: 4,
      acquireTimeoutMs: 5_000,
      onCreate: (db) => {
        try {
          (db as any).on("error", (err: Error) => {
            logger.error({ err }, "task database error");
          });
        } catch {
          // error events are emitted from node EventEmitter support in runtime
        }
        migrateToLatest(db, MIGRATIONS_DIR);
      },
    });
  }
  return _taskPool;
}

/**
 * The writer connection, for the synchronous `createTaskDb` API.
 *
 * Kept so existing callers work unchanged; new code should prefer
 * `getTaskPool().read(...)` so reads are spread across the pool.
 */
export function getTaskDb(dbPath?: string): Database.Database {
  return getTaskPool(dbPath).writer;
}

/** The task pool if one is open, else null. Used by the metrics endpoint. */
export function currentTaskPool(): SqlitePool | null {
  return _taskPool && !_taskPool.closed ? _taskPool : null;
}

export function closeTaskDb(): Promise<void> {
  if (_taskPoolClosing) return _taskPoolClosing;
  const pool = _taskPool;
  if (!pool) return Promise.resolve();
  _taskPoolClosing = pool.close().finally(() => {
    if (_taskPool === pool) _taskPool = null;
    _taskPoolClosing = null;
  });
  return _taskPoolClosing;
}

export interface TaskEvent {
  type: string;
  taskId: string;
  nodeId?: string;
  payload?: unknown;
  /** ISO-8601 timestamp — stored in the `occurred_at` column (schema A). */
  timestamp: string;
}

export interface TaskEventHistoryOptions {
  /** Task-local sequence from nextCursor; omitted (or -1) starts before sequence zero. */
  afterId?: number;
  /** Defaults to 100; must be an integer from 1 to 100. */
  limit?: number;
}

export interface TaskEventHistoryPage {
  items: TaskEvent[];
  nextCursor: number | null;
}

export interface TaskListOptions {
  status?: string;
  q?: string;
  sort?: "createdAt:asc" | "createdAt:desc";
  /** ISO timestamp — only return tasks created after this point. */
  createdAfter?: string;
}

export interface TaskCursorOptions {
  /** Opaque cursor from a previous page's nextCursor field. */
  cursor?: string;
  /** Max items per page (1–100, default 20). */
  limit?: number;
  status?: string;
  q?: string;
  sort?: "createdAt:asc" | "createdAt:desc";
}

/** A task's settled billing snapshot, as stored in `task_costs`. */
export interface PersistedTaskCost {
  taskId: string;
  walletPublicKey: string;
  budgetTokens: number;
  usedTokens: number;
  costUsd: number;
  currency: string;
  exceeded: boolean;
  calls: number;
  createdAt: string;
  settledAt: string;
}

/** One node's contribution to a task's cost, as stored in `task_token_usage`. */
export interface PersistedNodeUsage {
  taskId: string;
  nodeId: string;
  agentId: string;
  agentType: string;
  model: string;
  calls: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  costUsd: number;
  trimmed: boolean;
  budgetExhausted: boolean;
  updatedAt: string;
}

/** Cross-task cost rollup for a single agent. */
export interface AgentCostTotal {
  agentId: string;
  agentType: string;
  tasks: number;
  calls: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  costUsd: number;
}

/** Filters for {@link TaskDb.listCostBreakdown}; every field is optional. */
export interface CostBreakdownFilter {
  agentId?: string;
  agentType?: string;
  model?: string;
  /** UTC calendar day, `YYYY-MM-DD`. */
  day?: string;
}

/**
 * Spend for one (agent, model, day) combination. Carries only identifiers and
 * counters: no prompts, completions or wallet keys are ever stored with cost.
 */
export interface CostBreakdownRow {
  agentId: string;
  agentType: string;
  model: string;
  /** UTC day of the usage row's last update, `YYYY-MM-DD`. */
  day: string;
  tasks: number;
  calls: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  costUsd: number;
}

/** Platform-wide cost totals. */
export interface CostTotals {
  tasks: number;
  calls: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  costUsd: number;
  overBudgetTasks: number;
}

export interface TaskDb {
  insert(task: Task): void;
  findById(id: string): Task | undefined;
  list(
    walletPublicKey: string,
    page: number,
    pageSize: number,
    options?: TaskListOptions,
  ): { tasks: Task[]; total: number };
  /**
   * Cursor-based list — stable under concurrent writes.
   * Default keyset: (createdAt DESC, id DESC).
   */
  listCursor(
    walletPublicKey: string,
    options?: TaskCursorOptions,
  ): CursorPage<Task>;
  updateStatus(id: string, status: TaskStatus): void;
  updateDagJson(id: string, dagJson: string): void;
  insertEvent(event: TaskEvent): void;
  getEventHistory(taskId: string, options?: TaskEventHistoryOptions): TaskEventHistoryPage;
  failRunningTasks(): void;
  insertQualityScore(record: QualityScoreRecord): void;
  listQualityScores(agentId?: string, limit?: number, cursor?: number): QualityScoreRecord[];

  /**
   * Write (or overwrite) a task's billing snapshot. Called once the task
   * settles, so re-snapshotting the same task is idempotent.
   */
  upsertTaskCost(record: PersistedTaskCost): void;
  getTaskCost(taskId: string): PersistedTaskCost | undefined;
  /**
   * Fold one node's usage into its row.
   *
   * Upsert-and-add rather than insert: a node retried after a transient
   * provider error should accumulate onto the same row, and concurrent nodes
   * of one task must not clobber each other's counters.
   */
  addNodeUsage(record: PersistedNodeUsage): void;
  /**
   * Overwrite a node's row with the authoritative running total.
   *
   * Distinct from `addNodeUsage`, which accumulates deltas. The budget ledger
   * holds cumulative per-node totals, so re-persisting the same total (on a
   * retry, a second flush, or settlement) must be idempotent — adding it again
   * would double-count the node's spend.
   */
  setNodeUsage(record: PersistedNodeUsage): void;
  listNodeUsage(taskId: string): PersistedNodeUsage[];
  /** Cost rollup per agent across all tasks, for the stats endpoint. */
  listAgentCostTotals(limit?: number): AgentCostTotal[];
  /** Platform-wide totals plus a recent-spend series, for the stats endpoint. */
  getCostTotals(): CostTotals;
  listCostBreakdown(filter?: CostBreakdownFilter, limit?: number): CostBreakdownRow[];
  /** USD spent on the given UTC day (`YYYY-MM-DD`), across all tasks and agents. */
  getDailySpendUsd(day: string): number;
  listRecentCosts(limit?: number): PersistedTaskCost[];
}

export function createTaskDb(db: Database.Database): TaskDb {
  return {
    insert(task: Task): void {
      db.prepare(
        `
        INSERT INTO tasks (id, prompt, walletPublicKey, status, dagJson, createdAt, updatedAt)
        VALUES (@id, @prompt, @walletPublicKey, @status, @dagJson, @createdAt, @updatedAt)
      `,
      ).run({
        ...task,
        dagJson: JSON.stringify(task.dag),
      });
    },

    findById(id: string): Task | undefined {
      const row = db.prepare("SELECT * FROM tasks WHERE id = ?").get(id) as any;
      if (!row) return undefined;
      return {
        ...row,
        dag: JSON.parse(row.dagJson),
      };
    },

    list(
      walletPublicKey: string,
      page: number,
      pageSize: number,
      options: TaskListOptions = {},
    ) {
      const offset = (page - 1) * pageSize;
      const conditions: string[] = ["walletPublicKey = ?"];
      const params: unknown[] = [walletPublicKey];

      if (options.status) {
        conditions.push("status = ?");
        params.push(options.status);
      }
      if (options.q) {
        conditions.push("prompt LIKE ?");
        params.push(`%${options.q}%`);
      }
      if (options.createdAfter) {
        conditions.push("createdAt > ?");
        params.push(options.createdAfter);
      }

      const whereClause = conditions.join(" AND ");
      const sortOrder = options.sort === "createdAt:asc" ? "ASC" : "DESC";

      const rows = db
        .prepare(
          `SELECT * FROM tasks WHERE ${whereClause} ORDER BY createdAt ${sortOrder} LIMIT ? OFFSET ?`,
        )
        .all(...params, pageSize, offset) as any[];

      const tasks: Task[] = rows.map((row) => ({
        ...row,
        dag: JSON.parse(row.dagJson),
      }));

      const countRow = db
        .prepare(`SELECT COUNT(*) as total FROM tasks WHERE ${whereClause}`)
        .get(...params) as { total?: number } | undefined;
      const total = countRow?.total ?? 0;

      return { tasks, total };
    },

    listCursor(
      walletPublicKey: string,
      options: TaskCursorOptions = {},
    ): CursorPage<Task> {
      const limit = Math.min(Math.max(options.limit ?? 20, 1), 100);
      const sortOrder = options.sort === "createdAt:asc" ? "ASC" : "DESC";
      // Keyset comparator flips based on sort direction
      const keyOp = sortOrder === "DESC" ? "<" : ">";

      const conditions: string[] = ["walletPublicKey = ?"];
      const params: unknown[] = [walletPublicKey];

      if (options.status) {
        conditions.push("status = ?");
        params.push(options.status);
      }
      if (options.q) {
        conditions.push("prompt LIKE ?");
        params.push(`%${options.q}%`);
      }

      let cursorCondition = "";
      const cursorParams: unknown[] = [];

      if (options.cursor) {
        const payload = decodeCursor(options.cursor);
        if (payload?.createdAt && payload?.id) {
          // Compound keyset prevents instability when timestamps collide
          cursorCondition = `AND (createdAt ${keyOp} ? OR (createdAt = ? AND id ${keyOp} ?))`;
          cursorParams.push(payload.createdAt, payload.createdAt, payload.id);
        }
      }

      const whereClause = conditions.join(" AND ");
      // Fetch limit+1 to detect a next page without a COUNT query
      const rows = db
        .prepare(
          `SELECT * FROM tasks
           WHERE ${whereClause} ${cursorCondition}
           ORDER BY createdAt ${sortOrder}, id ${sortOrder}
           LIMIT ?`,
        )
        .all(...params, ...cursorParams, limit + 1) as any[];

      const hasMore = rows.length > limit;
      const pageRows = hasMore ? rows.slice(0, limit) : rows;

      const tasks: Task[] = pageRows.map((row) => ({
        ...row,
        dag: JSON.parse(row.dagJson),
      }));

      const result: CursorPage<Task> = { items: tasks };
      if (hasMore) {
        const last = pageRows[pageRows.length - 1];
        result.nextCursor = encodeCursor({ createdAt: last.createdAt, id: last.id });
      }
      return result;
    },

    updateStatus(id: string, status: TaskStatus): void {
      db.prepare("UPDATE tasks SET status = ?, updatedAt = ? WHERE id = ?").run(
        status,
        new Date().toISOString(),
        id,
      );
    },

    updateDagJson(id: string, dagJson: string): void {
      db.prepare(
        "UPDATE tasks SET dagJson = ?, updatedAt = ? WHERE id = ?",
      ).run(dagJson, new Date().toISOString(), id);
    },

    insertEvent(event: TaskEvent): void {
      // Assign a per-task sequence number by looking up the current max.
      // This is a simple approach suitable for the legacy TaskDb path; the
      // EventBus / EventStore path uses its own atomic counter.
      const row = db
        .prepare(
          'SELECT COALESCE(MAX(task_seq), -1) AS max_seq FROM task_events WHERE task_id = ?',
        )
        .get(event.taskId) as { max_seq: number };
      const nextSeq = (row?.max_seq ?? -1) + 1;

      db.prepare(
        `
        INSERT INTO task_events (task_seq, version, type, task_id, node_id, occurred_at, payload)
        VALUES (@task_seq, @version, @type, @task_id, @node_id, @occurred_at, @payload)
      `,
      ).run({
        task_seq: nextSeq,
        version: 1,
        type: event.type,
        task_id: event.taskId,
        node_id: event.nodeId ?? null,
        occurred_at: event.timestamp,
        payload:
          event.payload !== undefined ? JSON.stringify(event.payload) : null,
      });
    },

    getEventHistory(taskId: string, options: TaskEventHistoryOptions = {}): TaskEventHistoryPage {
      const { afterId = -1, limit = 100 } = options;
      if (!Number.isSafeInteger(afterId) || afterId < -1) {
        throw new ValidationError("afterId must be a safe integer greater than or equal to -1");
      }
      if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
        throw new ValidationError("limit must be an integer between 1 and 100");
      }
      // task_seq is the immutable per-task cursor in the current event schema.
      const rows = db.prepare(`
        SELECT task_seq, task_id, type, node_id, payload, occurred_at
        FROM task_events WHERE task_id = ? AND task_seq > ?
        ORDER BY task_seq ASC LIMIT ?
      `).all(taskId, afterId, limit + 1) as Array<{
        task_seq: number;
        task_id: string;
        type: string;
        node_id: string | null;
        payload: string | null;
        occurred_at: string;
      }>;
      const hasMore = rows.length > limit;
      const page = rows.slice(0, limit);
      return {
        items: page.map((r) => ({
          taskId: r.task_id,
          type: r.type,
          nodeId: r.node_id ?? undefined,
          payload: r.payload ? JSON.parse(r.payload) : undefined,
          timestamp: r.occurred_at,
        })),
        nextCursor: hasMore ? page[page.length - 1].task_seq : null,
      };
    },

    failRunningTasks(): void {
      const now = new Date().toISOString();
      const runningTasks = db.prepare("SELECT * FROM tasks WHERE status = 'running'").all() as any[];
      for (const task of runningTasks) {
        let dag: any[] = [];
        try {
          dag = JSON.parse(task.dagJson);
          for (const node of dag) {
            if (node.status === 'running' || node.status === 'pending') {
              node.status = 'failed';
              node.error = 'Server shutdown';
            }
          }
        } catch (e) {
          // ignore parse error
        }
        db.prepare("UPDATE tasks SET status = 'failed', dagJson = ?, updatedAt = ? WHERE id = ?").run(
          JSON.stringify(dag),
          now,
          task.id
        );
      }
    },

    insertQualityScore(record: QualityScoreRecord): void {
      db.prepare(
        `
        INSERT INTO quality_scores (taskId, nodeId, agentId, agentType, score, completeness, relevance, format, needsReview, timestamp)
        VALUES (@taskId, @nodeId, @agentId, @agentType, @score, @completeness, @relevance, @format, @needsReview, @timestamp)
      `,
      ).run({
        taskId: record.taskId,
        nodeId: record.nodeId,
        agentId: record.agentId ?? null,
        agentType: record.agentType,
        score: record.score,
        completeness: record.completeness,
        relevance: record.relevance,
        format: record.format,
        needsReview: record.needsReview ? 1 : 0,
        timestamp: record.timestamp,
      });
    },

    listQualityScores(agentId?: string, limit: number = 500, cursor?: number): QualityScoreRecord[] {
      let boundedLimit = typeof limit === "number" && !isNaN(limit) ? Math.floor(limit) : 500;
      boundedLimit = Math.max(1, Math.min(500, boundedLimit));

      const conditions: string[] = [];
      const params: any[] = [];

      if (agentId) {
        conditions.push("agentId = ?");
        params.push(agentId);
      }

      if (cursor !== undefined && cursor !== null && !isNaN(Number(cursor))) {
        conditions.push("id < ?");
        params.push(Number(cursor));
      }

      const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
      const query = `SELECT * FROM quality_scores ${whereClause} ORDER BY id DESC LIMIT ?`;
      params.push(boundedLimit);

      const rows = db.prepare(query).all(...params) as Array<{
        id: number;
        taskId: string;
        nodeId: string;
        agentId: string | null;
        agentType: string;
        score: number;
        completeness: number;
        relevance: number;
        format: number;
        needsReview: number | null;
        timestamp: string;
      }>;

      return rows.map((r) => ({
        id: r.id,
        taskId: r.taskId,
        nodeId: r.nodeId,
        agentId: r.agentId ?? undefined,
        agentType: r.agentType,
        score: r.score,
        completeness: r.completeness,
        relevance: r.relevance,
        format: r.format,
        /** Default legacy NULL or non-1 needsReview to false */
        needsReview: r.needsReview === 1,
        timestamp: r.timestamp,
      }));
    },

    upsertTaskCost(record: PersistedTaskCost): void {
      db.prepare(
        `
        INSERT INTO task_costs (
          taskId, walletPublicKey, budgetTokens, usedTokens, costUsd,
          currency, exceeded, calls, createdAt, settledAt
        )
        VALUES (
          @taskId, @walletPublicKey, @budgetTokens, @usedTokens, @costUsd,
          @currency, @exceeded, @calls, @createdAt, @settledAt
        )
        ON CONFLICT(taskId) DO UPDATE SET
          walletPublicKey = excluded.walletPublicKey,
          budgetTokens   = excluded.budgetTokens,
          usedTokens     = excluded.usedTokens,
          costUsd        = excluded.costUsd,
          currency       = excluded.currency,
          exceeded       = excluded.exceeded,
          calls          = excluded.calls,
          settledAt      = excluded.settledAt
      `,
      ).run({
        taskId: record.taskId,
        walletPublicKey: record.walletPublicKey,
        budgetTokens: record.budgetTokens,
        usedTokens: record.usedTokens,
        costUsd: record.costUsd,
        currency: record.currency,
        exceeded: record.exceeded ? 1 : 0,
        calls: record.calls,
        createdAt: record.createdAt,
        settledAt: record.settledAt,
      });
    },

    getTaskCost(taskId: string): PersistedTaskCost | undefined {
      const row = db.prepare("SELECT * FROM task_costs WHERE taskId = ?").get(taskId) as any;
      return row ? toPersistedTaskCost(row) : undefined;
    },

    addNodeUsage(record: PersistedNodeUsage): void {
      // ON CONFLICT DO UPDATE with column = column + excluded.column, so a
      // retried node accumulates instead of overwriting the earlier attempt.
      // `trimmed` / `budgetExhausted` are sticky flags: once either is set it
      // stays set, since the flag describes the node's history.
      db.prepare(
        `
        INSERT INTO task_token_usage (
          taskId, nodeId, agentId, agentType, model, calls,
          promptTokens, completionTokens, totalTokens, costUsd,
          trimmed, budgetExhausted, updatedAt
        )
        VALUES (
          @taskId, @nodeId, @agentId, @agentType, @model, @calls,
          @promptTokens, @completionTokens, @totalTokens, @costUsd,
          @trimmed, @budgetExhausted, @updatedAt
        )
        ON CONFLICT(taskId, nodeId) DO UPDATE SET
          agentId          = CASE WHEN excluded.agentId <> '' THEN excluded.agentId ELSE task_token_usage.agentId END,
          agentType        = CASE WHEN excluded.agentType <> '' THEN excluded.agentType ELSE task_token_usage.agentType END,
          model            = CASE WHEN excluded.model <> '' THEN excluded.model ELSE task_token_usage.model END,
          calls            = task_token_usage.calls + excluded.calls,
          promptTokens     = task_token_usage.promptTokens + excluded.promptTokens,
          completionTokens = task_token_usage.completionTokens + excluded.completionTokens,
          totalTokens      = task_token_usage.totalTokens + excluded.totalTokens,
          costUsd          = task_token_usage.costUsd + excluded.costUsd,
          trimmed          = MAX(task_token_usage.trimmed, excluded.trimmed),
          budgetExhausted  = MAX(task_token_usage.budgetExhausted, excluded.budgetExhausted),
          updatedAt        = excluded.updatedAt
      `,
      ).run({
        taskId: record.taskId,
        nodeId: record.nodeId,
        agentId: record.agentId,
        agentType: record.agentType,
        model: record.model,
        calls: record.calls,
        promptTokens: record.promptTokens,
        completionTokens: record.completionTokens,
        totalTokens: record.totalTokens,
        costUsd: record.costUsd,
        trimmed: record.trimmed ? 1 : 0,
        budgetExhausted: record.budgetExhausted ? 1 : 0,
        updatedAt: record.updatedAt,
      });
    },

    setNodeUsage(record: PersistedNodeUsage): void {
      // Overwrite with the caller's running total rather than adding to it.
      // Sticky flags still latch: a node that was trimmed on any attempt keeps
      // `trimmed = 1` even if a later total is written with it false.
      db.prepare(
        `
        INSERT INTO task_token_usage (
          taskId, nodeId, agentId, agentType, model, calls,
          promptTokens, completionTokens, totalTokens, costUsd,
          trimmed, budgetExhausted, updatedAt
        )
        VALUES (
          @taskId, @nodeId, @agentId, @agentType, @model, @calls,
          @promptTokens, @completionTokens, @totalTokens, @costUsd,
          @trimmed, @budgetExhausted, @updatedAt
        )
        ON CONFLICT(taskId, nodeId) DO UPDATE SET
          agentId          = CASE WHEN excluded.agentId <> '' THEN excluded.agentId ELSE task_token_usage.agentId END,
          agentType        = CASE WHEN excluded.agentType <> '' THEN excluded.agentType ELSE task_token_usage.agentType END,
          model            = CASE WHEN excluded.model <> '' THEN excluded.model ELSE task_token_usage.model END,
          calls            = excluded.calls,
          promptTokens     = excluded.promptTokens,
          completionTokens = excluded.completionTokens,
          totalTokens      = excluded.totalTokens,
          costUsd          = excluded.costUsd,
          trimmed          = MAX(task_token_usage.trimmed, excluded.trimmed),
          budgetExhausted  = MAX(task_token_usage.budgetExhausted, excluded.budgetExhausted),
          updatedAt        = excluded.updatedAt
      `,
      ).run({
        taskId: record.taskId,
        nodeId: record.nodeId,
        agentId: record.agentId,
        agentType: record.agentType,
        model: record.model,
        calls: record.calls,
        promptTokens: record.promptTokens,
        completionTokens: record.completionTokens,
        totalTokens: record.totalTokens,
        costUsd: record.costUsd,
        trimmed: record.trimmed ? 1 : 0,
        budgetExhausted: record.budgetExhausted ? 1 : 0,
        updatedAt: record.updatedAt,
      });
    },

    listNodeUsage(taskId: string): PersistedNodeUsage[] {
      const rows = db
        .prepare(
          "SELECT * FROM task_token_usage WHERE taskId = ? ORDER BY costUsd DESC, nodeId ASC",
        )
        .all(taskId) as any[];
      return rows.map(toPersistedNodeUsage);
    },

    listAgentCostTotals(limit: number = 50): AgentCostTotal[] {
      const rows = db
        .prepare(
          `
          SELECT
            agentId,
            agentType,
            COUNT(DISTINCT taskId)  AS tasks,
            SUM(calls)              AS calls,
            SUM(promptTokens)       AS promptTokens,
            SUM(completionTokens)   AS completionTokens,
            SUM(totalTokens)        AS totalTokens,
            SUM(costUsd)            AS costUsd
          FROM task_token_usage
          WHERE agentId <> ''
          GROUP BY agentId, agentType
          ORDER BY costUsd DESC
          LIMIT ?
        `,
        )
        .all(limit) as any[];
      return rows.map((r) => ({
        agentId: r.agentId,
        agentType: r.agentType,
        tasks: r.tasks ?? 0,
        calls: r.calls ?? 0,
        promptTokens: r.promptTokens ?? 0,
        completionTokens: r.completionTokens ?? 0,
        totalTokens: r.totalTokens ?? 0,
        costUsd: round6(r.costUsd ?? 0),
      }));
    },

    getCostTotals(): CostTotals {
      const row = db
        .prepare(
          `
          SELECT
            COUNT(*)              AS tasks,
            SUM(calls)            AS calls,
            SUM(promptTokens)     AS promptTokens,
            SUM(completionTokens) AS completionTokens,
            SUM(totalTokens)      AS totalTokens,
            SUM(costUsd)          AS costUsd,
            SUM(exceeded)         AS overBudgetTasks
          FROM task_costs
        `,
        )
        .get() as any;
      return {
        tasks: row?.tasks ?? 0,
        calls: row?.calls ?? 0,
        promptTokens: row?.promptTokens ?? 0,
        completionTokens: row?.completionTokens ?? 0,
        totalTokens: row?.totalTokens ?? 0,
        costUsd: round6(row?.costUsd ?? 0),
        overBudgetTasks: row?.overBudgetTasks ?? 0,
      };
    },

    listCostBreakdown(filter: CostBreakdownFilter = {}, limit: number = 100): CostBreakdownRow[] {
      const conditions: string[] = [];
      const params: Record<string, string | number> = { limit };
      if (filter.agentId !== undefined) {
        conditions.push("agentId = @agentId");
        params.agentId = filter.agentId;
      }
      if (filter.agentType !== undefined) {
        conditions.push("agentType = @agentType");
        params.agentType = filter.agentType;
      }
      if (filter.model !== undefined) {
        conditions.push("model = @model");
        params.model = filter.model;
      }
      if (filter.day !== undefined) {
        conditions.push("substr(updatedAt, 1, 10) = @day");
        params.day = filter.day;
      }
      const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
      const rows = db
        .prepare(
          `
          SELECT
            agentId,
            agentType,
            model,
            substr(updatedAt, 1, 10) AS day,
            COUNT(DISTINCT taskId)  AS tasks,
            SUM(calls)              AS calls,
            SUM(promptTokens)       AS promptTokens,
            SUM(completionTokens)   AS completionTokens,
            SUM(totalTokens)        AS totalTokens,
            SUM(costUsd)            AS costUsd
          FROM task_token_usage
          ${where}
          GROUP BY agentId, agentType, model, day
          ORDER BY day DESC, costUsd DESC
          LIMIT @limit
        `,
        )
        .all(params) as any[];
      return rows.map((r) => ({
        agentId: r.agentId,
        agentType: r.agentType,
        model: r.model,
        day: r.day,
        tasks: r.tasks ?? 0,
        calls: r.calls ?? 0,
        promptTokens: r.promptTokens ?? 0,
        completionTokens: r.completionTokens ?? 0,
        totalTokens: r.totalTokens ?? 0,
        costUsd: round6(r.costUsd ?? 0),
      }));
    },

    getDailySpendUsd(day: string): number {
      const row = db
        .prepare(
          "SELECT SUM(costUsd) AS costUsd FROM task_token_usage WHERE substr(updatedAt, 1, 10) = ?",
        )
        .get(day) as any;
      return round6(row?.costUsd ?? 0);
    },

    listRecentCosts(limit: number = 20): PersistedTaskCost[] {
      const rows = db
        .prepare("SELECT * FROM task_costs ORDER BY settledAt DESC LIMIT ?")
        .all(limit) as any[];
      return rows.map(toPersistedTaskCost);
    },
  };
}

function round6(value: number): number {
  return Math.round(value * 1e6) / 1e6;
}

function toPersistedTaskCost(row: any): PersistedTaskCost {
  return {
    taskId: row.taskId,
    walletPublicKey: row.walletPublicKey ?? '',
    budgetTokens: row.budgetTokens ?? 0,
    usedTokens: row.usedTokens ?? 0,
    costUsd: row.costUsd ?? 0,
    currency: row.currency ?? 'USD',
    exceeded: row.exceeded === 1,
    calls: row.calls ?? 0,
    createdAt: row.createdAt,
    settledAt: row.settledAt,
  };
}

function toPersistedNodeUsage(row: any): PersistedNodeUsage {
  return {
    taskId: row.taskId,
    nodeId: row.nodeId,
    agentId: row.agentId ?? '',
    agentType: row.agentType ?? '',
    model: row.model ?? '',
    calls: row.calls ?? 0,
    promptTokens: row.promptTokens ?? 0,
    completionTokens: row.completionTokens ?? 0,
    totalTokens: row.totalTokens ?? 0,
    costUsd: row.costUsd ?? 0,
    trimmed: row.trimmed === 1,
    budgetExhausted: row.budgetExhausted === 1,
    updatedAt: row.updatedAt,
  };
}
