//! Empirical CPU instruction estimates. `reveal_bids` and award work scale
//! with the bounded bidder set (`MAX_BIDDERS`).
use soroban_sdk::{symbol_short, Symbol};

pub const GAS_TX_OVERHEAD: u64 = 40_000;
pub const GAS_SUBMIT_BID: u64 = 151_000;
pub const GAS_REVEAL_BID: u64 = 181_000;
pub const GAS_REVEAL_FINALIZE: u64 = 150_000;
pub const GAS_REVEAL_FINALIZE_MARGINAL: u64 = 133_000;

pub fn estimate(operation: Symbol, count: u32) -> u64 {
    if count == 0 {
        return 0;
    }
    let (first, marginal): (u64, u64) = if operation == symbol_short!("bid") {
        (GAS_SUBMIT_BID, 55_000)
    } else if operation == symbol_short!("reveal") {
        (GAS_REVEAL_BID, 65_000)
    } else if operation == symbol_short!("finalize") {
        (GAS_REVEAL_FINALIZE, GAS_REVEAL_FINALIZE_MARGINAL)
    } else {
        return 0;
    };
    first.saturating_add(marginal.saturating_mul((count - 1) as u64))
}
