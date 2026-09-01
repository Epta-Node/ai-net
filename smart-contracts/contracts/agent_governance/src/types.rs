//! # Governance and Vote Types
//!
//! Core data structures for the Agent Governance contract: agent stake records,
//! governance proposals, individual vote records, storage keys, and every event
//! payload emitted during the proposal lifecycle.
//!
//! ## Proposal Lifecycle
//!
//! ```text
//! create_proposal  →  vote_on_proposal (For | Against | Abstain)  →  execute_proposal
//!       ↓                                                                 ↓
//!    [Active] ──────────────────────────────────────────────→  [Executed] | [Failed]
//! ```
//!
//! ## Voting Power
//!
//! An agent's voting power is weighted by **both** its reputation score and its
//! staked amount:
//!
//! ```text
//! voting_power = stake + reputation * REPUTATION_POWER_UNIT
//! ```
//!
//! The electorate's total voting power is snapshotted into each proposal at
//! creation time, so quorum is measured against a stable denominator.
//!
//! ## Passing Rules
//!
//! * **Quorum** — the power of all cast votes (For + Against + Abstain) must be
//!   at least [`QUORUM_BPS`] (30 %) of the snapshotted total voting power.
//! * **Majority** — For votes must be strictly more than [`MAJORITY_BPS`]
//!   (50 %) of the *decisive* votes (For + Against; abstentions excluded).
//!
//! ## Event Catalogue
//!
//! | Function            | topic[1]     | Data                    |
//! |--------------------|---------------|-------------------------|
//! | `create_proposal`  | `created`     | `ProposalCreatedEvent`  |
//! | `vote_on_proposal` | `vote_cast`   | `VoteCastEvent`         |
//! | `execute_proposal` | `executed`    | `ProposalExecutedEvent` |
//! | `execute_proposal` | `failed`      | `ProposalFailedEvent`   |

use soroban_sdk::{contracttype, Address, String};

// ─── Constants ───────────────────────────────────────────────────────────────

/// Default voting period in ledger-seconds (7 days).
pub const DEFAULT_VOTING_PERIOD_SECS: u64 = 604_800;

/// Minimum configurable voting period (1 hour) — guards against instant votes.
pub const MIN_VOTING_PERIOD_SECS: u64 = 3_600;

/// Maximum configurable voting period (30 days).
pub const MAX_VOTING_PERIOD_SECS: u64 = 2_592_000;

/// Maximum allowed reputation score (percentage scale).
pub const MAX_REPUTATION: u32 = 100;

/// Basis-point denominator (100 % == 10_000 bps).
pub const BPS_DENOMINATOR: i128 = 10_000;

/// Quorum requirement: at least 30 % of total voting power must vote.
pub const QUORUM_BPS: i128 = 3_000;

/// Majority requirement: strictly more than 50 % of decisive votes.
pub const MAJORITY_BPS: i128 = 5_000;

/// Voting-power contribution of a single reputation point, expressed in the
/// same unit as `stake` (stroops). One reputation point == 0.1 XLM of weight.
pub const REPUTATION_POWER_UNIT: i128 = 1_000_000;

/// Compute an agent's voting power from its stake and reputation score.
pub fn voting_power(stake: i128, reputation: u32) -> i128 {
    stake.saturating_add((reputation as i128).saturating_mul(REPUTATION_POWER_UNIT))
}

// ─── Agent stake records ─────────────────────────────────────────────────────

/// On-chain record for a registered agent stakeholder.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AgentInfo {
    /// The agent's address.
    pub agent: Address,
    /// Reputation score in `[0, 100]`.
    pub reputation: u32,
    /// Staked amount in stroops.
    pub stake: i128,
    /// Derived voting power (`voting_power(stake, reputation)`), cached.
    pub power: i128,
}

// ─── Proposals ───────────────────────────────────────────────────────────────

/// Category of a governance proposal.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
#[repr(u32)]
pub enum ProposalType {
    /// A change to a tunable protocol parameter.
    ParameterChange = 0,
    /// A dispute between agents to be adjudicated by the electorate.
    AgentDispute = 1,
    /// An upgrade to protocol contract code / logic.
    ProtocolUpgrade = 2,
}

/// Lifecycle state of a proposal.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
#[repr(u32)]
pub enum ProposalStatus {
    /// Voting is open.
    Active = 0,
    /// Voting closed, quorum + majority met — the proposal passed.
    Executed = 1,
    /// Voting closed, quorum or majority not met — the proposal failed.
    Failed = 2,
}

/// The three vote options.
#[contracttype]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
#[repr(u32)]
pub enum VoteChoice {
    For = 0,
    Against = 1,
    Abstain = 2,
}

/// On-chain governance proposal record.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Proposal {
    /// Monotonic proposal identifier (starts at 1).
    pub id: u64,
    /// Address that created the proposal (a registered agent).
    pub proposer: Address,
    /// Proposal category.
    pub proposal_type: ProposalType,
    /// Short human-readable title.
    pub title: String,
    /// Free-form description / rationale.
    pub description: String,
    /// Ledger timestamp when the proposal was created.
    pub created_at: u64,
    /// Ledger timestamp after which voting is closed.
    pub voting_ends_at: u64,
    /// Current lifecycle state.
    pub status: ProposalStatus,
    /// Accumulated voting power that voted `For`.
    pub for_power: i128,
    /// Accumulated voting power that voted `Against`.
    pub against_power: i128,
    /// Accumulated voting power that voted `Abstain`.
    pub abstain_power: i128,
    /// Total electorate voting power at creation time (quorum denominator).
    pub total_power_snapshot: i128,
}

/// A single agent's vote on a proposal.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct VoteRecord {
    pub proposal_id: u64,
    pub voter: Address,
    pub choice: VoteChoice,
    /// Voting power applied to this vote (snapshotted at vote time).
    pub weight: i128,
}

// ─── Storage keys ────────────────────────────────────────────────────────────

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum DataKey {
    /// The governance admin address.
    Admin,
    /// Aggregate voting power of every registered agent.
    TotalPower,
    /// Monotonic proposal counter.
    ProposalCount,
    /// [`AgentInfo`] for a given agent address.
    Agent(Address),
    /// [`Proposal`] record by id.
    Proposal(u64),
    /// [`VoteRecord`] for a given (proposal, voter) pair.
    Vote(u64, Address),
}

// ─── Event payloads ──────────────────────────────────────────────────────────

/// Emitted when `create_proposal` records a new proposal.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ProposalCreatedEvent {
    pub id: u64,
    pub proposer: Address,
    pub proposal_type: ProposalType,
    pub voting_ends_at: u64,
    pub total_power_snapshot: i128,
}

/// Emitted when `vote_on_proposal` records a vote.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct VoteCastEvent {
    pub proposal_id: u64,
    pub voter: Address,
    pub choice: VoteChoice,
    pub weight: i128,
}

/// Emitted when `execute_proposal` finalises a proposal that passed.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ProposalExecutedEvent {
    pub id: u64,
    pub for_power: i128,
    pub against_power: i128,
    pub abstain_power: i128,
}

/// Emitted when `execute_proposal` finalises a proposal that failed.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ProposalFailedEvent {
    pub id: u64,
    /// Whether the quorum threshold was met.
    pub quorum_met: bool,
    /// Whether the majority threshold was met.
    pub majority_met: bool,
    pub for_power: i128,
    pub against_power: i128,
    pub abstain_power: i128,
}
