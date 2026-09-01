//! # Error Types for Price Oracle

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
    /// The requested price feed asset pair was not found.
    FeedNotFound = 4,
    /// The price feed data is stale (older than the configured max age).
    PriceStale = 5,
    /// The reported price is zero or negative.
    InvalidPrice = 6,
    /// The submitted timestamp is in the future or otherwise invalid.
    InvalidTimestamp = 7,
}
