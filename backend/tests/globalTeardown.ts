/**
 * Jest global teardown — runs once after all test suites complete.
 *
 * Explicitly closes all SQLite database connections before the Node.js process
 * exits. Without this, `better-sqlite3` triggers a SIGABRT / exit-134 crash
 * on Node 24 when the garbage collector finalises native Database handles
 * after Jest has already started tearing down the V8 isolate.
 *
 * This file is referenced by `globalTeardown` in jest.config.js.
 */

import { closeAgentDb } from '../src/db/agents';
import { closeTaskDb } from '../src/db/tasks';

export default async function globalTeardown(): Promise<void> {
  try {
    closeAgentDb();
  } catch {
    // Ignore — DB may never have been opened in this worker
  }

  try {
    closeTaskDb();
  } catch {
    // Ignore — DB may never have been opened in this worker
  }
}
