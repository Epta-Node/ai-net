import request from "supertest";
import Database from "better-sqlite3";
import { createApp } from "../src/api";
import { getTaskDb, closeTaskDb, createTaskDb } from "../src/db/tasks";
import type { TaskStatus } from "../src/types/task";

// Use in-memory SQLite for tests by monkey-patching getTaskDb
let inMemoryDb: Database.Database;

beforeAll(() => {
  inMemoryDb = new Database(":memory:");
  inMemoryDb.exec(`
    CREATE TABLE IF NOT EXISTS tasks (
      id              TEXT PRIMARY KEY,
      prompt          TEXT NOT NULL,
      walletPublicKey TEXT NOT NULL DEFAULT '',
      status          TEXT NOT NULL DEFAULT 'queued',
      dagJson         TEXT NOT NULL DEFAULT '[]',
      createdAt       TEXT NOT NULL,
      updatedAt       TEXT NOT NULL
    )
  `);
  // Override getTaskDb to return the in-memory db
  jest
    .spyOn(require("../src/db/tasks"), "getTaskDb")
    .mockReturnValue(inMemoryDb);
  jest.useFakeTimers();
});

afterAll(() => {
  app.close();
  inMemoryDb.close();
  jest.restoreAllMocks();
  jest.useRealTimers();
});

const app = createApp();
const WALLET = "GCEZWKCA5VLDNRLN3RPRJMRZOX3Z6G5CHCGDG6NXGPTVMLHK4HZ7HHN";

describe("POST /api/tasks", () => {
  it("returns 201 with taskId and DAG with >= 1 node for valid prompt", async () => {
    const res = await request(app.httpServer)
      .post("/api/tasks")
      .set("walletpublickey", WALLET)
      .send({
        prompt: "Generate a market entry report for solar energy",
        maxBudgetXLM: 1,
      });

    expect(res.status).toBe(201);
    expect(res.body.taskId).toMatch(/^task_/);
    expect(Array.isArray(res.body.dagPreview)).toBe(true);
    expect(res.body.dagPreview.length).toBeGreaterThanOrEqual(1);
    expect(res.body.status).toBe("queued");
  });

  it("returns 400 when maxBudgetXLM < 0.1", async () => {
    const res = await request(app.httpServer)
      .post("/api/tasks")
      .set("walletpublickey", WALLET)
      .send({ prompt: "do something", maxBudgetXLM: 0.05 });

    expect(res.status).toBe(400);
  });

  it("returns 400 when prompt is missing", async () => {
    const res = await request(app.httpServer)
      .post("/api/tasks")
      .send({ maxBudgetXLM: 1 });

    expect(res.status).toBe(400);
  });
});

describe("GET /api/tasks/:id", () => {
  it("returns 404 for unknown ID", async () => {
    const res = await request(app.httpServer).get(
      "/api/tasks/task_doesnotexist",
    );
    expect(res.status).toBe(404);
  });

  it("returns task for known ID", async () => {
    const create = await request(app.httpServer)
      .post("/api/tasks")
      .set("walletpublickey", WALLET)
      .send({ prompt: "Research AI trends", maxBudgetXLM: 2 });

    const id = create.body.taskId;
    const res = await request(app.httpServer).get(`/api/tasks/${id}`);
    expect(res.status).toBe(200);
    expect(res.body.id).toBe(id);
    expect(Array.isArray(res.body.dag)).toBe(true);
  });
});

describe("GET /api/tasks (pagination)", () => {
  it("returns paginated results", async () => {
    // Create 3 tasks for a fresh wallet
    const wallet =
      "GCEZWKCA5PAGINATE000000000000000000000000000000000000000000";
    for (let i = 0; i < 3; i++) {
      await request(app.httpServer)
        .post("/api/tasks")
        .set("walletpublickey", wallet)
        .send({ prompt: `Task number ${i}`, maxBudgetXLM: 1 });
    }

    const res = await request(app.httpServer)
      .get("/api/tasks?page=1&pageSize=2")
      .set("walletpublickey", wallet);

    expect(res.status).toBe(200);
    expect(res.body.tasks.length).toBe(2);
    expect(res.body.total).toBe(3);
    expect(res.body.page).toBe(1);
    expect(res.body.pageSize).toBe(2);
  });
});

describe("DELETE /api/tasks/:id", () => {
  it("cancels a queued task", async () => {
    const create = await request(app.httpServer)
      .post("/api/tasks")
      .set("walletpublickey", WALLET)
      .send({ prompt: "Cancel me", maxBudgetXLM: 1 });
    const id = create.body.taskId;

    const res = await request(app.httpServer).delete(`/api/tasks/${id}`);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("cancelled");
  });

  it("returns 409 when task is running", async () => {
    const create = await request(app.httpServer)
      .post("/api/tasks")
      .set("walletpublickey", WALLET)
      .send({ prompt: "Running task", maxBudgetXLM: 1 });
    const id = create.body.taskId;

    // Manually set to running via DB
    createTaskDb(inMemoryDb).updateStatus(id, "running");

    const res = await request(app.httpServer).delete(`/api/tasks/${id}`);
    expect(res.status).toBe(409);
  });

  it("returns 404 for unknown task", async () => {
    const res = await request(app.httpServer).delete(
      "/api/tasks/task_unknown999",
    );
    expect(res.status).toBe(404);
  });
});

describe("SQLite persistence", () => {
  it("task survives a simulated restart (same DB instance)", async () => {
    const create = await request(app.httpServer)
      .post("/api/tasks")
      .set("walletpublickey", WALLET)
      .send({ prompt: "Persist me", maxBudgetXLM: 1 });
    const id = create.body.taskId;

    // Simulate restart: read directly from db (same underlying file in real usage)
    const found = createTaskDb(inMemoryDb).findById(id);
    expect(found).toBeDefined();
    expect(found!.id).toBe(id);
  });
});

// ─── Filtering, Sorting & Search Tests ────────────────────────────────────

describe("GET /api/tasks (filtering, sorting, search)", () => {
  const wallet = "GCEZWKCA5FILTERSORT00000000000000000000000000000000000000";

  beforeAll(() => {
    // Clean any existing tasks for this wallet
    inMemoryDb
      .prepare("DELETE FROM tasks WHERE walletPublicKey = ?")
      .run(wallet);

    const db = createTaskDb(inMemoryDb);
    const now = Date.now();

    const seedTasks: Array<{
      id: string;
      prompt: string;
      status: TaskStatus;
      minutesAgo: number;
    }> = [
      {
        id: "task_fs_001",
        prompt: "Solar energy market analysis",
        status: "completed",
        minutesAgo: 1,
      },
      {
        id: "task_fs_002",
        prompt: "Wind energy report",
        status: "queued",
        minutesAgo: 2,
      },
      {
        id: "task_fs_003",
        prompt: "Solar panel installation costs",
        status: "completed",
        minutesAgo: 3,
      },
      {
        id: "task_fs_004",
        prompt: "Battery storage technology",
        status: "failed",
        minutesAgo: 4,
      },
      {
        id: "task_fs_005",
        prompt: "Nuclear energy review",
        status: "cancelled",
        minutesAgo: 5,
      },
      {
        id: "task_fs_006",
        prompt: "Hydroelectric dam assessment",
        status: "running",
        minutesAgo: 6,
      },
      {
        id: "task_fs_007",
        prompt: "Offshore solar feasibility study",
        status: "completed",
        minutesAgo: 7,
      },
    ];

    for (const t of seedTasks) {
      db.insert({
        id: t.id,
        prompt: t.prompt,
        walletPublicKey: wallet,
        status: t.status,
        dag: [],
        createdAt: new Date(now - t.minutesAgo * 60_000).toISOString(),
        updatedAt: new Date().toISOString(),
      });
    }
  });

  // ── Status filter ──────────────────────────────────────────────────────

  it("?status=completed returns only completed tasks", async () => {
    const res = await request(app.httpServer)
      .get("/api/tasks?status=completed")
      .set("walletpublickey", wallet);

    expect(res.status).toBe(200);
    expect(res.body.tasks.length).toBe(3);
    res.body.tasks.forEach((t: { status: string }) => {
      expect(t.status).toBe("completed");
    });
  });

  it("?status=queued returns only queued tasks", async () => {
    const res = await request(app.httpServer)
      .get("/api/tasks?status=queued")
      .set("walletpublickey", wallet);

    expect(res.status).toBe(200);
    expect(res.body.tasks.length).toBe(1);
    expect(res.body.tasks[0].status).toBe("queued");
  });

  it("?status=failed returns only failed tasks", async () => {
    const res = await request(app.httpServer)
      .get("/api/tasks?status=failed")
      .set("walletpublickey", wallet);

    expect(res.status).toBe(200);
    expect(res.body.tasks.length).toBe(1);
    expect(res.body.tasks[0].status).toBe("failed");
  });

  it("?status=running returns only running tasks", async () => {
    const res = await request(app.httpServer)
      .get("/api/tasks?status=running")
      .set("walletpublickey", wallet);

    expect(res.status).toBe(200);
    expect(res.body.tasks.length).toBe(1);
    expect(res.body.tasks[0].status).toBe("running");
  });

  it("?status=cancelled returns only cancelled tasks", async () => {
    const res = await request(app.httpServer)
      .get("/api/tasks?status=cancelled")
      .set("walletpublickey", wallet);

    expect(res.status).toBe(200);
    expect(res.body.tasks.length).toBe(1);
    expect(res.body.tasks[0].status).toBe("cancelled");
  });

  // ── Sort order ─────────────────────────────────────────────────────────

  it("?sort=createdAt:asc returns oldest first", async () => {
    const res = await request(app.httpServer)
      .get("/api/tasks?sort=createdAt:asc")
      .set("walletpublickey", wallet);

    expect(res.status).toBe(200);
    const tasks = res.body.tasks;
    expect(tasks.length).toBeGreaterThanOrEqual(3);
    // Oldest first means created timestamps should be non-decreasing
    for (let i = 1; i < tasks.length; i++) {
      expect(new Date(tasks[i].createdAt).getTime()).toBeGreaterThanOrEqual(
        new Date(tasks[i - 1].createdAt).getTime(),
      );
    }
  });

  it("?sort=createdAt:desc returns newest first (default)", async () => {
    const res = await request(app.httpServer)
      .get("/api/tasks?sort=createdAt:desc")
      .set("walletpublickey", wallet);

    expect(res.status).toBe(200);
    const tasks = res.body.tasks;
    expect(tasks.length).toBeGreaterThanOrEqual(3);
    // Newest first means created timestamps should be non-increasing
    for (let i = 1; i < tasks.length; i++) {
      expect(new Date(tasks[i].createdAt).getTime()).toBeLessThanOrEqual(
        new Date(tasks[i - 1].createdAt).getTime(),
      );
    }
  });

  // ── Search (prompt substring) ──────────────────────────────────────────

  it("?q=solar returns tasks whose prompt contains 'solar' (case-insensitive)", async () => {
    const res = await request(app.httpServer)
      .get("/api/tasks?q=solar")
      .set("walletpublickey", wallet);

    expect(res.status).toBe(200);
    expect(res.body.tasks.length).toBe(3);
    res.body.tasks.forEach((t: { prompt: string }) => {
      expect(t.prompt.toLowerCase()).toContain("solar");
    });
  });

  it("?q=SOLAR with uppercase is also case-insensitive", async () => {
    const res = await request(app.httpServer)
      .get("/api/tasks?q=SOLAR")
      .set("walletpublickey", wallet);

    expect(res.status).toBe(200);
    expect(res.body.tasks.length).toBe(3);
  });

  it("?q=wind returns only wind-related tasks", async () => {
    const res = await request(app.httpServer)
      .get("/api/tasks?q=wind")
      .set("walletpublickey", wallet);

    expect(res.status).toBe(200);
    expect(res.body.tasks.length).toBe(1);
    expect(res.body.tasks[0].prompt.toLowerCase()).toContain("wind");
  });

  it("?q=xyzzy returns zero results for non-matching search", async () => {
    const res = await request(app.httpServer)
      .get("/api/tasks?q=xyzzy")
      .set("walletpublickey", wallet);

    expect(res.status).toBe(200);
    expect(res.body.tasks.length).toBe(0);
    expect(res.body.total).toBe(0);
  });

  // ── Combined params ────────────────────────────────────────────────────

  it("status + q + sort combine correctly", async () => {
    // completed tasks containing "solar", sorted oldest-first
    const res = await request(app.httpServer)
      .get("/api/tasks?status=completed&q=solar&sort=createdAt:asc")
      .set("walletpublickey", wallet);

    expect(res.status).toBe(200);
    const tasks = res.body.tasks;
    expect(tasks.length).toBe(3);
    tasks.forEach((t: { status: string; prompt: string }) => {
      expect(t.status).toBe("completed");
      expect(t.prompt.toLowerCase()).toContain("solar");
    });
    // Oldest first
    for (let i = 1; i < tasks.length; i++) {
      expect(new Date(tasks[i].createdAt).getTime()).toBeGreaterThanOrEqual(
        new Date(tasks[i - 1].createdAt).getTime(),
      );
    }
  });

  it("status + page composition: completed on page 1 with pageSize 2", async () => {
    const res = await request(app.httpServer)
      .get("/api/tasks?status=completed&page=1&pageSize=2")
      .set("walletpublickey", wallet);

    expect(res.status).toBe(200);
    expect(res.body.tasks.length).toBe(2);
    expect(res.body.total).toBe(3);
    res.body.tasks.forEach((t: { status: string }) => {
      expect(t.status).toBe("completed");
    });
  });

  it("q + page composition: solar search on page 2 with pageSize 2", async () => {
    const res = await request(app.httpServer)
      .get("/api/tasks?q=solar&page=2&pageSize=2")
      .set("walletpublickey", wallet);

    expect(res.status).toBe(200);
    // 3 total solar tasks, page 2 with pageSize 2 => 1 result
    expect(res.body.tasks.length).toBe(1);
    expect(res.body.total).toBe(3);
  });
});
