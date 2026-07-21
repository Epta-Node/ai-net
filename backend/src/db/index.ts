import Database from "better-sqlite3";
import path from "path";
import { createLogger } from "../utils/logger";

export type PaymentStatus = "locked" | "released" | "refunded";

export interface PaymentRecord {
  taskId: string;
  nodeId: string;
  balanceId: string;
  status: PaymentStatus;
  amountStroops: bigint;
  txHash: string | null;
}

const logger = createLogger({ component: "payment-db" });

let _db: Database.Database | null = null;

export function getDb(dbPath?: string): Database.Database {
  if (!_db) {
    const filePath = dbPath ?? path.join(process.cwd(), "payments.db");
    _db = new Database(filePath as unknown as string);
    _db.pragma("busy_timeout = 5000");
    _db.pragma("journal_mode = WAL");
    logger.info({ dbPath: filePath }, "payment database opened");
    (_db as unknown as { on: (event: string, fn: (error: Error) => void) => void }).on(
      "error",
      (error: Error) => {
        logger.error({ err: error }, "payment database error");
      },
    );
    _db.exec(`
      CREATE TABLE IF NOT EXISTS payments (
        taskId       TEXT NOT NULL,
        nodeId       TEXT NOT NULL,
        balanceId    TEXT NOT NULL,
        status       TEXT NOT NULL DEFAULT 'locked',
        amountStroops TEXT NOT NULL,
        txHash       TEXT,
        PRIMARY KEY (taskId, nodeId)
      )
    `);
  }
  return _db;
}

export function closeDb(): void {
  _db?.close();
  _db = null;
}

export function paymentDbHealthCheck(): boolean {
  try {
    const db = getDb();
    db.prepare("SELECT 1").get();
    return true;
  } catch (error) {
    logger.error({ err: error }, "payment database health check failed");
    return false;
  }
}

export interface PaymentDb {
  insert(record: PaymentRecord): void;
  findByKey(taskId: string, nodeId: string): PaymentRecord | undefined;
  updateStatus(taskId: string, nodeId: string, status: PaymentStatus, txHash: string): void;
}

export function createPaymentDb(db: Database.Database): PaymentDb {
  return {
    insert(record: PaymentRecord): void {
      db.prepare(`
        INSERT INTO payments (taskId, nodeId, balanceId, status, amountStroops, txHash)
        VALUES (@taskId, @nodeId, @balanceId, @status, @amountStroops, @txHash)
      `).run({
        ...record,
        amountStroops: record.amountStroops.toString(),
        txHash: record.txHash,
      });
    },

    findByKey(taskId: string, nodeId: string): PaymentRecord | undefined {
      const row = db.prepare(
        "SELECT * FROM payments WHERE taskId = ? AND nodeId = ?"
      ).get(taskId, nodeId) as Record<string, unknown> | undefined;
      if (!row) return undefined;
      return {
        taskId: row.taskId as string,
        nodeId: row.nodeId as string,
        balanceId: row.balanceId as string,
        status: row.status as PaymentStatus,
        amountStroops: BigInt(row.amountStroops as string),
        txHash: row.txHash as string | null,
      };
    },

    updateStatus(taskId: string, nodeId: string, status: PaymentStatus, txHash: string): void {
      db.prepare(
        "UPDATE payments SET status = ?, txHash = ? WHERE taskId = ? AND nodeId = ?"
      ).run(status, txHash, taskId, nodeId);
    },
  };
}
