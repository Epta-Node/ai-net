#![no_std]

//! Shared host-side interface shape for contract gas estimators.
use soroban_sdk::{Map, Symbol, Val};

/// Implemented by contracts that publish a gas estimate entry point.
/// The parameter map carries operation-specific dimensions; `len()` can be
/// used as a batch/item count when the caller supplies one entry per item.
pub trait GasEstimator {
    fn estimate(operation: Symbol, params: Map<Symbol, Val>) -> u64;
}
