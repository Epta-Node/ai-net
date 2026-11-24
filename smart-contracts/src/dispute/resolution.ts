/**
 * TypeScript SDK wrapper for the multi-phase Soroban dispute contract.
 * Final escrow settlement is emitted after the appeal window closes, while
 * verified bond slashes are applied directly to the configured agent registry.
 */

/** Thin wrapper around an assembled Soroban transaction. */
export interface AssembledTransaction<T> {
  signAndSend(): Promise<T>;
  simulate(): Promise<T>;
}

export const EVIDENCE_PHASE_SECS = 48 * 60 * 60;
export const VOTING_PHASE_SECS = 72 * 60 * 60;
export const APPEAL_PHASE_SECS = 24 * 60 * 60;
export const MINIMUM_VOTES = 3;
export const MAX_VOTERS = 50;
export const MAX_EVIDENCE_PER_DISPUTE = 20;

export enum DisputePhase {
  Filed = 'Filed',
  Evidence = 'EvidencePhase',
  Voting = 'Voting',
  AppealPending = 'AppealPending',
  Resolved = 'Resolved',
}

export type DisputeRuling = 'support_filer' | 'support_agent';
export type DisputeOutcome = DisputeRuling | 'tie';

export interface Evidence {
  disputeId: string;
  evidenceId: number;
  submitter: string;
  evidenceHash: Uint8Array;
  submittedAt: bigint;
}

export interface DisputeVote {
  disputeId: string;
  voter: string;
  ruling: DisputeRuling;
  votedAt: bigint;
}

export interface DisputeInfo {
  taskId: string;
  filer: string;
  agentId: string;
  registryAddress: string;
  registryAgentId: string;
  reason: string;
  status: DisputePhase;
  filedAt: bigint;
  evidenceDeadline: bigint;
  votingDeadline: bigint;
  appealDeadline: bigint | null;
  voters: string[];
  resolution: number | null;
  appealed: boolean;
  filerVotes: number;
  agentVotes: number;
  bondSlashed: bigint;
  filerRefund: bigint;
  agentPayment: bigint;
}

/** Settlement details carried by the on-chain `resolved` event. */
export interface DisputeResolvedEvent {
  disputeId: string;
  outcome: DisputeOutcome;
  filerVotes: number;
  agentVotes: number;
  filerRefund: bigint;
  agentPayment: bigint;
  bondSlashed: bigint;
}

/** Generated-client-shaped interface for the dispute contract. */
export interface DisputeResolutionContractClient {
  initialize(args: { admin: string }): AssembledTransaction<void>;
  set_voters(args: { voters: string[] }): AssembledTransaction<void>;
  set_reputation(args: {
    account: string;
    reputation: number;
  }): AssembledTransaction<void>;
  set_agent_bond(args: {
    agent_id: string;
    bond_amount: bigint;
  }): AssembledTransaction<void>;
  set_agent_registry(args: { registry: string }): AssembledTransaction<void>;
  set_agent_registry_id(args: {
    agent: string;
    registry_agent_id: string;
  }): AssembledTransaction<void>;
  set_task_escrow(args: {
    task_id: string;
    amount: bigint;
  }): AssembledTransaction<void>;
  file_dispute(args: {
    task_id: string;
    filer: string;
    agent_id: string;
    reason: string;
  }): AssembledTransaction<string>;
  submit_evidence(args: {
    dispute_id: string;
    submitter: string;
    evidence_hash: Uint8Array;
  }): AssembledTransaction<number>;
  vote(args: {
    dispute_id: string;
    voter: string;
    ruling: DisputeRuling;
  }): AssembledTransaction<void>;
  resolve(args: { dispute_id: string }): AssembledTransaction<DisputeOutcome>;
  appeal_dispute(args: {
    dispute_id: string;
    appellant: string;
  }): AssembledTransaction<void>;
  finalize_dispute(args: { dispute_id: string }): AssembledTransaction<void>;
  get_dispute(dispute_id: string): AssembledTransaction<DisputeInfo | null>;
  get_evidence_count(dispute_id: string): AssembledTransaction<number>;
  get_evidence(args: {
    dispute_id: string;
    evidence_id: number;
  }): AssembledTransaction<Evidence | null>;
  get_vote(args: {
    dispute_id: string;
    voter: string;
  }): AssembledTransaction<DisputeVote | null>;
}

/** Convenience API using camelCase arguments for application code. */
export class DisputeResolutionSDK {
  constructor(private readonly client: DisputeResolutionContractClient) {}

  async initialize(admin: string): Promise<void> {
    return this.client.initialize({ admin }).signAndSend();
  }

  async configureVoters(voters: string[]): Promise<void> {
    return this.client.set_voters({ voters }).signAndSend();
  }

  async setReputation(account: string, reputation: number): Promise<void> {
    return this.client.set_reputation({ account, reputation }).signAndSend();
  }

  async setAgentBond(agentId: string, bondAmount: bigint): Promise<void> {
    return this.client
      .set_agent_bond({ agent_id: agentId, bond_amount: bondAmount })
      .signAndSend();
  }

  async setAgentRegistry(registry: string): Promise<void> {
    return this.client.set_agent_registry({ registry }).signAndSend();
  }

  async setAgentRegistryId(agent: string, registryAgentId: string): Promise<void> {
    return this.client
      .set_agent_registry_id({ agent, registry_agent_id: registryAgentId })
      .signAndSend();
  }

  async setTaskEscrow(taskId: string, amount: bigint): Promise<void> {
    return this.client
      .set_task_escrow({ task_id: taskId, amount })
      .signAndSend();
  }

  async fileDispute(args: {
    taskId: string;
    filer: string;
    agentId: string;
    reason: string;
  }): Promise<string> {
    return this.client
      .file_dispute({
        task_id: args.taskId,
        filer: args.filer,
        agent_id: args.agentId,
        reason: args.reason,
      })
      .signAndSend();
  }

  async submitEvidence(args: {
    disputeId: string;
    submitter: string;
    evidenceHash: Uint8Array;
  }): Promise<number> {
    return this.client
      .submit_evidence({
        dispute_id: args.disputeId,
        submitter: args.submitter,
        evidence_hash: args.evidenceHash,
      })
      .signAndSend();
  }

  async vote(args: {
    disputeId: string;
    voter: string;
    ruling: DisputeRuling;
  }): Promise<void> {
    return this.client
      .vote({
        dispute_id: args.disputeId,
        voter: args.voter,
        ruling: args.ruling,
      })
      .signAndSend();
  }

  async appealDispute(disputeId: string, appellant: string): Promise<void> {
    return this.client
      .appeal_dispute({ dispute_id: disputeId, appellant })
      .signAndSend();
  }

  async finalizeDispute(disputeId: string): Promise<void> {
    return this.client.finalize_dispute({ dispute_id: disputeId }).signAndSend();
  }

  /** Records a provisional outcome once a voting round has ended. */
  async resolve(disputeId: string): Promise<DisputeOutcome> {
    return this.client.resolve({ dispute_id: disputeId }).signAndSend();
  }

  async getDispute(disputeId: string): Promise<DisputeInfo | null> {
    return this.client.get_dispute(disputeId).simulate();
  }

  async getEvidenceCount(disputeId: string): Promise<number> {
    return this.client.get_evidence_count(disputeId).simulate();
  }

  async getEvidence(args: {
    disputeId: string;
    evidenceId: number;
  }): Promise<Evidence | null> {
    return this.client
      .get_evidence({ dispute_id: args.disputeId, evidence_id: args.evidenceId })
      .simulate();
  }

  async getVote(args: {
    disputeId: string;
    voter: string;
  }): Promise<DisputeVote | null> {
    return this.client
      .get_vote({ dispute_id: args.disputeId, voter: args.voter })
      .simulate();
  }
}
