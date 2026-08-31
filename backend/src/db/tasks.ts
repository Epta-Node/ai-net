import Database from "better-sqlite3";
import path from "path";
import type { Task, TaskStatus } from "../types/task";
import type { QualityScoreRecord } from "../services/qualityScorer.types";
import { createLogger } from "../utils/logger";
import { migrateToLatest } from "./migrator";

const logger = createLogger({ component: "task-db" });
const MIGRATIONS_DIR = path.join(__dirname, "migrations", "tasks");

let _taskDb: Database.Database | null = null;

export function getTaskDb(dbPath?: string): Database.Database {
  if (!_taskDb) {
    const filePath = dbPath ?? path.join(process.cwd(), "tasks.db");
    _taskDb = new Database(filePath);
    _taskDb.pragma("busy_timeout = 5000");
    _taskDb.pragma("journal_mode = WAL");
    try {
      (_taskDb as any).on("error", (err: Error) => {
        logger.error({ err }, "task database error");
      });
    } catch {
      // error events are emitted from node EventEmitter support in runtime
    }
    migrateToLatest(_taskDb, MIGRATIONS_DIR);
  }
  return _taskDb;
}

export function closeTaskDb(): void {
  _taskDb?.close();
  _taskDb = null;
}

export interface TaskEvent {
  type: string;
  taskId: string;
  nodeId?: string;
  payload?: unknown;
  timestamp: string;
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
  getEventHistory(taskId: string): TaskEvent[];
  failRunningTasks(): void;
  insertQualityScore(record: QualityScoreRecord): void;
  listQualityScores(agentId?: string, limit?: number): QualityScoreRecord[];
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

      const { total } = db
        .prepare(`SELECT COUNT(*) as total FROM tasks WHERE ${whereClause}`)
        .get(...params) as { total: number };

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
      db.prepare(
        `
        INSERT INTO task_events (taskId, type, nodeId, payload, timestamp)
        VALUES (@taskId, @type, @nodeId, @payload, @timestamp)
      `,
      ).run({
        taskId: event.taskId,
        type: event.type,
        nodeId: event.nodeId ?? null,
        payload:
          event.payload !== undefined ? JSON.stringify(event.payload) : null,
        timestamp: event.timestamp,
      });
    },

    getEventHistory(taskId: string): TaskEvent[] {
      const rows = db
        .prepare("SELECT * FROM task_events WHERE taskId = ? ORDER BY id ASC")
        .all(taskId) as Array<{
        taskId: string;
        type: string;
        nodeId: string | null;
        payload: string | null;
        timestamp: string;
      }>;
      return rows.map((r) => ({
        taskId: r.taskId,
        type: r.type,
        nodeId: r.nodeId ?? undefined,
        payload: r.payload ? JSON.parse(r.payload) : undefined,
        timestamp: r.timestamp,
      }));
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

    listQualityScores(agentId?: string, limit: number = 500): QualityScoreRecord[] {
      const rows = (
        agentId
          ? db
              .prepare(
                "SELECT * FROM quality_scores WHERE agentId = ? ORDER BY id ASC LIMIT ?",
              )
              .all(agentId, limit)
          : db
              .prepare("SELECT * FROM quality_scores ORDER BY id ASC LIMIT ?")
              .all(limit)
      ) as Array<{
        taskId: string;
        nodeId: string;
        agentId: string | null;
        agentType: string;
        score: number;
        completeness: number;
        relevance: number;
        format: number;
        needsReview: number;
        timestamp: string;
      }>;

      return rows.map((r) => ({
        taskId: r.taskId,
        nodeId: r.nodeId,
        agentId: r.agentId ?? undefined,
        agentType: r.agentType,
        score: r.score,
        completeness: r.completeness,
        relevance: r.relevance,
        format: r.format,
        needsReview: r.needsReview === 1,
        timestamp: r.timestamp,
      }));
    },
  };
}
