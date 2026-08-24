/**
 * Shared mock factories and test helpers for the ai-net backend test suite.
 *
 * Re-export anything tests need to build consistent fixtures without
 * duplicating setup code across test files.
 */

import Database from "better-sqlite3";
import { createAgentDb, type AgentRecord } from "../db/agents";
import { createTaskDb } from "../db/tasks";
import type { Task } from "../types/task";
import type { VeniceClientLike, AgentType } from "../services/venice/types";

// ─────────────────────────────────────────────────────────────────────────────
//  In-memory SQLite factories
// ─────────────────────────────────────────────────────────────────────────────

/** Creates an in-memory SQLite database with the agents schema pre-applied. */
export function makeAgentRawDb(): Database.Database {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE IF NOT EXISTS agents (
      id               TEXT PRIMARY KEY,
      capabilities     TEXT NOT NULL,
      pricingXLM       REAL NOT NULL,
      endpoint         TEXT NOT NULL,
      stellarPublicKey TEXT NOT NULL,
      reputationScore  REAL NOT NULL DEFAULT 0,
      lastSeenAt       TEXT NOT NULL,
      status           TEXT NOT NULL DEFAULT 'online'
    )
  `);
  return db;
}

/** Creates a TaskDb-backed in-memory SQLite database. */
export function makeTaskRawDb(): Database.Database {
  const db = new Database(":memory:");
  db.exec(`
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
  `);
  return db;
}

/** Returns a fully operational AgentDb backed by an in-memory SQLite. */
export function makeAgentDb() {
  return createAgentDb(makeAgentRawDb());
}

/** Returns a fully operational TaskDb backed by an in-memory SQLite. */
export function makeTestTaskDb() {
  return createTaskDb(makeTaskRawDb());
}

// ─────────────────────────────────────────────────────────────────────────────
//  Fixture factories
// ─────────────────────────────────────────────────────────────────────────────

/** Returns a valid AgentRecord fixture. Merge `overrides` to customise fields. */
export function makeAgentRecord(overrides: Partial<AgentRecord> = {}): AgentRecord {
  return {
    id: "test-agent-1",
    capabilities: ["research"],
    pricingXLM: 1.0,
    endpoint: "http://localhost:3001/health",
    stellarPublicKey: "GTESTSTELLARKEY",
    reputationScore: 0,
    lastSeenAt: new Date().toISOString(),
    status: "online",
    ...overrides,
  };
}

/** Returns a valid Task fixture. Merge `overrides` to customise fields. */
export function makeTaskRecord(overrides: Partial<Task> = {}): Task {
  const now = new Date().toISOString();
  return {
    id: "task_test001",
    prompt: "Test task prompt",
    walletPublicKey: "GWALLETTESTKEY",
    status: "queued",
    dag: [],
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
//  Mock Venice client
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A mock VeniceClientLike that resolves `complete` calls with the provided
 * response string (default: a JSON object with a `result` field).
 */
export function makeMockVeniceClient(
  completeResponse = '{"result":"mock response"}',
  options: { shouldFail?: boolean } = {}
): VeniceClientLike {
  return {
    complete: jest.fn().mockImplementation(async () => {
      if (options.shouldFail) throw new Error("Venice AI unavailable");
      return completeResponse;
    }),
    chat: jest.fn().mockImplementation(async () => {
      if (options.shouldFail) throw new Error("Venice AI unavailable");
      return completeResponse;
    }),
    stream: jest.fn().mockImplementation(async () => {
      if (options.shouldFail) throw new Error("Venice AI unavailable");
    }),
    getModelFor: jest.fn().mockReturnValue("llama-3.3-70b"),
    getCircuitState: jest.fn().mockReturnValue("CLOSED"),
    getFailureCount: jest.fn().mockReturnValue(0),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
//  Mock Dispatch / Payment functions
// ─────────────────────────────────────────────────────────────────────────────

/** Mock dispatch function — resolves immediately with an empty object. */
export const mockDispatch = jest.fn().mockResolvedValue({});

/** Mock payment release function — resolves with 'noop'. */
export const mockReleasePayment = jest.fn().mockResolvedValue("noop");
