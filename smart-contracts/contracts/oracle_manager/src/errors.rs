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
}
