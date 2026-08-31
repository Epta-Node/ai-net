//! # Standardized Cross-Contract Exit Codes
//!
//! Common exit-code registry shared across all ai-net Soroban contracts.
//! Contracts map their local error codes to these common codes for
//! cross-contract error propagation so callers can interpret failures
//! without coupling to a specific contract's internal enum.
//!
//! ## Code ranges
//!
//! * `1..=15` — Reserved **common codes** (defined here).
//! * `100..` — Contract-specific codes (local to each contract).
//!
//! ## Exit-code-to-meaning table
//!
//! | Code | Name                | Meaning                                               |
//! |------|---------------------|-------------------------------------------------------|
//! | 1    | NotFound            | The requested entity does not exist                    |
//! | 2    | Unauthorized        | Caller lacks the required authorization signature      |
//! | 3    | AlreadyExists       | Entity already registered / duplicate creation          |
//! | 4    | ContractPaused      | Contract is paused; all mutations rejected              |
//! | 5    | AgentFrozen         | Agent is frozen; operations on it are rejected          |
//! | 6    | NotAdmin            | Caller is not an admin of the contract                  |
//! | 7    | InvalidRecord       | Input record fails validation                           |
//! | 8    | DuplicateInBatch    | Batch contains duplicate entity IDs                     |
//! | 9    | StorageLimitReached | Global storage capacity has been reached                |
//! | 10   | InvalidArgument     | A required argument is missing or malformed             |
//! | 11   | InternalError       | Unexpected internal error (contract bug)                |
//! | 12   | Expired             | The entity has expired or its TTL has elapsed            |
//! | 13   | InsufficientFunds   | Caller or escrow lacks sufficient balance               |
//! | 14   | RateLimited         | Operation rejected due to rate limiting                 |
//! | 15   | ContractNotLinked   | Cross-contract call target is not configured            |

use soroban_sdk::contracterror;

/// Standardized common exit codes shared across all ai-net contracts.
///
/// Contracts should map their local error variants to these codes when
/// propagating errors cross-contract. Off-chain callers can match on
/// `CommonExitCode` without knowing which contract produced the error.
#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum CommonExitCode {
    /// The requested entity does not exist.
    NotFound = 1,
    /// Caller lacks the required authorization signature.
    Unauthorized = 2,
    /// Entity already registered / duplicate creation.
    AlreadyExists = 3,
    /// Contract is paused; all mutations rejected.
    ContractPaused = 4,
    /// Agent is frozen; operations on it are rejected.
    AgentFrozen = 5,
    /// Caller is not an admin of the contract.
    NotAdmin = 6,
    /// Input record fails validation.
    InvalidRecord = 7,
    /// Batch contains duplicate entity IDs.
    DuplicateInBatch = 8,
    /// Global storage capacity has been reached.
    StorageLimitReached = 9,
    /// A required argument is missing or malformed.
    InvalidArgument = 10,
    /// Unexpected internal error (contract bug).
    InternalError = 11,
    /// The entity has expired or its TTL has elapsed.
    Expired = 12,
    /// Caller or escrow lacks sufficient balance.
    InsufficientFunds = 13,
    /// Operation rejected due to rate limiting.
    RateLimited = 14,
    /// Cross-contract call target is not configured.
    ContractNotLinked = 15,
}

impl CommonExitCode {
    /// Convert a raw `u32` status code to a [`CommonExitCode`].
    ///
    /// Returns `None` when the code is outside the reserved range or is
    /// not a recognized common code (i.e. it is contract-specific).
    pub fn from_raw(code: u32) -> Option<Self> {
        match code {
            1 => Some(Self::NotFound),
            2 => Some(Self::Unauthorized),
            3 => Some(Self::AlreadyExists),
            4 => Some(Self::ContractPaused),
            5 => Some(Self::AgentFrozen),
            6 => Some(Self::NotAdmin),
            7 => Some(Self::InvalidRecord),
            8 => Some(Self::DuplicateInBatch),
            9 => Some(Self::StorageLimitReached),
            10 => Some(Self::InvalidArgument),
            11 => Some(Self::InternalError),
            12 => Some(Self::Expired),
            13 => Some(Self::InsufficientFunds),
            14 => Some(Self::RateLimited),
            15 => Some(Self::ContractNotLinked),
            _ => None,
        }
    }

    /// Human-readable label for the exit code.
    pub fn label(&self) -> &'static str {
        match self {
            Self::NotFound => "NotFound",
            Self::Unauthorized => "Unauthorized",
            Self::AlreadyExists => "AlreadyExists",
            Self::ContractPaused => "ContractPaused",
            Self::AgentFrozen => "AgentFrozen",
            Self::NotAdmin => "NotAdmin",
            Self::InvalidRecord => "InvalidRecord",
            Self::DuplicateInBatch => "DuplicateInBatch",
            Self::StorageLimitReached => "StorageLimitReached",
            Self::InvalidArgument => "InvalidArgument",
            Self::InternalError => "InternalError",
            Self::Expired => "Expired",
            Self::InsufficientFunds => "InsufficientFunds",
            Self::RateLimited => "RateLimited",
            Self::ContractNotLinked => "ContractNotLinked",
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn common_codes_roundtrip_through_raw() {
        let codes = [
            CommonExitCode::NotFound,
            CommonExitCode::Unauthorized,
            CommonExitCode::AlreadyExists,
            CommonExitCode::ContractPaused,
            CommonExitCode::AgentFrozen,
            CommonExitCode::NotAdmin,
            CommonExitCode::InvalidRecord,
            CommonExitCode::DuplicateInBatch,
            CommonExitCode::StorageLimitReached,
            CommonExitCode::InvalidArgument,
            CommonExitCode::InternalError,
            CommonExitCode::Expired,
            CommonExitCode::InsufficientFunds,
            CommonExitCode::RateLimited,
            CommonExitCode::ContractNotLinked,
        ];
        for code in &codes {
            let raw = *code as u32;
            assert!(raw >= 1 && raw <= 15);
            let recovered = CommonExitCode::from_raw(raw).unwrap();
            assert_eq!(recovered as u32, raw);
        }
    }

    #[test]
    fn from_raw_returns_none_for_out_of_range() {
        assert!(CommonExitCode::from_raw(0).is_none());
        assert!(CommonExitCode::from_raw(16).is_none());
        assert!(CommonExitCode::from_raw(100).is_none());
        assert!(CommonExitCode::from_raw(255).is_none());
    }

    #[test]
    fn labels_are_nonempty() {
        let all = [
            CommonExitCode::NotFound,
            CommonExitCode::Unauthorized,
            CommonExitCode::AlreadyExists,
            CommonExitCode::ContractPaused,
            CommonExitCode::AgentFrozen,
            CommonExitCode::NotAdmin,
            CommonExitCode::InvalidRecord,
            CommonExitCode::DuplicateInBatch,
            CommonExitCode::StorageLimitReached,
            CommonExitCode::InvalidArgument,
            CommonExitCode::InternalError,
            CommonExitCode::Expired,
            CommonExitCode::InsufficientFunds,
            CommonExitCode::RateLimited,
            CommonExitCode::ContractNotLinked,
        ];
        for code in &all {
            assert!(!code.label().is_empty());
        }
    }
}
