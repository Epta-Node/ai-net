import { onChainContracts, resetTestDatabase } from "./helpers";

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
