//! Task store CPU estimates; query scans the requested number of task records.
use soroban_sdk::{symbol_short, Symbol};

pub const GAS_TX_OVERHEAD: u64 = 40_000;
pub const GAS_CREATE: u64 = 85_000;
pub const GAS_UPDATE: u64 = 104_000;
pub const GAS_QUERY: u64 = 38_000;
pub const GAS_QUERY_PER_TASK: u64 = 24_000;

pub fn estimate(operation: Symbol, count: u32) -> u64 {
    if count == 0 {
        return 0;
    }
    if operation == symbol_short!("create") {
        GAS_CREATE.saturating_mul(count as u64)
    } else if operation == symbol_short!("update") {
        GAS_UPDATE.saturating_mul(count as u64)
    } else if operation == symbol_short!("query") {
        GAS_QUERY.saturating_add(GAS_QUERY_PER_TASK.saturating_mul(count as u64))
    } else {
        0
    }
}
