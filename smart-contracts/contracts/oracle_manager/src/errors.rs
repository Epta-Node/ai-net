//! # Error Types for Oracle Manager

use soroban_sdk::contracterror;

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum Error {
    /// Contract has not been initialized.
    NotInitialized = 1,
    /// Caller is not the admin.
    Unauthorized = 2,
    /// Contract has already been initialized.
    AlreadyInitialized = 3,
    /// No on-chain oracle has been configured and no fallback price exists.
    NoPriceAvailable = 4,
    /// The oracle returned a stale price and no fallback is configured.
    PriceStale = 5,
    /// The supplied fallback price is zero or negative.
    InvalidFallbackPrice = 6,
    /// The cross-contract oracle call failed for an unexpected reason.
    OracleCallFailed = 7,
    /// Contract is currently paused.
    ContractPaused = 8,
    /// The oracle contract is not initialized.
    OracleNotInitialized = 9,
    /// The oracle contract is currently paused.
    OraclePaused = 10,
    /// The configured oracle has no feed for the pair and no fallback exists.
    FeedNotFound = 11,
    /// The caller of `update_price` is not in the authorized oracle set.
    OracleNotAuthorized = 12,
    /// `register_oracle` was called for an address that is already authorized.
    OracleAlreadyRegistered = 13,
    /// `remove_oracle` was called for an address that is not authorized.
    OracleNotRegistered = 14,
    /// The authorized oracle set is at `MAX_AUTHORIZED_ORACLES`.
    TooManyOracles = 15,
    /// The pushed price is zero or negative.
    InvalidPrice = 16,
}
