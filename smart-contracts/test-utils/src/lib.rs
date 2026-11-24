//! Shared assertions for ai-net Soroban contract test suites.
//!
//! Two independent budgets are enforced here:
//!
//! * [`storage`] measures the ledger entries a contract owns before and after
//!   an operation and fails when the growth exceeds a documented ceiling
//!   (AGENTS.md §1: bounded storage footprint).
//! * [`gas`] snapshots the CPU-instruction and memory cost of an entrypoint so
//!   a refactor cannot silently make it more expensive.
//!
//! Both helpers are native-test-only. They are pulled in through
//! `[dev-dependencies]`, so they never link into a deployed Wasm binary.

pub mod gas;
pub mod storage;

pub use storage::{
    assert_storage_within, measure_storage, StorageAudit, StorageBudget, StorageDelta,
    StorageFootprint,
};
