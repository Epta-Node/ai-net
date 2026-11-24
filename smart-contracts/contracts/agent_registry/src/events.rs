//! # Event Types for Agent Registry
//!
//! This module defines the typed structs that are emitted as Soroban contract
//! events. Each struct corresponds to one event topic and is published via
//! `env.events().publish(topic, data)`.
//!
//! ## Topic convention
//!
//! All events share a two-symbol topic prefix:
//!
//! ```text
//! ("registry", "<action>")
//! ```
//!
//! This lets off-chain indexers filter events by contract + topic[1] without
//! needing to know every possible action in advance.
//!
//! ## Event catalogue
//!
//! | Function            | topic[1]           | Data fields                                              |
//! |---------------------|--------------------|----------------------------------------------------------|
//! | `initialize`        | `initialized`      | `admin`                                                  |
//! | `set_admin`         | `admin_changed`    | `old_admin`, `new_admin`                                 |
//! | `register_agent`    | `agent_registered` | `agent_id`, `owner`, `capability`, `price_stroops`       |
//! | `register_agents`   | `agent_registered` | same — one event per successfully committed agent        |
//! | `deregister_agent`  | `agent_deregistered` | `agent_id`, `owner`, `capability`                      |
//! | `report_error`      | `error_reported`   | `error_id`, `reporter`                                   |
//! | `resolve_errors`    | `error_resolved`   | `error_id`, `resolution` — one event per resolved error  |
//! | `pause`             | `paused`           | `()`                                                     |
//! | `unpause`           | `unpaused`         | `()`                                                     |
//! | `freeze_agent`    | `freeze`           | `agent_id`                                               |
//! | `unfreeze_agent`  | `unfreeze`         | `agent_id`                                               |
//! | `update_pricing`  | `price_upd`        | `(agent_id, new_price)`                                  |
//! | `update_reputation` / `batch_update_reputation` | `rep_upd` | `agent_id`, `score`, `updated_at`            |
//! | `get_reputation` (epochs elapsed) | `rep_dec` | `agent_id`, `old_score`, `new_score`, `epochs` |

use crate::{AnomalyKind, TargetChain};
use soroban_sdk::{contracttype, Address, BytesN, String, Symbol, Vec};

// ─── Legacy structs (kept for ABI compatibility) ──────────────────────────────

/// Emitted by legacy indexers; superseded by the inline tuple events.
#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct AgentRegistered {
    pub agent_id: Symbol,
    pub agent_type: Symbol,
    pub owner: Address,
    pub timestamp: u64,
}

// ─── Upgrade-related events ──────────────────────────────────────────────────

/// Emitted when contract is successfully upgraded
#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct ContractUpgradedEvent {
    pub old_version: String,
    pub new_version: String,
    pub wasm_hash: BytesN<32>,
    pub admin: Address,
    pub upgrade_ledger: u32,
}

/// Emitted when the registry's upgrade-manager address is set.
///
/// topic: `("upgrade", "mgr_set")`
#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct UpgradeManagerSetEvent {
    /// Address of the registry contract the manager was set on.
    pub contract: Address,
    /// Address of the upgrade manager now responsible for this contract.
    pub upgrade_manager: Address,
    /// Admin that performed the change.
    pub admin: Address,
}

/// Emitted after the pre-upgrade hook finishes its validation pass.
///
/// topic: `("upgrade", "pre_hook")`
#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct PreUpgradeHookEvent {
    /// Address of the registry contract being upgraded.
    pub contract: Address,
    /// Version the contract is being upgraded to.
    pub version: String,
    /// Human-readable outcome of each validation performed.
    pub validation_results: Vec<String>,
    /// Whether every validation passed.
    pub success: bool,
}

/// Emitted after the post-upgrade hook finishes migrating data.
///
/// topic: `("upgrade", "post_hook")`
#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct PostUpgradeHookEvent {
    /// Address of the registry contract that was upgraded.
    pub contract: Address,
    /// Version the contract was upgraded from.
    pub old_version: String,
    /// Version the contract was upgraded to.
    pub new_version: String,
    /// Human-readable outcome of each migration step executed.
    pub migration_results: Vec<String>,
    /// Whether every migration step succeeded.
    pub success: bool,
}

/// Emitted when an upgrade is initiated against the upgrade manager.
///
/// topic: `("upgrade", "initiated")`
#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct UpgradeInitiatedEvent {
    /// Address of the registry contract being upgraded.
    pub contract: Address,
    /// Version the contract is being upgraded from.
    pub from_version: String,
    /// Version the contract is being upgraded to.
    pub to_version: String,
    /// WASM hash of the new contract build.
    pub wasm_hash: BytesN<32>,
    /// Admin that initiated the upgrade.
    pub initiator: Address,
}

/// Emitted when contract is rolled back to previous version
#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct ContractRolledBackEvent {
    pub reverted_version: String,
    pub restored_version: String,
    pub admin: Address,
    pub rollback_ledger: u32,
}

/// Emitted by legacy status-change paths; superseded by freeze/unfreeze events.
#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct AgentStatusChanged {
    pub agent_id: Symbol,
    pub old_status: Symbol,
    pub new_status: Symbol,
}

/// Emitted by legacy deregistration paths; superseded by `AgentDeregisteredEvent`.
#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct AgentRemoved {
    pub agent_id: Symbol,
}

// ─── New typed event data structs ────────────────────────────────────────────

/// Data payload for `(registry, initialized)`.
///
/// Published once when the contract is first initialised with an admin address.
/// Indexers should record this to establish the genesis admin and contract
/// activation time.
#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct RegistryInitializedEvent {
    /// The address that was set as the initial admin.
    pub admin: Address,
}

/// Data payload for `(registry, admin_changed)`.
///
/// Published every time `set_admin` succeeds. Indexers can maintain a full
/// audit trail of admin rotations for compliance and security monitoring.
#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct AdminChangedEvent {
    /// The admin address that was replaced.
    pub old_admin: Address,
    /// The new admin address that took effect.
    pub new_admin: Address,
}

/// Data payload for `(registry, agent_registered)`.
///
/// Published by both `register_agent` (single) and `register_agents` (batch,
/// one event per committed agent). Indexers must handle both code paths emitting
/// this same event type.
#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct AgentRegisteredEvent {
    /// Unique on-chain identifier of the newly registered agent.
    pub agent_id: Symbol,
    /// Wallet address of the agent owner who authorised the registration.
    pub owner: Address,
    /// Capability category advertised by this agent (e.g. `research`, `coding`).
    pub capability: Symbol,
    /// Asking price in stroops (1 XLM = 10,000,000 stroops).
    pub price_stroops: i128,
}

/// Data payload for `(registry, agent_deregistered)`.
///
/// Published when an owner removes their agent from the registry. The owner
/// and capability are included so indexers can update capability indexes and
/// ownership maps without a separate read.
#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct AgentDeregisteredEvent {
    /// The agent that was removed.
    pub agent_id: Symbol,
    /// Owner who authorised the deregistration.
    pub owner: Address,
    /// Capability the agent was advertising (helps indexers clean up indexes).
    pub capability: Symbol,
}

/// Data payload for `(registry, error_reported)`.
///
/// Published when a new operational error is submitted via `report_error`.
/// Monitoring systems can subscribe to this event to trigger alerting pipelines
/// without polling the contract state.
#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct ErrorReportedEvent {
    /// 32-byte unique identifier for this error record.
    pub error_id: BytesN<32>,
    /// Address that filed the report (must have provided auth).
    pub reporter: Address,
}

/// Data payload for `(registry, error_resolved)`.
///
/// Published once per resolved error inside `resolve_errors`. Batch resolutions
/// emit multiple events — one per error — so indexers can track each resolution
/// independently without inspecting contract storage.
#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct ErrorResolvedEvent {
    /// The error record that was closed.
    pub error_id: BytesN<32>,
    /// How the error was closed: `Fixed`, `Ignored`, or `Escalated`.
    pub resolution_code: u32,
}

// ─── Attestation event data structs ──────────────────────────────────────────

/// Data payload for `(registry, att_created)`.
///
/// Published when a new capability attestation is successfully created via
/// `attest_capability`. Includes the expiry timestamp so indexers can schedule
/// automatic expiry events without polling.
#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct AttestationCreatedEvent {
    /// The agent this attestation is for.
    pub agent_id: Symbol,
    /// The capability being attested.
    pub capability: Symbol,
    /// Address of the signer who produced the attestation.
    pub signer: Address,
    /// Ledger timestamp when the attestation expires.
    pub expires_at: u64,
}

/// Data payload for `(registry, att_revoked)`.
///
/// Published when an agent owner revokes their own attestation via
/// `revoke_attestation`.
#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct AttestationRevokedEvent {
    /// The agent whose attestation was revoked.
    pub agent_id: Symbol,
    /// The capability that was attested.
    pub capability: Symbol,
}

/// Data payload for `(registry, att_expired)`.
///
/// Published by `verify_attestation` when it detects an expired attestation.
/// Off-chain indexers can subscribe to this to track expiry events.
#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct AttestationExpiredEvent {
    /// The agent whose attestation expired.
    pub agent_id: Symbol,
    /// The capability that was attested.
    pub capability: Symbol,
}

// ─── Bond event data structs ──────────────────────────────────────────────────

/// Data payload for `(registry, bond_locked)`.
///
/// Published by `register_agent` when an agent successfully registers with a
/// bond. Indexers can use this to track the total bonded value per agent and
/// detect under-bonded agents after `set_min_bond` increases the minimum.
#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct BondLocked {
    /// The agent that locked the bond.
    pub agent_id: Symbol,
    /// Owner address that authorised the registration.
    pub owner: Address,
    /// Bond amount locked in stroops.
    pub amount_stroops: i128,
}

/// Data payload for `(registry, bond_slsh)`.
///
/// Published when an admin or verified dispute ruling penalises an agent's bond.
/// Both the penalty applied and the resulting remaining balance are included
/// so indexers don't need to recompute the residual from prior state.
#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct BondSlashed {
    /// The agent whose bond was reduced.
    pub agent_id: Symbol,
    /// The amount deducted from the bond in stroops (capped at the prior balance).
    pub penalty_stroops: i128,
    /// Remaining bond balance after the slash (≥ 0).
    pub remaining_stroops: i128,
    /// Policy or dispute reason supplied by the administrator.
    pub reason: String,
}

/// Data payload for `(registry, bond_dep)`.
#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct BondDeposited {
    pub agent_id: Symbol,
    pub owner: Address,
    pub amount_stroops: i128,
    pub total_stroops: i128,
}

/// Data payload for `(registry, bond_init)`.
#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct BondReturnInitiated {
    pub agent_id: Symbol,
    pub owner: Address,
    pub amount_stroops: i128,
    pub expiry_ledger: u32,
}

/// Data payload for `(registry, bond_clm)`.
#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct BondClaimed {
    pub agent_id: Symbol,
    pub owner: Address,
    pub amount_stroops: i128,
}

/// Data payload for `(registry, bond_rwd)`.
#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct BondRewarded {
    pub agent_id: Symbol,
    pub amount_stroops: i128,
    pub total_stroops: i128,
    pub admin: Address,
}

/// Data payload for `(registry, bond_ret)`.
///
/// Published by the second `deregister_agent` call once the 24-hour cooldown
/// has elapsed and the bond is eligible for return to the owner. Only emitted
/// when `bond_amount > 0`; zero-bond deregistrations skip this event.
#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct BondReturned {
    /// The agent that was deregistered.
    pub agent_id: Symbol,
    /// Address that receives the returned bond.
    pub owner: Address,
    /// Bond amount returned in stroops.
    pub amount_stroops: i128,
}

// ─── Multi-sig Administration Event Data Structs ──────────────────────────────

/// Data payload for `(registry, op_prop)`.
/// Published when a multi-sig proposal is submitted.
#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct OperationProposed {
    pub proposal_id: u64,
    pub proposer: Address,
    pub action: Symbol,
    pub eta: u64,
    pub expires_at: u64,
}

/// Data payload for `(registry, op_appr)`.
/// Published when an admin approves a proposal.
#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct OperationApproved {
    pub proposal_id: u64,
    pub approver: Address,
}

/// Data payload for `(registry, op_exec)`.
/// Published when a proposal is executed after timelock.
#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct OperationExecuted {
    pub proposal_id: u64,
    pub executor: Address,
}

/// Data payload for `(registry, op_canc)`.
/// Published when a proposal is cancelled by its proposer.
#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct OperationCancelled {
    pub proposal_id: u64,
    pub canceller: Address,
}

/// Data payload for `(registry, disc_qry)`.
/// Published when a discovery query is processed by the oracle.
#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct DiscoveryQueryEvent {
    /// Required capability requested in the discovery query.
    pub capability: Symbol,
    /// Maximum acceptable price in stroops.
    pub max_price: i128,
    /// Minimum acceptable reputation score [0, 100].
    pub min_reputation: u32,
    /// Maximum acceptable response time / latency in milliseconds.
    pub max_latency: u32,
    /// Number of matching agents discovered and ranked.
    pub matches_count: u32,
}

// ─── Analytics Event Data Structs ────────────────────────────────────────────

/// Data payload for `(registry, analytics_rec)`.
/// Published when task completion is recorded for an agent.
#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct AnalyticsRecordedEvent {
    /// Agent whose analytics were updated.
    pub agent_id: Symbol,
    /// Whether the task was successful.
    pub success: bool,
    /// Response time for this task in milliseconds.
    pub response_time: u32,
    /// Earnings from this task in stroops.
    pub earnings: i128,
}

/// Data payload for `(registry, lb_upd)`.
/// Published when the leaderboard is updated.
#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct LeaderboardUpdatedEvent {
    /// Metric used for ranking.
    pub metric: Symbol,
    /// Top N agents returned.
    pub top_count: u32,
}

// ─── SLA Event Data Structs ──────────────────────────────────────────────────

/// Data payload for `(registry, sla_set)`.
/// Published when an agent's SLA is configured.
#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct SlaSetEvent {
    /// Agent the SLA was set for.
    pub agent_id: Symbol,
    /// Maximum response time in milliseconds.
    pub max_response_time: u32,
    /// Minimum uptime percentage.
    pub min_uptime: u32,
    /// Minimum quality score.
    pub min_quality_score: u32,
}

/// Data payload for `(registry, sla_viol)`.
/// Published when an SLA violation is detected.
#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct SlaViolationDetectedEvent {
    /// Agent that violated the SLA.
    pub agent_id: Symbol,
    /// Type of violation: 0 = response_time, 1 = uptime, 2 = quality.
    pub violation_type: u32,
    /// Penalty applied (stroops).
    pub penalty_stroops: i128,
}

/// Data payload for `(registry, sla_bonus)`.
/// Published when an agent receives a bonus for exceeding SLA.
#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct SlaBonusAwardedEvent {
    /// Agent that received the bonus.
    pub agent_id: Symbol,
    /// Reputation boost awarded.
    pub reputation_boost: u32,
}

// ─── Cross-chain bridging events (issue #259) ────────────────────────────────

/// Emitted when an agent identity is bridged to another chain.
///
/// topic: `("registry", "bridged")`
#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct IdentityBridgedEvent {
    /// Agent whose identity was bridged.
    pub agent_id: Symbol,
    /// Chain the proof is scoped to.
    pub target_chain: TargetChain,
    /// Digest an off-chain verifier checks the signature against.
    pub digest: BytesN<32>,
    /// Timestamp after which the proof stops being valid.
    pub expiry: u64,
}

/// Emitted on every bridge-proof verification attempt.
///
/// Emitted for failures too, so a target chain repeatedly presenting stale
/// proofs is visible to an indexer.
///
/// topic: `("registry", "brdg_vrfy")`
#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct BridgeProofVerifiedEvent {
    /// Agent the proof refers to.
    pub agent_id: Symbol,
    /// Chain the proof was scoped to.
    pub target_chain: TargetChain,
    /// Whether the proof was accepted.
    pub valid: bool,
}

/// Emitted when a bridge proof is revoked before its expiry.
///
/// topic: `("registry", "brdg_revk")`
#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct BridgeProofRevokedEvent {
    /// Agent whose proof was revoked.
    pub agent_id: Symbol,
    /// Chain the revoked proof was scoped to.
    pub target_chain: TargetChain,
    /// Address that performed the revocation.
    pub revoked_by: Address,
}

// ─── Agent capability versioning events (issue #243) ─────────────────────────

/// Data payload for `(registry, ver_pub)`.
///
/// Published by `register_agent_version` when a new version is successfully
/// stored. Off-chain indexers can maintain a full version history per agent
/// without polling contract storage.
#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct AgentVersionPublishedEvent {
    /// Agent that published the new version.
    pub agent_id: Symbol,
    /// Owner who authorised the version registration.
    pub owner: Address,
    /// The version that was just published.
    pub major: u32,
    pub minor: u32,
    pub patch: u32,
}

/// Data payload for `(registry, ver_sup)`.
///
/// Published by `register_agent_version` for the *previous* latest version
/// once it is superseded. Indexers can use this to mark stale versions in
/// their caches.
#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct AgentVersionSupersededEvent {
    /// Agent whose previous version was superseded.
    pub agent_id: Symbol,
    /// The version that was superseded.
    pub major: u32,
    pub minor: u32,
    pub patch: u32,
}

// ─── Security audit trail events (issue #261) ────────────────────────────────

/// Emitted for every privileged operation recorded in the audit log.
///
/// topic: `("registry", "audit")`
#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct AuditLogEntryEvent {
    /// Sequence number of the entry written.
    pub seq: u64,
    /// Address that authorised the operation.
    pub caller: Address,
    /// Short operation name.
    pub operation: Symbol,
    /// Value moved, in stroops.
    pub amount_stroops: i128,
    /// Whether the operation crossed the high-value threshold.
    pub high_value: bool,
}

// ─── On-chain reputation events (issue #244) ─────────────────────────────────

/// Data payload for `(registry, rep_upd)`.
///
/// Published by `update_reputation` and once per committed item of
/// `batch_update_reputation`. `score` is fixed-point (`1_000_000` == 100%).
#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct ReputationUpdated {
    /// Agent that was scored.
    pub agent_id: Symbol,
    /// New score in fixed-point.
    pub score: u64,
    /// Ledger timestamp the score was written.
    pub updated_at: u64,
}

/// Data payload for `(registry, rep_dec)`.
///
/// Published by `get_reputation` when whole epochs elapsed since
/// `last_updated` and lazy decay was applied on read.
#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct ReputationDecayed {
    /// Agent whose score decayed.
    pub agent_id: Symbol,
    /// Score before decay.
    pub old_score: u64,
    /// Score after decay.
    pub new_score: u64,
    /// Whole epochs elapsed.
    pub epochs: u64,
}

/// Emitted when an operation trips one of the anomaly checks.
///
/// topic: `("registry", "anomaly")`
#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct AnomalyDetectedEvent {
    /// Audit entry the anomaly was detected on.
    pub seq: u64,
    /// Caller responsible for the operation.
    pub caller: Address,
    /// Which check fired.
    pub kind: AnomalyKind,
    /// Observed value: the operation count for a rate anomaly, the amount in
    /// stroops for a high-value one, and zero for a first-seen caller.
    pub observed: i128,
}

// ─── Agent freeze/resume events (issue #486) ─────────────────────────────────

/// Data payload for `("registry", "frz_upd")`.
///
/// Published by `freeze_agent` / `unfreeze_agent` after the frozen flag has
/// been written, so indexers can maintain a full freeze/resume history with
/// the acting admin without reconstructing it from two separate topics.
#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct AgentFrozen {
    /// The agent whose frozen flag changed.
    pub agent_id: Symbol,
    /// `true` after `freeze_agent`, `false` after `unfreeze_agent`.
    pub frozen: bool,
    /// Admin that performed the change.
    pub admin: Address,
    /// Ledger sequence at which the flag was written.
    pub frozen_at_ledger: u64,
}

/// Alias so callers can name the resume half of the pair explicitly.
///
/// topic: `("registry", "frz_upd")` (same payload shape as [`AgentFrozen`]).
pub type AgentResumed = AgentFrozen;

/// Data payload for `("registry", "msig_set")`.
///
/// Published by `set_multisig_config` after the configuration is committed.
#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct MultisigConfigSetEvent {
    /// Addresses that make up the multi-sig admin set.
    pub admins: Vec<Address>,
    /// Number of approvals required to execute a proposal.
    pub threshold: u32,
    /// Timelock delay in seconds applied to proposal execution.
    pub timelock_delay: u64,
}

/// Data payload for `("registry", "minbond")`.
///
/// Published by `set_min_bond` after the new minimum is committed.
#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct MinBondSetEvent {
    /// Admin that performed the change.
    pub admin: Address,
    /// New minimum bond in stroops.
    pub amount_stroops: i128,
}

/// Data payload for `("registry", "errttl")`.
///
/// Published by `set_error_ttl` after the new retention is committed.
#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct ErrorTtlSetEvent {
    /// Admin that performed the change.
    pub admin: Address,
    /// New error retention, in ledger sequences.
    pub ttl_ledgers: u64,
}

/// Data payload for `("registry", "errcln")`.
///
/// Published by `cleanup_expired_errors` when at least one entry was removed.
#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct ErrorsCleanedEvent {
    /// Number of entries removed by this pass.
    pub removed: u32,
}

/// Data payload for `("registry", "gas_cfg")`.
///
/// Published by `set_gas_config` after the new configuration is committed.
#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct GasConfigSetEvent {
    /// Admin that performed the change.
    pub admin: Address,
    /// Fixed per-transaction overhead, in CPU instructions.
    pub tx_overhead: u64,
    /// Cost of a single agent registration.
    pub register_agent: u64,
    /// Cost of a single error resolution.
    pub resolve_error: u64,
}

/// Data payload for `("registry", "store_cfg")`.
///
/// Published by `set_storage_config` after the new limits are committed.
#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct StorageConfigSetEvent {
    /// Admin that performed the change.
    pub admin: Address,
    /// Global agent limit (0 = unlimited).
    pub max_agents: u32,
    /// Per-capability agent limit (0 = unlimited).
    pub max_per_capability: u32,
}

/// Data payload for `("registry", "gcfg_set")`.
///
/// Published by the `SetGasConfig` arm of `execute_operation`.
#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct GasConfigUpdatedEvent {
    /// Proposal that carried the change.
    pub proposal_id: u64,
    /// Fixed per-transaction overhead, in CPU instructions.
    pub tx_overhead: u64,
    /// Cost of a single agent registration.
    pub register_agent: u64,
    /// Cost of a single error resolution.
    pub resolve_error: u64,
}

/// Data payload for `("registry", "msig_upd")`.
///
/// Published by the `SetMultisigConfig` arm of `execute_operation`.
#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct MultisigConfigUpdatedEvent {
    /// Proposal that carried the change.
    pub proposal_id: u64,
    /// Addresses that make up the new multi-sig admin set.
    pub admins: Vec<Address>,
    /// Number of approvals required to execute a proposal.
    pub threshold: u32,
    /// Timelock delay in seconds applied to proposal execution.
    pub timelock_delay: u64,
}

/// Data payload for `(registry, agent_updated)`.
///
/// Published after an agent owner's pricing update succeeds.  The owner and
/// capability are retained so indexers can apply the update without another
/// storage read.
#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct AgentUpdatedEvent {
    pub agent_id: Symbol,
    pub owner: Address,
    pub capability: Symbol,
    pub old_price_stroops: i128,
    pub new_price_stroops: i128,
}
