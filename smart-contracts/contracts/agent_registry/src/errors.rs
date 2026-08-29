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
    /// Bridge proof has passed its expiry timestamp.
    BridgeProofExpired = 27,
    /// No bridge proof exists for this agent and target chain.
    BridgeProofNotFound = 28,
    /// Bridge proof does not match the record held by the registry.
    BridgeProofMismatch = 29,
    /// Requested proof lifetime is zero or beyond the permitted maximum.
    InvalidBridgeExpiry = 30,
    /// Audit log pagination arguments are out of range.
    InvalidAuditRange = 31,
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
            27 => Some(Error::BridgeProofExpired),
            28 => Some(Error::BridgeProofNotFound),
            29 => Some(Error::BridgeProofMismatch),
            30 => Some(Error::InvalidBridgeExpiry),
            31 => Some(Error::InvalidAuditRange),
            _ => None,
        }
    }
}
