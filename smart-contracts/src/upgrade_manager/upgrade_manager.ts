/**
 * TypeScript SDK wrapper for the Upgrade Manager Soroban contract.
 *
 * Provides a typed client interface for safe contract upgrade functionality
 * with version tracking, data migration hooks, and rollback capabilities.
 *
 * Upgrade flow:
 *  1. `proposeUpgrade`  – admin proposes a new WASM hash with validation
 *  2. `executeUpgrade`  – admin executes the upgrade (post-proposal)
 *  3. `rollbackUpgrade` – admin reverts to the previous version within 48h
 *
 * Additional utilities:
 *  - `getVersionHistory`    – list all stored contract versions
 *  - `getCurrentVersion`    – read the active version metadata
 *  - `estimateMigrationGas` – estimate gas for a proposed migration
 *
 * Mirrors the Rust contract interface in contracts/upgrade-manager/src/lib.rs.
 *
 * Issue #490 — TypeScript SDK wrappers for all Soroban contracts
 */

// ---------------------------------------------------------------------------
// Shared transaction wrapper (mirrors coordinator.ts pattern)
// ---------------------------------------------------------------------------

/** Thin wrapper around an assembled Soroban transaction. */
export interface AssembledTransaction<T> {
  signAndSend(): Promise<T>;
  simulate(): Promise<T>;
}

// ---------------------------------------------------------------------------
// Domain types
// ---------------------------------------------------------------------------

/** Rollback window: 48 hours in seconds */
export const ROLLBACK_WINDOW_SECS = 172_800;

export interface VersionMetadata {
  /** Semantic version string, e.g. "1.2.3" */
  version: string;
  /** SHA-256 hash of the WASM blob */
  wasmHash: Uint8Array;
  /** Ledger timestamp of the upgrade */
  upgradedAt: bigint;
  /** Human-readable change description */
  description: string;
  /** Address that performed the upgrade */
  upgradedBy: string;
}

export interface UpgradeProposal {
  proposalId: string;
  newWasmHash: Uint8Array;
  targetVersion: string;
  description: string;
  proposedAt: bigint;
  proposedBy: string;
  isExecuted: boolean;
}

export interface MigrationGasEstimate {
  proposalId: string;
  estimatedGas: bigint;
  estimatedFeeStroops: bigint;
}

// ---------------------------------------------------------------------------
// Contract client interface
// ---------------------------------------------------------------------------

export interface UpgradeManagerContractClient {
  initialize(args: {
    admin: string;
    initial_version: string;
    initial_wasm_hash: Uint8Array;
  }): AssembledTransaction<void>;

  propose_upgrade(args: {
    admin: string;
    new_wasm_hash: Uint8Array;
    target_version: string;
    description: string;
  }): AssembledTransaction<string>;

  execute_upgrade(args: {
    admin: string;
    proposal_id: string;
  }): AssembledTransaction<void>;

  rollback_upgrade(args: {
    admin: string;
  }): AssembledTransaction<void>;

  get_current_version(): AssembledTransaction<VersionMetadata>;

  get_version_history(): AssembledTransaction<VersionMetadata[]>;

  get_proposal(proposal_id: string): AssembledTransaction<UpgradeProposal>;

  estimate_migration_gas(args: {
    proposal_id: string;
  }): AssembledTransaction<MigrationGasEstimate>;

  set_admin(args: {
    current_admin: string;
    new_admin: string;
  }): AssembledTransaction<void>;
}

// ---------------------------------------------------------------------------
// High-level SDK wrapper class
// ---------------------------------------------------------------------------

/**
 * UpgradeManagerSDK — high-level wrapper around the UpgradeManager Soroban contract.
 *
 * @example
 * ```ts
 * const sdk = new UpgradeManagerSDK(client);
 *
 * const proposalId = await sdk.proposeUpgrade({
 *   admin: 'GADMIN...',
 *   newWasmHash: newHash,
 *   targetVersion: '2.0.0',
 *   description: 'Add oracle price stamping to task_store',
 * });
 *
 * const gas = await sdk.estimateMigrationGas(proposalId);
 * console.log(`Estimated fee: ${gas.estimatedFeeStroops} stroops`);
 *
 * await sdk.executeUpgrade({ admin: 'GADMIN...', proposalId });
 * ```
 */
export class UpgradeManagerSDK {
  constructor(private readonly client: UpgradeManagerContractClient) {}

  /**
   * Initialise the upgrade manager with the admin and initial version metadata.
   */
  async initialize(args: {
    admin: string;
    initialVersion: string;
    initialWasmHash: Uint8Array;
  }): Promise<void> {
    return this.client
      .initialize({
        admin: args.admin,
        initial_version: args.initialVersion,
        initial_wasm_hash: args.initialWasmHash,
      })
      .signAndSend();
  }

  /**
   * Propose a new contract upgrade. Returns the generated proposal ID.
   */
  async proposeUpgrade(args: {
    admin: string;
    newWasmHash: Uint8Array;
    targetVersion: string;
    description: string;
  }): Promise<string> {
    return this.client
      .propose_upgrade({
        admin: args.admin,
        new_wasm_hash: args.newWasmHash,
        target_version: args.targetVersion,
        description: args.description,
      })
      .signAndSend();
  }

  /**
   * Execute a previously proposed upgrade.
   */
  async executeUpgrade(args: {
    admin: string;
    proposalId: string;
  }): Promise<void> {
    return this.client
      .execute_upgrade({ admin: args.admin, proposal_id: args.proposalId })
      .signAndSend();
  }

  /**
   * Roll back to the previous contract version.
   * Must be called within 48 hours of the last upgrade.
   */
  async rollbackUpgrade(admin: string): Promise<void> {
    return this.client.rollback_upgrade({ admin }).signAndSend();
  }

  /**
   * Fetch the currently active version metadata (read-only).
   */
  async getCurrentVersion(): Promise<VersionMetadata> {
    return this.client.get_current_version().simulate();
  }

  /**
   * Fetch the full version history (read-only).
   */
  async getVersionHistory(): Promise<VersionMetadata[]> {
    return this.client.get_version_history().simulate();
  }

  /**
   * Fetch a specific upgrade proposal (read-only).
   */
  async getProposal(proposalId: string): Promise<UpgradeProposal> {
    return this.client.get_proposal(proposalId).simulate();
  }

  /**
   * Estimate migration gas for a proposal (read-only simulation).
   */
  async estimateMigrationGas(proposalId: string): Promise<MigrationGasEstimate> {
    return this.client.estimate_migration_gas({ proposal_id: proposalId }).simulate();
  }

  /**
   * Transfer admin rights to a new address.
   */
  async setAdmin(args: {
    currentAdmin: string;
    newAdmin: string;
  }): Promise<void> {
    return this.client
      .set_admin({ current_admin: args.currentAdmin, new_admin: args.newAdmin })
      .signAndSend();
  }
}
