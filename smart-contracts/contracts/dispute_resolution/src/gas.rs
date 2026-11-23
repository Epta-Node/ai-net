//! CPU instruction estimates for dispute resolution operations.
//!
//! Calibrated against the native Soroban budget tracker (soroban-sdk 22.0.11).
//! `file_dispute` is dominated by the cross-contract bond lock in the agent
//! registry (~308k instructions measured with a minimal record); each juror in
//! the voter pool adds ~650 instructions for copying it into the dispute.
//! See `tests/gas.rs` and the `dispute_resolution::*` entries in
//! `smart-contracts/gas-baselines.json`.
use soroban_sdk::{symbol_short, Symbol};

use crate::MAX_VOTERS;

pub const GAS_FILE_DISPUTE_BASE: u64 = 335_000;
pub const GAS_FILE_DISPUTE_PER_JUROR: u64 = 650;

pub fn estimate(operation: Symbol, juror_count: u32) -> u64 {
    if operation != symbol_short!("dispute") && operation != symbol_short!("file_disp") {
        return 0;
    }

    GAS_FILE_DISPUTE_BASE.saturating_add(
        GAS_FILE_DISPUTE_PER_JUROR.saturating_mul(juror_count.min(MAX_VOTERS) as u64),
    )
}
