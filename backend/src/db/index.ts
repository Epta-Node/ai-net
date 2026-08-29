import Database from "better-sqlite3";
import path from "path";
import { createLogger } from "../utils/logger";
import { createPool, type SqlitePool } from "./pool";
import { poolSettings } from "./poolConfig";

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

let _pool: SqlitePool | null = null;

/** Create the payments schema. Runs once, on the pool's writer connection. */
function applyPaymentSchema(db: Database.Database): void {
  (db as unknown as { on: (event: string, fn: (error: Error) => void) => void }).on(
    "error",
    (error: Error) => {
      logger.error({ err: error }, "payment database error");
    },
  );
  db.exec(`
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

/** The payment database's connection pool. */
export function getPaymentPool(dbPath?: string): SqlitePool {
  if (!_pool || _pool.closed) {
    const filePath = dbPath ?? path.join(process.cwd(), "payments.db");
    _pool = createPool({
      filePath,
      ...poolSettings(),
      onCreate: applyPaymentSchema,
    });
    logger.info({ dbPath: filePath }, "payment database pool opened");
  }
  return _pool;
}

/**
 * The writer connection, for the synchronous `createPaymentDb` API.
 *
 * New code should prefer `getPaymentPool().read(...)`.
 */
export function getDb(dbPath?: string): Database.Database {
  return getPaymentPool(dbPath).writer;
}

export function closeDb(): void {
  void _pool?.close();
  _pool = null;
}

/** The payments pool if one is open, else null. Used by the metrics endpoint. */
export function currentPaymentPool(): SqlitePool | null {
  return _pool && !_pool.closed ? _pool : null;
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
  /** All payment records — used by payment reconciliation. */
  listAll(): PaymentRecord[];
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

    listAll(): PaymentRecord[] {
      const rows = db.prepare("SELECT * FROM payments").all() as Array<Record<string, unknown>>;
      return rows.map((row) => ({
        taskId: row.taskId as string,
        nodeId: row.nodeId as string,
        balanceId: row.balanceId as string,
        status: row.status as PaymentStatus,
        amountStroops: BigInt(row.amountStroops as string),
        txHash: row.txHash as string | null,
      }));
    },
  };
}
