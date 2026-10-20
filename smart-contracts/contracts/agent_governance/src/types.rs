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
//! ### Snapshot point
//!
//! Both sides of the quorum check are measured at a single, documented point:
//! **the ledger timestamp at which the proposal was created**
//! (`Proposal::created_at`).
//!
//! * The quorum denominator (`total_power_snapshot`) is the electorate's
//!   aggregate power at that timestamp.
//! * Each vote's weight is the voter's power **as of that same timestamp**,
//!   read from a bounded per-agent checkpoint history
//!   ([`PowerCheckpoint`]). Raising reputation or stake after the proposal was
//!   created therefore cannot inflate a vote on it. Agents registered after
//!   the snapshot have zero weight on that proposal.
//!
//! Power changes recorded in the same ledger timestamp as proposal creation
//! are treated as having happened at the snapshot point.
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
//! | `pause`            | `paused`      | `Address` (admin)       |
//! | `unpause`          | `unpaused`    | `Address` (admin)       |
//! | `set_admin`        | `admin_set`   | `(old, new)`            |
//! | `remove_agent`     | `agent_rm`    | `(agent, power)`        |
//!
//! ## Execution Payload
//!
//! `ParameterChange` and `ProtocolUpgrade` proposals carry an executable
//! payload: a `target` contract, a `function` name, and bounded `calldata`
//! (at most [`MAX_CALLDATA_LEN`] bytes). On a passing vote,
//! `execute_proposal` invokes `target.function(calldata)` from the governance
//! contract. `ParameterChange` proposals always target the configured
//! parameter registry. `expected_hash` (SHA-256 of `calldata`) is pinned at
//! creation and re-verified at execution to guard against payload drift.

use soroban_sdk::{contracttype, Address, Bytes, BytesN, String, Symbol};

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

/// Maximum byte length of a proposal's execution `calldata`.
pub const MAX_CALLDATA_LEN: u32 = 4_096;

/// Maximum number of power checkpoints retained per agent. Older entries are
/// pruned first; a pruned history yields zero weight for very old snapshots.
pub const MAX_CHECKPOINTS: u32 = 32;

/// Timelock delay: 48 hours before a proposal execution can commence.
pub const PROPOSAL_TIMELOCK_SECS: u64 = 48 * 60 * 60;

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

/// A point-in-time record of an agent's voting power.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PowerCheckpoint {
    /// Ledger timestamp at which this power took effect.
    pub timestamp: u64,
    /// Voting power from `timestamp` onward (0 after removal).
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
    /// Voting closed, quorum + majority met, and the payload (if any) was
    /// invoked successfully.
    Executed = 1,
    /// Voting closed, quorum or majority not met, or the execution payload
    /// invocation failed — the proposal failed.
    Failed = 2,
    /// Passing proposal queued for execution (in timelock).
    Queued = 3,
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

/// Execution payload supplied when creating a proposal.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ExecutionPayload {
    /// Contract to invoke on success. Required for `ProtocolUpgrade`; for
    /// `ParameterChange` it defaults to (and must equal) the parameter
    /// registry; optional for `AgentDispute`.
    pub target: Option<Address>,
    /// Function invoked on `target`; it receives `calldata` as its sole arg.
    pub function: Symbol,
    /// Opaque argument bytes, at most [`MAX_CALLDATA_LEN`].
    pub calldata: Bytes,
    /// Optional SHA-256 of `calldata`; verified at creation if supplied.
    pub expected_hash: Option<BytesN<32>>,
}

/// Queued proposal execution record.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct QueuedProposal {
    /// Proposal ID.
    pub proposal_id: u64,
    /// Timestamp when the proposal passed voting.
    pub passed_at: u64,
    /// Earliest ledger timestamp at which execution is permitted.
    pub can_execute_at: u64,
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
    /// Contract invoked on execution (`None` → signal-only proposal).
    pub target: Option<Address>,
    /// Function invoked on `target`.
    pub function: Symbol,
    /// Bounded argument bytes passed to `function`.
    pub calldata: Bytes,
    /// SHA-256 of `calldata`, pinned at creation and re-checked at execution.
    pub expected_hash: Option<BytesN<32>>,
}

/// A single agent's vote on a proposal.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct VoteRecord {
    pub proposal_id: u64,
    pub voter: Address,
    pub choice: VoteChoice,
    /// Voting power applied to this vote (the voter's power at the
    /// proposal's creation-time snapshot).
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
    /// Agent Registry contract address.
    AgentRegistry,
    /// Whether proposal creation and voting are paused.
    Paused,
    /// Parameter registry contract that `ParameterChange` proposals write to.
    ParamRegistry,
    /// Bounded [`PowerCheckpoint`] history for an agent.
    Checkpoints(Address),
    /// Queued proposal waiting for timelock (by proposal ID).
    QueuedProposal(u64),
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
    /// Whether the vote passed but the payload invocation failed.
    pub execution_failed: bool,
    pub for_power: i128,
    pub against_power: i128,
    pub abstain_power: i128,
}
