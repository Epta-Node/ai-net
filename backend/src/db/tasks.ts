import Database from "better-sqlite3";
import path from "path";
import type { Task, TaskStatus } from "../types/task";
import { createLogger } from "../utils/logger";

const logger = createLogger({ component: "task-db" });

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
    _taskDb.exec(`
      CREATE TABLE IF NOT EXISTS tasks (
        id              TEXT PRIMARY KEY,
        prompt          TEXT NOT NULL,
        walletPublicKey TEXT NOT NULL DEFAULT '',
        status          TEXT NOT NULL DEFAULT 'queued',
        dagJson         TEXT NOT NULL DEFAULT '[]',
        createdAt       TEXT NOT NULL,
        updatedAt       TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS task_events (
        id        INTEGER PRIMARY KEY AUTOINCREMENT,
        taskId    TEXT    NOT NULL,
        type      TEXT    NOT NULL,
        nodeId    TEXT,
        payload   TEXT,
        timestamp TEXT    NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_task_events_taskId ON task_events (taskId);
    `);
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
  updateStatus(id: string, status: TaskStatus): void;
  updateDagJson(id: string, dagJson: string): void;
  insertEvent(event: TaskEvent): void;
  getEventHistory(taskId: string): TaskEvent[];
  failRunningTasks(): void;
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

      const whereClause = conditions.join(" AND ");

      // Only allow safe sort values — default to DESC
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
  };
}
