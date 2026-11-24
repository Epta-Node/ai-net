/**
 * Jest global teardown for the backend unit/integration suite.
 *
 * Several modules hold process-wide better-sqlite3 singletons. If they are
 * still open when jest's --forceExit tears down the V8 environment,
 * better-sqlite3 finalizes its statements during env disposal and aborts the
 * process (SIGABRT / exit 134) — even when every test passed. Closing them
 * here finalizes everything cleanly while the environment is still alive.
 */
const { closeTaskDb } = require("../src/db/tasks");
const { closeAgentDb } = require("../src/db/agents");
const { closeDb } = require("../src/db");

module.exports = async function globalTeardown(): Promise<void> {
  closeTaskDb();
  closeAgentDb();
  closeDb();
};
