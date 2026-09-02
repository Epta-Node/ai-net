//! # Governance Error Codes
//!
//! Contract-level errors returned by the Agent Governance contract. Every
//! variant maps to a stable `u32` status code so off-chain callers can branch
//! on the numeric code without coupling to a specific SDK build.
//!
//! The code range used here (`1..=16`) is local to this contract. **Never
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
}
