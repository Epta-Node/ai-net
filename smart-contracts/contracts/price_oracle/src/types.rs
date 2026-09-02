//! # Data Types for Price Oracle

use soroban_sdk::{contracttype, Symbol};

/// A single price observation pushed by the authoritative feed provider.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PriceEntry {
    /// Price in stroops (1 XLM = 10_000_000 stroops).
    /// Must be > 0.
    pub price: i128,
    /// Unix timestamp (seconds) when this price was observed off-chain.
    pub timestamp: u64,
}

/// A price query result returned to callers.
/// Wraps `PriceEntry` with the asset pair for traceability.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PriceResult {
    /// The asset pair (e.g. `XLM_USD`, `XLM_EUR`).
    pub pair: Symbol,
    /// Price in stroops.
    pub price: i128,
    /// Timestamp from the original feed submission.
    pub timestamp: u64,
}

/// Storage key enum for this contract.
#[contracttype]
#[derive(Clone)]
pub enum DataKey {
    /// Singleton admin address (Instance storage).
    Admin,
    /// Maximum age in seconds before a price is considered stale (Instance storage).
    MaxPriceAge,
    /// Price entry for a given asset pair (Persistent storage).
    Price(Symbol),
}

/// Event emitted when a new price is submitted.
#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct PriceUpdatedEvent {
    /// Asset pair that was updated.
    pub pair: Symbol,
    /// New price in stroops.
    pub price: i128,
    /// Feed timestamp of the new price.
    pub timestamp: u64,
}

/// Event emitted when the admin changes the maximum price age.
#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct MaxAgeUpdatedEvent {
    /// Previous max age in seconds.
    pub old_max_age: u64,
    /// New max age in seconds.
    pub new_max_age: u64,
}
