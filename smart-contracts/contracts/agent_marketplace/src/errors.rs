//! # Error Types for Agent Marketplace

use soroban_sdk::contracterror;

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum Error {
    NotFound = 1,
    Unauthorized = 2,
    AlreadyExists = 3,
    ContractPaused = 4,
    InvalidPrice = 5,
    InsufficientPayment = 6,
    BookingNotFound = 7,
    BookingAlreadyCompleted = 8,
    BookingAlreadyCancelled = 9,
    // Codes 10 (SlaViolation) and 11 (NotOwner) were never constructed and
    // have been removed. They are reserved and must not be reused.
    ServiceNotAvailable = 12,
    /// No payment asset (Stellar Asset Contract) has been configured.
    AssetNotConfigured = 13,
    /// The supplied asset or its decimals do not match the configured asset.
    AssetMismatch = 14,
    /// An amount is negative or not representable in the asset's decimals.
    InvalidAmount = 15,
    /// The queued action's timelock delay has not elapsed yet.
    TimelockNotElapsed = 16,
    /// No queued admin action exists with the given id.
    ActionNotQueued = 17,
    /// The referenced agent is not registered in the agent registry.
    AgentNotFound = 18,
    /// The referenced agent is frozen by the registry.
    AgentFrozen = 19,
    /// The registry rejected the agent for any other eligibility reason.
    AgentNotEligible = 20,
    /// The agent has been deregistered.
    AgentDeregistered = 21,
    /// The agent's bond is below the registry minimum.
    InsufficientBond = 22,
}

impl Error {
    pub fn from_code(code: u32) -> Option<Self> {
        match code {
            1 => Some(Error::NotFound),
            2 => Some(Error::Unauthorized),
            3 => Some(Error::AlreadyExists),
            4 => Some(Error::ContractPaused),
            5 => Some(Error::InvalidPrice),
            6 => Some(Error::InsufficientPayment),
            7 => Some(Error::BookingNotFound),
            8 => Some(Error::BookingAlreadyCompleted),
            9 => Some(Error::BookingAlreadyCancelled),
            12 => Some(Error::ServiceNotAvailable),
            13 => Some(Error::AssetNotConfigured),
            14 => Some(Error::AssetMismatch),
            15 => Some(Error::InvalidAmount),
            16 => Some(Error::TimelockNotElapsed),
            17 => Some(Error::ActionNotQueued),
            18 => Some(Error::AgentNotFound),
            19 => Some(Error::AgentFrozen),
            20 => Some(Error::AgentNotEligible),
            21 => Some(Error::AgentDeregistered),
            22 => Some(Error::InsufficientBond),
            _ => None,
        }
    }
}
