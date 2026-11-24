//! # Governance Error Codes
//!
//! Contract-level errors returned by the Agent Governance contract. Every
//! variant maps to a stable `u32` status code so off-chain callers can branch
//! on the numeric code without coupling to a specific SDK build.
//!
//! The code range used here (`1..=27`) is local to this contract. **Never
//! renumber an existing variant** once the contract is deployed.

use soroban_sdk::contracterror;

/// Errors surfaced by the `agent-governance` contract.
#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum Error {
    /// The referenced proposal, vote, or agent does not exist.
    NotFound = 1,
    /// The caller did not authorize the operation (missing signature).
    Unauthorized = 2,
    /// `initialize` has already been called.
    AlreadyInitialized = 3,
    /// The contract must be initialised before this operation.
    NotInitialized = 4,
    /// The caller is not a registered agent and therefore cannot participate.
    AgentNotRegistered = 5,
    /// The agent is already registered.
    AgentAlreadyRegistered = 6,
    /// Reputation score is outside the accepted `[0, 100]` range.
    InvalidReputation = 7,
    /// Stake amount must be zero or positive.
    InvalidStake = 8,
    /// The proposal is not in the `Active` state, so this operation is invalid.
    ProposalNotActive = 9,
    /// The voting period for this proposal has already ended.
    VotingPeriodEnded = 10,
    /// The voting period is still active; execution is not yet allowed.
    VotingPeriodActive = 11,
    /// This agent has already cast a vote on the proposal.
    AlreadyVoted = 12,
    /// The requested voting period is outside the allowed bounds.
    InvalidVotingPeriod = 13,
    /// The agent (or the electorate) has zero voting power.
    ZeroVotingPower = 14,
    /// The proposal has already been executed or failed (terminal state).
    ProposalFinalized = 15,
    /// Proposal title or description must not be empty.
    EmptyMetadata = 16,
    AgentNotFound = 17,
    AgentFrozen = 18,
    InsufficientBond = 19,
    AgentDeregistered = 20,
    AgentNotEligible = 21,
    /// Proposal creation and voting are paused.
    ContractPaused = 22,
    /// The execution target is missing, unknown, or not a contract.
    InvalidTarget = 23,
    /// Execution calldata exceeds `MAX_CALLDATA_LEN`.
    CalldataTooLarge = 24,
    /// `calldata` does not hash to the pinned `expected_hash`.
    PayloadHashMismatch = 25,
    /// A `ParameterChange` proposal was created before a registry was set.
    RegistryNotSet = 26,
    /// The voter had no voting power at the proposal's snapshot point.
    NoSnapshotPower = 27,
}
