/**
 * Jest setupFilesAfterEnv — runs in the test worker after the test framework
 * is installed, before any test suite executes.
 *
 * Registers a synchronous process 'exit' handler to explicitly close all
 * better-sqlite3 database handles. This prevents the native addon from firing
 * its V8 destructor after Jest tears down the isolate, which causes:
 *   Assertion failed: (env) != nullptr  (SIGABRT / exit 134)
 * on Node 24 when fake timers or mocked process.exit interact with the GC.
 */

import { closeAgentDb } from '../src/db/agents';
import { closeTaskDb } from '../src/db/tasks';

// Synchronous exit handler — runs before the V8 isolate is torn down.
process.on('exit', () => {
  try { closeAgentDb(); } catch { /* not opened in this worker */ }
  try { closeTaskDb(); } catch { /* not opened in this worker */ }
});
