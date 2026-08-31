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
//! | `freeze_agent`      | `freeze`           | `agent_id`                                               |
//! | `unfreeze_agent`    | `unfreeze`         | `agent_id`                                               |
//! | `update_pricing`    | `price_upd`        | `(agent_id, new_price)`                                  |

use soroban_sdk::{contracttype, Address, BytesN, String, Symbol};

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
/// Published by `slash_bond` when an admin penalises an agent's bond.
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
