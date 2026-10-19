import Database from "better-sqlite3";
import {
  getDbQueryMetricsSnapshot,
  instrumentDatabase,
  operationOf,
  parseLatencyBucketsMs,
  queryHashOf,
  recordDbQuery,
  resetDbQueryMetrics,
} from "./queryMetrics";

// Force the defaults: slow threshold 200ms and the built-in bucket bounds.
jest.mock("../config", () => ({
  getConfig: () => {
    throw new Error("config unavailable in this test");
  },
}));

describe("parseLatencyBucketsMs", () => {
  it("converts comma-separated milliseconds to ascending seconds", () => {
    expect(parseLatencyBucketsMs("50, 5,10")).toEqual([0.005, 0.01, 0.05]);
  });

  it("drops unparseable and non-positive entries", () => {
    expect(parseLatencyBucketsMs("5,abc,-1,0,10")).toEqual([0.005, 0.01]);
  });

  it("falls back to the defaults when nothing usable is supplied", () => {
    expect(parseLatencyBucketsMs(undefined)).toEqual([0.001, 0.005, 0.01, 0.05, 0.1, 0.5, 1.0]);
    expect(parseLatencyBucketsMs("nonsense")).toEqual([0.001, 0.005, 0.01, 0.05, 0.1, 0.5, 1.0]);
  });
});

describe("operationOf", () => {
  it("classifies statements by their leading keyword", () => {
    expect(operationOf("  SELECT 1")).toBe("select");
    expect(operationOf("INSERT INTO t VALUES (1)")).toBe("insert");
    expect(operationOf("update t set a = 1")).toBe("update");
    expect(operationOf("DELETE FROM t")).toBe("delete");
  });

  it("counts a WITH clause as a select and anything else as other", () => {
    expect(operationOf("WITH x AS (SELECT 1) SELECT * FROM x")).toBe("select");
    expect(operationOf("PRAGMA user_version")).toBe("other");
  });
});

describe("queryHashOf", () => {
  it("is a short, stable fingerprint of the SQL text", () => {
    const sql = "SELECT * FROM agents WHERE id = ?";
    expect(queryHashOf(sql)).toHaveLength(12);
    expect(queryHashOf(sql)).toBe(queryHashOf(sql));
    expect(queryHashOf(sql)).not.toBe(queryHashOf("SELECT 1"));
  });
});

describe("query latency recording", () => {
  beforeEach(() => {
    resetDbQueryMetrics();
  });

  it("aggregates counts, buckets, slow queries and p99 per database", () => {
    recordDbQuery("tasks", "SELECT 1", 0.5);
    recordDbQuery("tasks", "SELECT 2", 2);
    recordDbQuery("tasks", "SELECT 3", 300);

    const snapshot = getDbQueryMetricsSnapshot();
    const tasks = snapshot.databases.tasks!;
    const select = tasks.operations.select!;

    expect(select.count).toBe(3);
    expect(select.overflow).toBe(0);
    expect(tasks.slowQueries).toBe(1);
    expect(tasks.p99LatencyMs).toBe(300);
    // 0.5ms lands in the 1ms bucket, 2ms in the 5ms bucket, 300ms in the 500ms bucket.
    expect(select.buckets.find((b) => b.le === 0.001)!.count).toBe(1);
    expect(select.buckets.find((b) => b.le === 0.005)!.count).toBe(1);
    expect(select.buckets.find((b) => b.le === 0.5)!.count).toBe(1);
  });

  it("keeps operations separate within one database", () => {
    recordDbQuery("agents", "INSERT INTO agents VALUES (1)", 1);
    recordDbQuery("agents", "DELETE FROM agents", 1);

    const ops = getDbQueryMetricsSnapshot().databases.agents!.operations;
    expect(ops.insert!.count).toBe(1);
    expect(ops.delete!.count).toBe(1);
    expect(ops.select).toBeUndefined();
  });

  it("times statements on an instrumented connection", () => {
    const db = new Database(":memory:");
    db.exec("CREATE TABLE t (v INTEGER)");
    instrumentDatabase(db, "payments");

    db.prepare("INSERT INTO t (v) VALUES (?)").run(1);
    expect(db.prepare("SELECT v FROM t").all()).toEqual([{ v: 1 }]);

    const ops = getDbQueryMetricsSnapshot().databases.payments!.operations;
    expect(ops.insert!.count).toBe(1);
    expect(ops.select!.count).toBe(1);
    db.close();
  });
});
