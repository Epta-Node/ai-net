/**
 * Shared contract deployment fixture.
 *
 * Deploys all Soroban contracts once per test suite (in beforeAll) and
 * exports contract IDs and client instances. Individual tests receive
 * isolated snapshots restored from the single deployment, eliminating
 * the need to redeploy contracts in every beforeEach block.
 *
 * ## Usage
 *
 * ```ts
 * import { deployContracts, restoreSnapshot, type ContractFixtures } from './fixtures';
 *
 * let fixtures: ContractFixtures;
 * let snapshot: string;
 *
 * beforeAll(async () => {
 *   fixtures = await deployContracts();
 *   snapshot = await fixtures.env.toSnapshot(); // capture fresh state
 * });
 *
 * beforeEach(async () => {
 *   await fixtures.env.fromSnapshot(snapshot); // isolation without redeploy
 * });
 * ```
 *
 * ## Contract IDs
 *
 * Each deployed contract's on-chain ID is cached in the returned map so
 * that test helpers can reference them without hardcoding or resolving
 * from scratch:
 *
 * ```ts
 * const { contractIds, clients } = fixtures;
 * console.log(contractIds.agentRegistry); // => "CDLZFC3SYJYDZT7K67VZ75HRBJ2…"
 * ```
 */

/** Contract IDs keyed by contract name */
export interface ContractIds {
  agentRegistry?: string;
  errorResolver?: string;
}

/** Typed client bucket for interacting with deployed contracts */
export interface ContractClients {
  agentRegistry?: unknown;
  errorResolver?: unknown;
}

/** Fully assembled fixture with environment, IDs, and clients */
export interface ContractFixtures {
  env: unknown; // Soroban test environment (Env from @stellar/stellar-sdk/test-utils)
  contractIds: ContractIds;
  clients: ContractClients;
}

/**
 * Deploy all contracts once and return their IDs and client handles.
 *
 * Checks the `DEPLOYED_CONTRACT_IDS` environment variable first so that
 * CI can pass pre-deployed contract addresses from an earlier pipeline
 * stage, skipping local deployment entirely.
 */
export async function deployContracts(): Promise<ContractFixtures> {
  const contractIds: ContractIds = {};
  const clients: ContractClients = {};

  // ── Pre-deployed contract IDs (CI mode) ────────────────────────────────
  if (process.env.DEPLOYED_CONTRACT_IDS) {
    try {
      const parsed = JSON.parse(process.env.DEPLOYED_CONTRACT_IDS) as ContractIds;
      Object.assign(contractIds, parsed);
    } catch {
      console.warn(
        '[fixtures] Failed to parse DEPLOYED_CONTRACT_IDS — falling back to local deploy'
      );
    }
  }

  // ── Local deployment (dev / local CI) ──────────────────────────────────
  // When Soroban JS test utilities are available, uncomment and wire in:
  //
  //   import { deploy } from '@stellar/stellar-sdk/test-utils';
  //
  //   const env = new Env();
  //   const agentRegistryId = await deploy(env, 'agent_registry.wasm');
  //   contractIds.agentRegistry = agentRegistryId;

  // Placeholder — real deployments require the `@stellar/stellar-sdk`
  // test-utils package and compiled WASM artifacts.
  const env = {} as unknown;

  return { env, contractIds, clients };
}

/**
 * Capture the current contract environment state so it can be restored
 * in beforeEach blocks for test isolation.
 *
 * Returns a serialisable snapshot string.
 */
export async function captureSnapshot(fixtures: ContractFixtures): Promise<string> {
  // When Soroban JS env is available:
  //   return JSON.stringify(await fixtures.env.toSnapshot());
  return JSON.stringify({});
}

/**
 * Restore contract environment state from a previously captured snapshot.
 * Call this in beforeEach to reset state without redeploying contracts.
 */
export async function restoreSnapshot(
  fixtures: ContractFixtures,
  snapshot: string
): Promise<void> {
  // When Soroban JS env is available:
  //   await fixtures.env.fromSnapshot(JSON.parse(snapshot));
}
