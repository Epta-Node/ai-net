import crypto from "crypto";
import {
  registerAgent,
  lookupAgent,
  lookupAgentsComposite,
  listAgents,
  clearRegistry,
} from "../src/registry/registry";
import { AgentRecord, Capability } from "../src/types/types";

// ─── Upgrade & Migration Mock Types ──────────────────────────────────────────

export interface ContractVersion {
  version: string;
  wasmHash: string;
  upgradeLedger: number;
  description: string;
  admin: string;
  rollbackDeadline: number;
}

export interface MigrationPlan {
  preMigrationChecks: string[];
  dataTransformations: string[];
  postMigrationValidations: string[];
  estimatedItems: number;
}

export interface AgentRecordV2 extends AgentRecord {
  v2Metadata?: {
    latencyP99Ms: number;
    isVerified: boolean;
    tier: "standard" | "premium" | "enterprise";
  };
}

export class MockUpgradeManager {
  private currentVersion: ContractVersion | null = null;
  private previousVersion: ContractVersion | null = null;
  private pendingProposal: {
    newVersion: string;
    newWasmHash: string;
    description: string;
    migrationPlan: MigrationPlan;
    proposedLedger: number;
    validated: boolean;
  } | null = null;
  private currentLedger = 1000;
  private rollbackWindowLedgers = 34560; // 48h in ledgers

  public initialize(admin: string, initialVersion: string, initialWasmHash: string): void {
    this.currentVersion = {
      version: initialVersion,
      wasmHash: initialWasmHash,
      upgradeLedger: this.currentLedger,
      description: "Initial deployment",
      admin,
      rollbackDeadline: 0,
    };
  }

  public getCurrentVersion(): ContractVersion | null {
    return this.currentVersion;
  }

  public proposeUpgrade(
    admin: string,
    newVersion: string,
    newWasmHash: string,
    description: string,
    migrationPlan: MigrationPlan
  ): boolean {
    if (!this.currentVersion || this.currentVersion.admin !== admin) {
      throw new Error("Unauthorized: only admin can propose upgrade");
    }

    this.pendingProposal = {
      newVersion,
      newWasmHash,
      description,
      migrationPlan,
      proposedLedger: this.currentLedger,
      validated: false,
    };
    return true;
  }

  public validateProposal(): { isValid: boolean; estimatedGas: number } {
    if (!this.pendingProposal) {
      throw new Error("No pending upgrade proposal");
    }
    this.pendingProposal.validated = true;
    const baseGas = 500000;
    const perItem = 10000;
    const estimatedGas = baseGas + this.pendingProposal.migrationPlan.estimatedItems * perItem;
    return { isValid: true, estimatedGas };
  }

  public executeUpgrade(admin: string): ContractVersion {
    if (!this.pendingProposal || !this.pendingProposal.validated) {
      throw new Error("Proposal must be proposed and validated before execution");
    }
    if (!this.currentVersion || this.currentVersion.admin !== admin) {
      throw new Error("Unauthorized: only admin can execute upgrade");
    }

    this.previousVersion = { ...this.currentVersion };
    this.currentVersion = {
      version: this.pendingProposal.newVersion,
      wasmHash: this.pendingProposal.newWasmHash,
      upgradeLedger: this.currentLedger,
      description: this.pendingProposal.description,
      admin: this.currentVersion.admin,
      rollbackDeadline: this.currentLedger + this.rollbackWindowLedgers,
    };

    this.pendingProposal = null;
    return this.currentVersion;
  }

  public canRollback(): boolean {
    if (!this.previousVersion || !this.currentVersion) return false;
    return this.currentLedger <= this.currentVersion.rollbackDeadline;
  }

  public rollbackUpgrade(admin: string): ContractVersion {
    if (!this.currentVersion || this.currentVersion.admin !== admin) {
      throw new Error("Unauthorized: only admin can rollback");
    }
    if (!this.canRollback()) {
      throw new Error("Rollback deadline expired or rollback unavailable");
    }

    this.currentVersion = { ...this.previousVersion! };
    this.previousVersion = null;
    return this.currentVersion;
  }

  public advanceLedger(ledgers: number): void {
    this.currentLedger += ledgers;
  }
}

// ─── Migration Helper ─────────────────────────────────────────────────────────

export function migrateAgentStoreV1toV2(agents: AgentRecord[]): AgentRecordV2[] {
  return agents.map((agent) => ({
    ...agent,
    v2Metadata: {
      latencyP99Ms: 150,
      isVerified: agent.reputationScore >= 80,
      tier: agent.reputationScore >= 90 ? "enterprise" : agent.reputationScore >= 75 ? "premium" : "standard",
    },
  }));
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("Contract Upgrade & Migration Verification Suite (#394)", () => {
  const adminAddress = "GBZXN7PIRZGNMHGA728XZVOG2GUFIDLAZ6AF2I2MD2OCYTAF2K1K4AAA";
  let upgradeManager: MockUpgradeManager;

  beforeEach(() => {
    clearRegistry();
    upgradeManager = new MockUpgradeManager();
  });

  it("Deploys v1 contract with initial version and WASM hash", () => {
    const initialWasmHash = crypto.createHash("sha256").update("wasm_v1_bytecode").digest("hex");
    upgradeManager.initialize(adminAddress, "1.0.0", initialWasmHash);

    const version = upgradeManager.getCurrentVersion();
    expect(version).not.toBeNull();
    expect(version?.version).toBe("1.0.0");
    expect(version?.wasmHash).toBe(initialWasmHash);
    expect(version?.admin).toBe(adminAddress);
  });

  it("Populates v1 state fixtures and performs deterministic lookup", () => {
    const fixtureAgents: AgentRecord[] = [
      {
        id: "agent-research-01",
        capabilities: ["research" as Capability],
        endpoint: "https://agent1.example.com",
        priceXLM: 0.5,
        reputationScore: 95,
      },
      {
        id: "agent-coding-01",
        capabilities: ["coding" as Capability],
        endpoint: "https://agent2.example.com",
        priceXLM: 1.2,
        reputationScore: 88,
      },
      {
        id: "agent-risk-01",
        capabilities: ["risk" as Capability],
        endpoint: "https://agent3.example.com",
        priceXLM: 0.8,
        reputationScore: 91,
      },
    ];

    for (const agent of fixtureAgents) {
      registerAgent(agent);
    }

    const allAgents = listAgents();
    expect(allAgents).toHaveLength(3);

    const lookupRes = lookupAgent("agent-research-01");
    expect(lookupRes).toBeDefined();
    expect(lookupRes?.priceXLM).toBe(0.5);
    expect(lookupRes?.reputationScore).toBe(95);

    const compositeRes = lookupAgentsComposite({ capability: "research" as Capability });
    expect(compositeRes).toHaveLength(1);
    expect(compositeRes[0].agentId).toBe("agent-research-01");
  });

  it("Executes upgrade to v2 with migration hooks and asserts state equivalence", () => {
    // 1. Initial v1 setup
    const v1WasmHash = crypto.createHash("sha256").update("wasm_v1_bytecode").digest("hex");
    const v2WasmHash = crypto.createHash("sha256").update("wasm_v2_bytecode").digest("hex");
    upgradeManager.initialize(adminAddress, "1.0.0", v1WasmHash);

    // 2. Populate fixtures
    const initialAgents: AgentRecord[] = [
      {
        id: "agent-research-01",
        capabilities: ["research" as Capability],
        endpoint: "https://agent1.example.com",
        priceXLM: 0.5,
        reputationScore: 95,
      },
      {
        id: "agent-coding-01",
        capabilities: ["coding" as Capability],
        endpoint: "https://agent2.example.com",
        priceXLM: 1.2,
        reputationScore: 88,
      },
    ];

    for (const a of initialAgents) {
      registerAgent(a);
    }

    // 3. Propose v2 upgrade with migration plan
    const migrationPlan: MigrationPlan = {
      preMigrationChecks: ["validate_storage_keys", "verify_balances"],
      dataTransformations: ["migrate_agent_records_to_v2", "add_v2_metadata"],
      postMigrationValidations: ["verify_record_counts", "verify_composite_index"],
      estimatedItems: 2,
    };

    upgradeManager.proposeUpgrade(
      adminAddress,
      "2.0.0",
      v2W2HashSafe(v2WasmHash),
      "Upgrade to v2.0.0 with enhanced metadata",
      migrationPlan
    );

    // 4. Validate proposal and gas estimation
    const validation = upgradeManager.validateProposal();
    expect(validation.isValid).toBe(true);
    expect(validation.estimatedGas).toBeGreaterThan(500000);

    // 5. Execute upgrade
    const newVersion = upgradeManager.executeUpgrade(adminAddress);
    expect(newVersion.version).toBe("2.0.0");
    expect(newVersion.wasmHash).toBe(v2W2HashSafe(v2WasmHash));

    // 6. Run data migration
    const v1Records = listAgents();
    const v2Records = migrateAgentStoreV1toV2(v1Records);

    // 7. ASSERT STATE EQUIVALENCE: All records preserved with 100% fidelity
    expect(v2Records).toHaveLength(initialAgents.length);
    for (const v1Agent of initialAgents) {
      const v2Agent = v2Records.find((r) => r.id === v1Agent.id);
      expect(v2Agent).toBeDefined();
      expect(v2Agent?.endpoint).toBe(v1Agent.endpoint);
      expect(v2Agent?.priceXLM).toBe(v1Agent.priceXLM);
      expect(v2Agent?.reputationScore).toBe(v1Agent.reputationScore);
      expect(v2Agent?.capabilities).toEqual(v1Agent.capabilities);
      // Verify new v2 metadata initialized
      expect(v2Agent?.v2Metadata).toBeDefined();
      expect(v2Agent?.v2Metadata?.latencyP99Ms).toBe(150);
    }
  });

  it("Supports 48-hour emergency rollback and rejects rollback after deadline", () => {
    const v1WasmHash = crypto.createHash("sha256").update("wasm_v1").digest("hex");
    const v2WasmHash = crypto.createHash("sha256").update("wasm_v2").digest("hex");

    upgradeManager.initialize(adminAddress, "1.0.0", v1WasmHash);

    // Execute upgrade to 2.0.0
    upgradeManager.proposeUpgrade(
      adminAddress,
      "2.0.0",
      v2WasmHash,
      "v2 update",
      {
        preMigrationChecks: [],
        dataTransformations: [],
        postMigrationValidations: [],
        estimatedItems: 0,
      }
    );
    upgradeManager.validateProposal();
    upgradeManager.executeUpgrade(adminAddress);

    expect(upgradeManager.getCurrentVersion()?.version).toBe("2.0.0");
    expect(upgradeManager.canRollback()).toBe(true);

    // Rollback within window
    const reverted = upgradeManager.rollbackUpgrade(adminAddress);
    expect(reverted.version).toBe("1.0.0");
    expect(reverted.wasmHash).toBe(v1WasmHash);
    expect(upgradeManager.canRollback()).toBe(false);

    // Re-upgrade to test deadline expiration
    upgradeManager.proposeUpgrade(
      adminAddress,
      "2.0.0",
      v2WasmHash,
      "v2 retry",
      {
        preMigrationChecks: [],
        dataTransformations: [],
        postMigrationValidations: [],
        estimatedItems: 0,
      }
    );
    upgradeManager.validateProposal();
    upgradeManager.executeUpgrade(adminAddress);

    // Advance ledger beyond 48 hours (34,561 ledgers)
    upgradeManager.advanceLedger(34561);
    expect(upgradeManager.canRollback()).toBe(false);
    expect(() => upgradeManager.rollbackUpgrade(adminAddress)).toThrow(/expired/);
  });
});

function v2W2HashSafe(hash: string): string {
  return hash;
}
