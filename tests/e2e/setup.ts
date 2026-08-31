import { onChainContracts, resetTestDatabase } from "./helpers";
import { closeAgentDb } from "../../backend/src/db/agents";
import { closeTaskDb } from "../../backend/src/db/tasks";

// Close better-sqlite3 handles before process exit to prevent
// `Assertion failed: (env) != nullptr` SIGABRT on Node 24.
process.on('exit', () => {
  try { closeAgentDb(); } catch { /* not opened */ }
  try { closeTaskDb(); } catch { /* not opened */ }
});

beforeAll(async () => {
  process.env.NODE_ENV = "test";
  process.env.SKIP_STELLAR_ACCOUNT_VERIFY = "true";
  
  // Deploy contracts & seed on-chain state
  onChainContracts.initialize();
  
  // Clean up database tables
  resetTestDatabase();
});

afterEach(async () => {
  // Reset on-chain contracts state after each test suite step if desired
});
