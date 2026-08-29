//! # Error Types for Agent Registry
//!
//! Defines error codes returned by contract functions and helper conversions.

use soroban_sdk::contracterror;

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum Error {
    NotFound = 1,
    Unauthorized = 2,
    AlreadyExists = 3,
    ContractPaused = 4,
    AgentFrozen = 5,
    NotAdmin = 6,
    AlreadyResolved = 7,
    DuplicateInBatch = 8,
    InvalidRecord = 9,
    /// Bond supplied at registration is below the contract minimum.
    InsufficientBond = 10,
    /// Bond return attempted before the 24-hour cooldown has elapsed.
    CooldownNotElapsed = 11,
    /// Specified multi-sig proposal was not found.
    ProposalNotFound = 12,
    /// Proposal execution attempted after expiry timestamp.
    ProposalExpired = 13,
    /// Proposal has already been executed.
    ProposalAlreadyExecuted = 14,
    /// Proposal has already been cancelled.
    ProposalAlreadyCancelled = 15,
    /// Approver has already approved this proposal.
    AlreadyApproved = 16,
    /// Threshold signature requirements not met for execution.
    InsufficientApprovals = 17,
    /// Timelock delay has not elapsed for proposal execution.
    TimelockNotElapsed = 18,
    /// Invalid threshold setting (must be 1 <= threshold <= signers.len()).
    InvalidThreshold = 19,
    /// Signer is not an authorized multi-sig admin.
    InvalidSigner = 20,
    /// Storage limit reached for total agents.
    StorageLimitReached = 21,
    /// Storage limit reached for capability index.
    CapabilityLimitReached = 22,
    /// SLA already set for this agent.
    SlaAlreadyExists = 23,
    /// SLA not found for this agent.
    SlaNotFound = 24,
    /// Agent is in violation of its SLA.
    SlaViolation = 25,
    /// Invalid SLA parameters.
    InvalidSla = 26,
    /// Referenced subscription does not exist.
    SubscriptionNotFound = 27,
    /// An active subscription already exists for this (client, agent) pair.
    SubscriptionAlreadyExists = 28,
    /// The subscription term has expired.
    SubscriptionExpired = 29,
    /// The subscription is still within its paid term.
    SubscriptionActive = 30,
    /// Subscription parameters are invalid (non-positive amount or zero period).
    InvalidSubscription = 31,
    /// The subscription has already been cancelled.
    SubscriptionAlreadyCancelled = 32,
}

impl Error {
    /// Recover typed variant from raw error code.
    pub fn from_code(code: u32) -> Option<Self> {
        match code {
            1 => Some(Error::NotFound),
            2 => Some(Error::Unauthorized),
            3 => Some(Error::AlreadyExists),
            4 => Some(Error::ContractPaused),
            5 => Some(Error::AgentFrozen),
            6 => Some(Error::NotAdmin),
            7 => Some(Error::AlreadyResolved),
            8 => Some(Error::DuplicateInBatch),
            9 => Some(Error::InvalidRecord),
            10 => Some(Error::InsufficientBond),
            11 => Some(Error::CooldownNotElapsed),
            12 => Some(Error::ProposalNotFound),
            13 => Some(Error::ProposalExpired),
            14 => Some(Error::ProposalAlreadyExecuted),
            15 => Some(Error::ProposalAlreadyCancelled),
            16 => Some(Error::AlreadyApproved),
            17 => Some(Error::InsufficientApprovals),
            18 => Some(Error::TimelockNotElapsed),
            19 => Some(Error::InvalidThreshold),
            20 => Some(Error::InvalidSigner),
            21 => Some(Error::StorageLimitReached),
            22 => Some(Error::CapabilityLimitReached),
            23 => Some(Error::SlaAlreadyExists),
            24 => Some(Error::SlaNotFound),
            25 => Some(Error::SlaViolation),
            26 => Some(Error::InvalidSla),
            27 => Some(Error::SubscriptionNotFound),
            28 => Some(Error::SubscriptionAlreadyExists),
            29 => Some(Error::SubscriptionExpired),
            30 => Some(Error::SubscriptionActive),
            31 => Some(Error::InvalidSubscription),
            32 => Some(Error::SubscriptionAlreadyCancelled),
            _ => None,
        }
    }
}
