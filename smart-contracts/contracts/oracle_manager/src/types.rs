//! # Data Types for Oracle Manager

use soroban_sdk::{contracttype, Address, Symbol};

/// The resolved price for a pair, including its provenance.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ResolvedPrice {
    /// The asset pair.
    pub pair: Symbol,
    /// Price in stroops.
    pub price: i128,
    /// How this price was obtained.
    pub source: PriceSource,
}

/// Provenance of a resolved price.
#[contracttype]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
#[repr(u32)]
pub enum PriceSource {
    /// Live price obtained from the registered on-chain oracle.
    Oracle = 0,
    /// Admin-set fallback used because no live oracle is configured.
    Fallback = 1,
}

/// Storage key enum for the Oracle Manager.
#[contracttype]
#[derive(Clone)]
pub enum DataKey {
    /// Admin address (Instance storage).
    Admin,
    /// Whether contract is paused (Instance storage).
    Paused,
    /// Optional oracle contract address (Instance storage).
    OracleAddress,
    /// Admin-set fallback price per asset pair (Persistent storage).
    FallbackPrice(Symbol),
    /// Set of oracle addresses allowed to call `update_price`
    /// (Instance storage, `Map<Address, ()>`).
    AuthorizedOracles,
    /// Latest price pushed by an authorized oracle per pair (Persistent storage).
    OraclePrice(Symbol),
}

/// A price pushed by an authorized oracle through `update_price`.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ReportedPrice {
    /// Price in stroops (always > 0).
    pub price: i128,
    /// Ledger timestamp at which the price was recorded.
    pub timestamp: u64,
    /// The authorized oracle that reported it.
    pub oracle: Address,
}

/// Event emitted when an oracle is added to or removed from the authorized set.
#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct OracleAuthChangedEvent {
    pub oracle: Address,
    pub authorized: bool,
}

/// Event emitted when an authorized oracle pushes a price.
#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct PriceUpdatedEvent {
    pub pair: Symbol,
    pub price: i128,
    pub oracle: Address,
}

/// Event emitted when admin is transferred.
#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct AdminChangedEvent {
    pub old_admin: Address,
    pub new_admin: Address,
}

/// Event emitted when the oracle address is changed.
#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct OracleSetEvent {
    /// The new oracle contract address.  `None` means the oracle was removed.
    pub oracle: Option<Address>,
}

/// Event emitted when a fallback price is set.
#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct FallbackPriceSetEvent {
    pub pair: Symbol,
    pub price: i128,
}

/// Event emitted when a price is resolved (live or fallback).
#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct PriceResolvedEvent {
    pub pair: Symbol,
    pub price: i128,
    pub source: PriceSource,
}

/// Event emitted when an underlying oracle call fails.
#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct OracleFailureEvent {
    pub pair: Symbol,
    pub error_code: u32,
}
