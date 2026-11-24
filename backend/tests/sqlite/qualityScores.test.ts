import Database from "better-sqlite3";
import { createTaskDb } from "../../src/db/tasks";

describe("createTaskDb — listQualityScores (#644)", () => {
  function makeDb(): Database.Database {
    const db = new Database(":memory:");
    db.exec(`
      CREATE TABLE IF NOT EXISTS quality_scores (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        taskId       TEXT    NOT NULL,
        nodeId       TEXT    NOT NULL,
        agentId      TEXT,
        agentType    TEXT    NOT NULL,
        score        REAL    NOT NULL,
        completeness REAL    NOT NULL,
        relevance    REAL    NOT NULL,
        format       REAL    NOT NULL,
        needsReview  INTEGER DEFAULT 0,
        timestamp    TEXT    NOT NULL
      );
    `);
    return db;
  }

  it("returns newest 500 rows after 600 inserts and supports cursor pagination", () => {
    const rawDb = makeDb();
    const taskDb = createTaskDb(rawDb);
    const now = new Date().toISOString();

    for (let i = 1; i <= 600; i++) {
      taskDb.insertQualityScore({
        taskId: `t_${i}`,
        nodeId: `n_${i}`,
        agentId: "agent_alpha",
        agentType: "research",
        score: i,
        completeness: 100,
        relevance: 100,
        format: 100,
        needsReview: false,
        timestamp: now,
      });
    }

    // Default call should return newest 500 records (ids 600 down to 101)
    const page1 = taskDb.listQualityScores("agent_alpha");
    expect(page1).toHaveLength(500);
    expect(page1[0].id).toBe(600);
    expect(page1[499].id).toBe(101);

    // Cursor pagination to fetch older records (ids < 101)
    const cursor = page1[499].id; // 101
    const page2 = taskDb.listQualityScores("agent_alpha", 500, cursor);
    expect(page2).toHaveLength(100);
    expect(page2[0].id).toBe(100);
    expect(page2[99].id).toBe(1);
  });

  it("validates and clamps limit parameter to [1, 500]", () => {
    const rawDb = makeDb();
    const taskDb = createTaskDb(rawDb);
    const now = new Date().toISOString();

    for (let i = 1; i <= 10; i++) {
      taskDb.insertQualityScore({
        taskId: `t_${i}`,
        nodeId: `n_${i}`,
        agentType: "coding",
        score: 80,
        completeness: 80,
        relevance: 80,
        format: 80,
        needsReview: false,
        timestamp: now,
      });
    }

    // Custom limit within bounds
    const customLimit = taskDb.listQualityScores(undefined, 5);
    expect(customLimit).toHaveLength(5);

    // Excess limit (> 500) clamped to 500
    const clampedLimit = taskDb.listQualityScores(undefined, 1000);
    expect(clampedLimit).toHaveLength(10);

    // Non-numeric limit defaults to 500
    const nonNumericLimit = taskDb.listQualityScores(undefined, "invalid" as any);
    expect(nonNumericLimit).toHaveLength(10);
  });

  it("handles legacy NULL needsReview explicitly defaulting to false", () => {
    const rawDb = makeDb();
    const taskDb = createTaskDb(rawDb);
    const now = new Date().toISOString();

    // Insert raw SQL row with NULL needsReview
    rawDb.prepare(`
      INSERT INTO quality_scores (taskId, nodeId, agentType, score, completeness, relevance, format, needsReview, timestamp)
      VALUES ('t_legacy', 'n_legacy', 'research', 85, 85, 85, 85, NULL, ?)
    `).run(now);

    const scores = taskDb.listQualityScores();
    expect(scores).toHaveLength(1);
    expect(scores[0].needsReview).toBe(false);
  });
});
