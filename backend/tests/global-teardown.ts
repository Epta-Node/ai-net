/**
 * Jest global teardown for the backend unit/integration suite.
 *
 * Several modules hold process-wide better-sqlite3 singletons. If they are
 * still open when jest's --forceExit tears down the V8 environment,
 * better-sqlite3 finalizes its statements during env disposal and aborts the
 * process (SIGABRT / exit 134) — even when every test passed. Closing them
 * here finalizes everything cleanly while the environment is still alive.
 */
import { closeTaskDb } from "../src/db/tasks";
import { closeAgentDb } from "../src/db/agents";
import { closeDb } from "../src/db";

export default async function globalTeardown(): Promise<void> {
  closeTaskDb();
  closeAgentDb();
  closeDb();
}
