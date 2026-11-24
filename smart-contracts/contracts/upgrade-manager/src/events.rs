//! Event payloads for the upgrade manager.
//!
//! Convention (shared with every other contract in this workspace): events are
//! published on a two-topic tuple `(symbol_short!("upgrade"), symbol_short!("<action>"))`
//! and carry a `#[contracttype]` struct as the payload.

use soroban_sdk::{contracttype, Address, BytesN, String, Vec};

/// Event emitted when upgrade manager is initialized
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct UpgradeInitializedEvent {
    pub admin: Address,
    pub version: String,
    pub wasm_hash: BytesN<32>,
}

/// Event emitted when admin is changed
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AdminChangedEvent {
    pub old_admin: Address,
    pub new_admin: Address,
}

/// Event emitted when the multisig signer set is reconfigured.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct MultisigConfigChangedEvent {
    pub admins: Vec<Address>,
    pub threshold: u32,
    pub timelock_delay: u64,
}

/// Event emitted when an upgrade proposal is created.
///
/// `eta` is `0` at creation and is only assigned once the approval threshold is
/// reached — see `execute_upgrade`'s timelock note in `lib.rs`.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct UpgradeProposedEvent {
    pub proposal_id: u64,
    pub version: String,
    pub wasm_hash: BytesN<32>,
    pub proposer: Address,
    pub description: String,
    pub threshold: u32,
    pub expires_at: u64,
}

/// Event emitted when a signer approves a proposal. Emitted once per approval,
/// including the proposer's implicit approval at creation time.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct UpgradeApprovedEvent {
    pub proposal_id: u64,
    pub approver: Address,
    pub approval_count: u32,
    pub threshold: u32,
    /// Set on the approval that reaches the threshold and starts the timelock.
    pub eta: u64,
}

/// Event emitted when upgrade proposal is validated
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct UpgradeValidatedEvent {
    pub proposal_id: u64,
    pub version: String,
    pub estimated_gas: u64,
    pub validation_results: Vec<String>,
}

/// Event emitted when an upgrade is applied to the contract's own WASM.
///
/// The issue text calls this `UpgradeExecuted`; the existing name is retained to
/// avoid breaking existing event consumers, and `proposal_id` is added so it can
/// be correlated with the proposal that authorised it.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct UpgradeAppliedEvent {
    pub proposal_id: u64,
    pub old_version: String,
    pub new_version: String,
    pub wasm_hash: BytesN<32>,
    pub admin: Address,
    pub rollback_deadline: u32,
}

/// Event emitted when an upgrade is rolled back.
///
/// IMPORTANT: this reverts the contract's *executable* to
/// `restored_wasm_hash`. It does **not** revert any storage mutation performed
/// by the post-upgrade migration — see the rollback note in `lib.rs`.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct UpgradeRolledBackEvent {
    pub proposal_id: u64,
    pub reverted_version: String,
    pub restored_version: String,
    pub restored_wasm_hash: BytesN<32>,
    pub admin: Address,
}

/// Event emitted when expired proposals are swept.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ExpiredProposalsSweptEvent {
    pub swept: u32,
    pub admin: Address,
}

/// Event emitted when the upgrade-manager side of a migration completes.
///
/// Data transformations and post-migration validations are executed by the
/// upgraded contract's `post_upgrade_hook`; they are listed here as
/// delegated, not as performed.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct MigrationCompleteEvent {
    /// The version that was applied.
    pub version: String,
    /// Transformation steps delegated to the upgraded contract.
    pub delegated_transformations: Vec<String>,
    /// Post-migration validations delegated to the upgraded contract.
    pub delegated_validations: Vec<String>,
    /// Item count declared in the migration plan (an estimate, not a count).
    pub estimated_items: u32,
}
