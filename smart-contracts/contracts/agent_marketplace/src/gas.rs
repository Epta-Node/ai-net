//! Empirical CPU instruction estimates for marketplace paths.
use soroban_sdk::{symbol_short, Symbol};

pub const GAS_TX_OVERHEAD: u64 = 40_000;
pub const GAS_LIST: u64 = 63_000;
pub const GAS_SEARCH: u64 = 20_000;
pub const GAS_SEARCH_PER_LISTING: u64 = 27_000;
pub const GAS_PURCHASE: u64 = 73_000;

pub fn estimate(operation: Symbol, count: u32) -> u64 {
    if count == 0 {
        return 0;
    }
    if operation == symbol_short!("listing") {
        GAS_LIST.saturating_mul(count as u64)
    } else if operation == symbol_short!("search") {
        GAS_SEARCH.saturating_add(GAS_SEARCH_PER_LISTING.saturating_mul(count as u64))
    } else if operation == symbol_short!("purchase") {
        GAS_PURCHASE.saturating_mul(count as u64)
    } else {
        0
    }
}
