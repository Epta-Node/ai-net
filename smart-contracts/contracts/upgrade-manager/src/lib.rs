#![no_std]

//! # Upgrade Manager Contract
//!
//! Timelock-governed, multi-signature upgrade management for Soroban contracts.
//!
//! ## Scope: this is a *self*-upgrade manager
//!
//! Soroban's only upgrade primitive is
//! `env.deployer().update_current_contract_wasm(hash)`. Per the SDK docs
//! (soroban-sdk 22.0.11, `src/deploy.rs`):
//!
//! > Replaces the executable of **the current contract** with the provided Wasm.
//! > ... The function won't do anything immediately. The contract executable
//! > will only be updated after the invocation has successfully finished.
//!
//! There is no target-address parameter, so **a contract can only ever upgrade
//! itself**. This contract therefore governs its own WASM. Other contracts that
//! want the same governance copy the pattern: they depend on this crate as a
//! library (`default-features = false`) and implement the [`Upgradeable`] trait,
//! as `agent_registry` does. This crate is the reference implementation and the
//! shared source of types and constants — not a cross-contract upgrade authority.
//!
//! ## Lifecycle
//!
//! ```text
//! Proposed ──approve*──> Approved ──threshold reached──> PendingTimelock
//!     │                                                    │
//!     │                                          eta elapsed │
//!     │                                                    ▼
//!     └────────────────── insufficient ────────────────> Ready
//!                                                          │ execute
//!                                                          ▼
//!                                          Executed ──rollback──> RolledBack
//!     any non-terminal ──now > expires_at──> Expired ──sweep──> (reaped)
//! ```
//!
//! ## Timelock: deliberately stricter than `agent_registry`
//!
//! `agent_registry` sets `eta = created_at + timelock_delay` **at proposal
//! time**. That is flawed: if the signer set is widened, a proposal can sit
//! unapproved past its `eta` and become *instantly* executable the moment the
//! last approval lands, so the timelock provides no real delay.
//!
//! This contract instead starts the clock **only when the approval threshold is
//! first reached** (`eta` is `0` until then). The waiting period is therefore
//! always observed in full, after the decision to upgrade is final. This is an
//! intentional deviation from the sibling contract; see `approve_upgrade`.
//!
//! ## Rollback is a *code* revert, not a state revert
//!
//! `rollback_upgrade` re-invokes `update_current_contract_wasm` with the
//! previous hash — the same primitive as an upgrade, which is the only thing
//! the platform offers. It does **not** undo any storage mutation performed by
//! `execute_post_upgrade_migration`. Today every migration function in
//! `migration.rs` is a stub that writes nothing, so no data is at risk; but a
//! future destructive migration must not rely on rollback to undo itself. See
//! `migration::is_migration_reversible`.
//!
//! ## Security model
//!
//! - Only governance members (single admin, or the multisig signer set when one
//!   is configured) may propose, approve, execute or roll back.
//! - `require_auth()` is called on the *caller-supplied* address, so Soroban
//!   enforces the signature — membership alone is not enough.
//! - Execution requires BOTH the timelock to have elapsed AND the approval
//!   threshold to be met.
//! - A single-signature emergency path (`set_admin`, `set_multisig_config`,
//!   `pause`) is deliberately retained even when a multisig is configured, so a
//!   misconfigured signer set can always be repaired.

pub mod events;
mod migration;
pub mod strutil;
pub mod upgradeable;

use events::*;
use migration::*;
use soroban_sdk::{
    contract, contracterror, contractimpl, contracttype, symbol_short, Address, BytesN, Env,
    String, Vec,
};
pub use upgradeable::*;

// ─── Constants ───────────────────────────────────────────────────────────────

/// Rollback window in ledgers (48h at ~5s per ledger).
///
/// UNIT NOTE: this is a *ledger-sequence* window, whereas [`DEFAULT_TIMELOCK_DELAY`]
/// and [`DEFAULT_PROPOSAL_EXPIRY`] are *wall-clock seconds*. The inconsistency
/// is preserved deliberately — `agent_registry::get_upgrade_status` derives its
/// own rollback deadline from this constant, so changing the unit would silently
/// break that contract. Documented rather than fixed.
pub const ROLLBACK_WINDOW_LEDGERS: u32 = 34_560;

/// Default timelock delay in seconds (24h).
pub const DEFAULT_TIMELOCK_DELAY: u64 = 86_400;

/// Default proposal validity period in seconds (7 days).
pub const DEFAULT_PROPOSAL_EXPIRY: u64 = 604_800;

/// Approval threshold applied when no multisig is configured: the proposer alone.
pub const DEFAULT_THRESHOLD: u32 = 1;

/// Maximum proposals examined by a single sweep call, to bound gas.
pub const MAX_SWEEP_PROPOSALS: u32 = 50;

/// Default TTL threshold for storage extension
pub const TTL_THRESHOLD: u32 = 100_000;
/// Target TTL after extension (~31 days)
pub const TTL_EXTEND_TO: u32 = 535_680;

/// Gas budget constants for upgrade operations
pub const GAS_UPGRADE_BASE: u64 = 500_000;
pub const GAS_MIGRATION_PER_ITEM: u64 = 10_000;
pub const GAS_ROLLBACK_BASE: u64 = 200_000;
/// Fixed overhead charged per migration step (check, transformation or validation)
pub const GAS_MIGRATION_STEP_OVERHEAD: u64 = 5_000;

/// Maximum number of versions retained in the version-history index.
/// Older entries are dropped from the index first.
pub const MAX_VERSION_HISTORY: u32 = 100;

// ─── Types ───────────────────────────────────────────────────────────────────

/// Contract version information
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ContractVersion {
    pub version: String,
    pub wasm_hash: BytesN<32>,
    pub upgrade_ledger: u32,
    pub description: String,
    pub admin: Address,
    pub rollback_deadline: u32,
}

/// Migration execution plan
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct MigrationPlan {
    pub pre_migration_checks: Vec<String>,
    pub data_transformations: Vec<String>,
    pub post_migration_validations: Vec<String>,
    pub estimated_items: u32,
}

/// Rollback record for tracking rollback eligibility
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RollbackRecord {
    pub previous_version: ContractVersion,
    pub rollback_deadline: u32,
    pub can_rollback: bool,
}

/// Multi-signature administration configuration.
///
/// Mirrors `agent_registry::MultisigConfig` so the two contracts stay
/// idiomatic with each other.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct MultisigConfig {
    /// Authorized governance members.
    pub admins: Vec<Address>,
    /// Required approval count (M of N).
    pub threshold: u32,
    /// Delay in seconds between reaching threshold and becoming executable.
    pub timelock_delay: u64,
}

/// Lifecycle state of an upgrade proposal.
///
/// `Ready` is never persisted: it is *derived* at read time from
/// `PendingTimelock + now >= eta`, because no transaction runs at the moment
/// the timelock elapses.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ProposalStatus {
    Proposed = 0,
    Approved = 1,
    PendingTimelock = 2,
    Ready = 3,
    Executed = 4,
    RolledBack = 5,
    Expired = 6,
}

impl ProposalStatus {
    /// Terminal states can never transition again.
    pub fn is_terminal(&self) -> bool {
        matches!(
            self,
            ProposalStatus::Executed | ProposalStatus::RolledBack | ProposalStatus::Expired
        )
    }
}

/// An upgrade proposal awaiting approval, timelock, and execution.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct UpgradeProposal {
    pub id: u64,
    pub proposer: Address,
    pub new_version: String,
    pub new_wasm_hash: BytesN<32>,
    pub description: String,
    pub migration_plan: MigrationPlan,
    /// Ledger timestamp (seconds) at proposal creation.
    pub created_at: u64,
    /// Earliest execution time. `0` until the approval threshold is reached.
    pub eta: u64,
    /// Timestamp after which this proposal can never be executed.
    pub expires_at: u64,
    /// Governance members who have approved. Length is the approval count.
    pub approvals: Vec<Address>,
    pub status: ProposalStatus,
    pub validated: bool,
    pub estimated_gas: u64,
    /// Captured at execution time, for rollback.
    pub previous_version: String,
    pub previous_wasm_hash: BytesN<32>,
    pub executed_ledger: u32,
    pub rollback_deadline: u32,
}

/// Storage keys for upgrade manager data.
///
/// STORAGE-LAYOUT NOTE (issue #488): `Proposal` and `Rollback` changed from
/// unit variants to tuple variants keyed by proposal id, and `MultisigConfig` /
/// `NextProposalId` were appended. New variants are appended at the end so
/// existing discriminants are not shifted. The two *changed* slots only ever
/// hold transient records (a proposal is superseded once executed, a rollback
/// record is deleted once consumed), so the blast radius of this change is
/// limited to an in-flight proposal or rollback record at upgrade time.
#[contracttype]
#[derive(Clone)]
pub enum DataKey {
    /// Current admin address (retained as the emergency single-signature path)
    Admin,
    /// Whether the contract is paused
    Paused,
    /// Current contract version
    CurrentVersion,
    /// Version history (version_string -> ContractVersion)
    Version(String),
    /// Upgrade proposal, keyed by proposal id
    Proposal(u64),
    /// Rollback record, keyed by proposal id
    Rollback(u64),
    /// Migration state during upgrade
    MigrationState,
    /// Contract-specific upgrade hooks
    UpgradeHooks,
    /// Multisig configuration, when configured
    MultisigConfig,
    /// Monotonic proposal id counter
    NextProposalId,
}

/// Upgrade operation errors.
///
/// Codes 1-13 are the original set and are frozen — never renumber them, as the
/// values are part of the contract's ABI. New variants start at 14.
#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum UpgradeError {
    /// Caller is not authorized to perform upgrade operations
    Unauthorized = 1,
    /// Version already exists or is invalid
    InvalidVersion = 2,
    /// No upgrade proposal exists
    NoProposal = 3,
    /// Upgrade proposal has not been validated
    ProposalNotValidated = 4,
    /// Pre-upgrade validation failed
    PreUpgradeValidationFailed = 5,
    /// Migration execution failed
    MigrationFailed = 6,
    /// Post-upgrade validation failed
    PostUpgradeValidationFailed = 7,
    /// Rollback deadline has passed
    RollbackDeadlineExpired = 8,
    /// No rollback available
    NoRollbackAvailable = 9,
    /// Contract not found or not upgradeable
    ContractNotUpgradeable = 10,
    /// Insufficient gas budget for migration
    InsufficientGasBudget = 11,
    /// Version downgrade not allowed without explicit rollback
    DowngradeNotAllowed = 12,
    /// The contract is paused and cannot accept mutations
    ContractPaused = 13,
    /// A version tag is not a well-formed `MAJOR.MINOR.PATCH[-pre][+build]`
    MalformedVersion = 14,
    /// The Wasm swap is not available in this build, so the upgrade could
    /// not actually be applied
    SwapUnavailable = 15,
}

/// Main upgrade manager contract
#[contract]
pub struct UpgradeManager;

// ─── Helpers ─────────────────────────────────────────────────────────────────

fn extend_ttl_for_key(env: &Env, key: &DataKey) {
    if env.storage().persistent().has(key) {
        env.storage()
            .persistent()
            .extend_ttl(key, TTL_THRESHOLD, TTL_EXTEND_TO);
    }
}

fn require_admin(env: &Env) -> Result<Address, UpgradeError> {
    let admin: Address = env
        .storage()
        .instance()
        .get(&DataKey::Admin)
        .ok_or(UpgradeError::Unauthorized)?;
    admin.require_auth();
    Ok(admin)
}

fn require_not_paused(env: &Env) -> Result<(), UpgradeError> {
    let paused: bool = env
        .storage()
        .instance()
        .get(&DataKey::Paused)
        .unwrap_or(false);
    if paused {
        return Err(UpgradeError::ContractPaused);
    }
    Ok(())
}

fn get_current_version(env: &Env) -> Option<ContractVersion> {
    env.storage().persistent().get(&DataKey::CurrentVersion)
}

/// Returns `Ok(true)` when `proposed` has strictly higher semver precedence
/// than `current`, using [`strutil::compare_versions`] (numeric component-wise
/// comparison; pre-releases sort below their release). Malformed tags yield
/// [`UpgradeError::MalformedVersion`] instead of falling back to byte order.
fn is_version_newer(current: &String, proposed: &String) -> Result<bool, UpgradeError> {
    strutil::compare_versions(proposed, current)
        .map(|ord| ord == core::cmp::Ordering::Greater)
        .ok_or(UpgradeError::MalformedVersion)
}

// ─── Contract Implementation ─────────────────────────────────────────────────

#[cfg(feature = "contract")]
#[contractimpl]
impl UpgradeManager {
    /// Initialize the upgrade manager with an admin and initial version.
    pub fn initialize(
        env: Env,
        admin: Address,
        initial_version: String,
        initial_wasm_hash: BytesN<32>,
    ) -> Result<(), UpgradeError> {
        admin.require_auth();
        if env.storage().instance().has(&DataKey::Admin) {
            return Err(UpgradeError::InvalidVersion);
        }

        admin.require_auth();
        env.storage().instance().set(&DataKey::Admin, &admin);
        env.storage().instance().set(&DataKey::Paused, &false);
        record_wasm_hash(&env, &initial_wasm_hash);

        let initial = ContractVersion {
            version: initial_version.clone(),
            wasm_hash: initial_wasm_hash,
            upgrade_ledger: env.ledger().sequence(),
            description: String::from_str(&env, "Initial deployment"),
            admin: admin.clone(),
            rollback_deadline: 0,
        };

        env.storage()
            .persistent()
            .set(&DataKey::CurrentVersion, &initial);
        env.storage()
            .persistent()
            .set(&DataKey::Version(initial_version.clone()), &initial);

        extend_ttl_for_key(&env, &DataKey::CurrentVersion);
        extend_ttl_for_key(&env, &DataKey::Version(initial_version.clone()));
        record_version(&env, &initial_version);

        env.events().publish(
            (symbol_short!("upgrade"), symbol_short!("init")),
            UpgradeInitializedEvent {
                admin,
                version: initial_version,
                wasm_hash: initial.wasm_hash,
            },
        );

        Ok(())
    }

    /// Set a new admin for the upgrade manager.
    ///
    /// Intentionally single-signature even when a multisig is configured, so a
    /// misconfigured signer set can always be repaired.
    pub fn set_admin(env: Env, new_admin: Address) -> Result<(), UpgradeError> {
        require_not_paused(&env)?;
        let old_admin = require_admin(&env)?;
        env.storage().instance().set(&DataKey::Admin, &new_admin);

        env.events().publish(
            (symbol_short!("upgrade"), symbol_short!("adm_chng")),
            AdminChangedEvent {
                old_admin,
                new_admin,
            },
        );

        Ok(())
    }

    /// Get the current admin.
    pub fn get_admin(env: Env) -> Option<Address> {
        env.storage().instance().get(&DataKey::Admin)
    }

    /// Configure the multisig signer set, threshold, and timelock delay.
    ///
    /// Single-signature (admin) on purpose — see [`UpgradeManager::set_admin`].
    pub fn set_multisig_config(
        env: Env,
        admins: Vec<Address>,
        threshold: u32,
        timelock_delay: u64,
    ) -> Result<(), UpgradeError> {
        require_not_paused(&env)?;
        require_admin(&env)?;

        if admins.is_empty() || threshold == 0 || threshold > admins.len() {
            return Err(UpgradeError::InvalidMultisigConfig);
        }
        if timelock_delay == 0 {
            return Err(UpgradeError::InvalidMultisigConfig);
        }

        env.storage().instance().set(
            &DataKey::MultisigConfig,
            &MultisigConfig {
                admins: admins.clone(),
                threshold,
                timelock_delay,
            },
        );

        env.events().publish(
            (symbol_short!("upgrade"), symbol_short!("msig_set")),
            MultisigConfigChangedEvent {
                admins,
                threshold,
                timelock_delay,
            },
        );

        Ok(())
    }

    /// Read the multisig configuration, if one is configured.
    pub fn get_multisig_config(env: Env) -> Option<MultisigConfig> {
        get_multisig(&env)
    }

    /// Pause the contract. Only admin can call this.
    pub fn pause(env: Env) -> Result<(), UpgradeError> {
        require_admin(&env)?;
        env.storage().instance().set(&DataKey::Paused, &true);
        env.events()
            .publish((symbol_short!("upgrade"), symbol_short!("paused")), ());
        Ok(())
    }

    /// Unpause the contract. Only admin can call this.
    pub fn unpause(env: Env) -> Result<(), UpgradeError> {
        require_admin(&env)?;
        env.storage().instance().set(&DataKey::Paused, &false);
        env.events()
            .publish((symbol_short!("upgrade"), symbol_short!("unpaused")), ());
        Ok(())
    }

    /// Returns whether the contract is currently paused.
    pub fn is_paused(env: Env) -> bool {
        env.storage()
            .instance()
            .get(&DataKey::Paused)
            .unwrap_or(false)
    }

    /// Get the current contract version.
    pub fn get_current_version(env: Env) -> Option<ContractVersion> {
        get_current_version(&env)
    }

    /// Get version history for a specific version.
    pub fn get_version(env: Env, version: String) -> Option<ContractVersion> {
        env.storage().persistent().get(&DataKey::Version(version))
    }

    /// Create an upgrade proposal and start governance.
    ///
    /// Returns the new proposal id. The proposer is recorded as the first
    /// approver, so a 1-of-N configuration becomes immediately timelocked while
    /// a higher threshold stays in [`ProposalStatus::Proposed`].
    pub fn propose_upgrade(
        env: Env,
        proposer: Address,
        new_version: String,
        new_wasm_hash: BytesN<32>,
        description: String,
        migration_plan: MigrationPlan,
    ) -> Result<u64, UpgradeError> {
        require_not_paused(&env)?;
        require_governance_member(&env, &proposer)?;

        if let Some(current) = get_current_version(&env) {
            if !is_version_newer(&current.version, &new_version)? {
                return Err(UpgradeError::DowngradeNotAllowed);
            }
        } else if strutil::compare_versions(&new_version, &new_version).is_none() {
            return Err(UpgradeError::MalformedVersion);
        }

        let (threshold, timelock_delay) = effective_config(&env);
        let id = next_proposal_id(&env);
        let now = env.ledger().timestamp();

        let mut approvals = Vec::new(&env);
        approvals.push_back(proposer.clone());

        let mut proposal = UpgradeProposal {
            id,
            proposer: proposer.clone(),
            new_version: new_version.clone(),
            new_wasm_hash: new_wasm_hash.clone(),
            description: description.clone(),
            migration_plan,
            created_at: now,
            eta: 0,
            expires_at: now + DEFAULT_PROPOSAL_EXPIRY,
            approvals,
            status: ProposalStatus::Proposed,
            validated: false,
            estimated_gas: 0,
            previous_version: String::from_str(&env, ""),
            previous_wasm_hash: BytesN::from_array(&env, &[0u8; 32]),
            executed_ledger: 0,
            rollback_deadline: 0,
        };

        // Start the timelock now only if the proposer's own approval already
        // satisfies the threshold (the 1-of-N case).
        if threshold <= 1 {
            proposal.eta = now + timelock_delay;
            proposal.status = ProposalStatus::PendingTimelock;
        }

        save_proposal(&env, &proposal);
        env.storage()
            .instance()
            .set(&DataKey::NextProposalId, &(id + 1));

        env.events().publish(
            (symbol_short!("upgrade"), symbol_short!("proposed")),
            UpgradeProposedEvent {
                proposal_id: id,
                version: new_version,
                wasm_hash: new_wasm_hash,
                proposer,
                description,
                threshold,
                expires_at: proposal.expires_at,
            },
        );

        // The implicit proposer approval is a real approval and emits too, so
        // an indexer counting approvals never under-reports.
        if threshold <= 1 {
            env.events().publish(
                (symbol_short!("upgrade"), symbol_short!("approved")),
                UpgradeApprovedEvent {
                    proposal_id: id,
                    approver: proposal.proposer.clone(),
                    approval_count: 1,
                    threshold,
                    eta: proposal.eta,
                },
            );
        }

        Ok(id)
    }

    /// Record a governance member's approval.
    ///
    /// The timelock starts on the approval that *reaches the threshold*, not at
    /// proposal creation. This is an intentional, security-motivated deviation
    /// from `agent_registry`, which sets `eta` at propose time — under that
    /// scheme a proposal that sits below threshold past its `eta` becomes
    /// instantly executable the moment the final approval lands, so the timelock
    /// never actually delays anything.
    pub fn approve_upgrade(
        env: Env,
        approver: Address,
        proposal_id: u64,
    ) -> Result<(), UpgradeError> {
        require_not_paused(&env)?;
        require_governance_member(&env, &approver)?;

        let mut proposal = load_proposal(&env, proposal_id)?;
        let now = env.ledger().timestamp();

        if proposal.status == ProposalStatus::Executed
            || proposal.status == ProposalStatus::RolledBack
        {
            return Err(UpgradeError::ProposalAlreadyExecuted);
        }
        if now > proposal.expires_at {
            return Err(UpgradeError::ProposalExpired);
        }
        if proposal.approvals.contains(&approver) {
            return Err(UpgradeError::AlreadyApproved);
        }

        proposal.approvals.push_back(approver.clone());
        let count = proposal.approvals.len() as u32;

        let (threshold, timelock_delay) = effective_config(&env);
        if proposal.eta == 0 && count >= threshold {
            proposal.eta = now + timelock_delay;
            proposal.status = ProposalStatus::PendingTimelock;
        } else if count == 1 {
            proposal.status = ProposalStatus::Approved;
        }

        save_proposal(&env, &proposal);

        env.events().publish(
            (symbol_short!("upgrade"), symbol_short!("approved")),
            UpgradeApprovedEvent {
                proposal_id,
                approver,
                approval_count: count,
                threshold,
                eta: proposal.eta,
            },
        );

        Ok(())
    }

    /// Run the pre-upgrade validation hook and estimate migration gas.
    pub fn validate_proposal(
        env: Env,
        caller: Address,
        proposal_id: u64,
    ) -> Result<u64, UpgradeError> {
        require_not_paused(&env)?;
        require_governance_member(&env, &caller)?;

        let mut proposal = load_proposal(&env, proposal_id)?;
        if proposal.status == ProposalStatus::Executed
            || proposal.status == ProposalStatus::RolledBack
        {
            return Err(UpgradeError::ProposalAlreadyExecuted);
        }

        let validation_result = execute_pre_upgrade_validation(&env, &proposal)?;
        let estimated_gas = estimate_migration_gas(&env, &proposal.migration_plan);

        proposal.validated = true;
        proposal.estimated_gas = estimated_gas;
        save_proposal(&env, &proposal);

        env.events().publish(
            (symbol_short!("upgrade"), symbol_short!("validated")),
            UpgradeValidatedEvent {
                proposal_id,
                version: proposal.new_version,
                estimated_gas,
                validation_results: validation_result,
            },
        );

        Ok(estimated_gas)
    }

    /// Execute an approved, timelocked proposal: replace this contract's WASM.
    ///
    /// Requires BOTH the timelock to have elapsed AND the approval threshold to
    /// be met. The WASM swap itself is deferred by the host until this
    /// invocation finishes successfully, so the bookkeeping below still runs
    /// under the outgoing code.
    pub fn execute_upgrade(
        env: Env,
        executor: Address,
        proposal_id: u64,
    ) -> Result<(), UpgradeError> {
        require_not_paused(&env)?;
        require_governance_member(&env, &executor)?;

        let mut proposal = load_proposal(&env, proposal_id)?;
        let now = env.ledger().timestamp();
        let status = effective_status(&proposal, now);

        match status {
            ProposalStatus::Executed | ProposalStatus::RolledBack => {
                return Err(UpgradeError::ProposalAlreadyExecuted)
            }
            ProposalStatus::Expired => return Err(UpgradeError::ProposalExpired),
            ProposalStatus::PendingTimelock => return Err(UpgradeError::TimelockNotElapsed),
            ProposalStatus::Proposed | ProposalStatus::Approved => {
                return Err(UpgradeError::InsufficientApprovals)
            }
            ProposalStatus::Ready => {}
        }

        let (threshold, _) = effective_config(&env);
        if (proposal.approvals.len() as u32) < threshold {
            return Err(UpgradeError::InsufficientApprovals);
        }
        if !proposal.validated {
            return Err(UpgradeError::ProposalNotValidated);
        }

        let previous_version = get_current_version(&env);
        let rollback_deadline = env.ledger().sequence() + ROLLBACK_WINDOW_LEDGERS;
        let executor_address = executor.clone();

        // Execute the upgrade. Fails with `SwapUnavailable` rather than
        // reporting success when the swap cannot be performed.
        swap_wasm(&env, &proposal.new_wasm_hash).map_err(|_| UpgradeError::SwapUnavailable)?;

        let new_version = ContractVersion {
            version: proposal.new_version.clone(),
            wasm_hash: proposal.new_wasm_hash.clone(),
            upgrade_ledger: env.ledger().sequence(),
            description: proposal.description.clone(),
            admin: executor_address.clone(),
            rollback_deadline,
        };

        env.storage()
            .persistent()
            .set(&DataKey::CurrentVersion, &new_version);
        env.storage().persistent().set(
            &DataKey::Version(proposal.new_version.clone()),
            &new_version,
        );
        record_version(&env, &proposal.new_version);

        if let Some(ref prev) = previous_version {
            env.storage().persistent().set(
                &DataKey::Rollback(proposal_id),
                &RollbackRecord {
                    previous_version: prev.clone(),
                    rollback_deadline,
                    can_rollback: true,
                },
            );
            extend_ttl_for_key(&env, &DataKey::Rollback(proposal_id));

            proposal.previous_version = prev.version.clone();
            proposal.previous_wasm_hash = prev.wasm_hash.clone();
        }

        proposal.status = ProposalStatus::Executed;
        proposal.executed_ledger = env.ledger().sequence();
        proposal.rollback_deadline = rollback_deadline;
        save_proposal(&env, &proposal);

        execute_post_upgrade_migration(&env, &proposal.migration_plan)?;

        extend_ttl_for_key(&env, &DataKey::CurrentVersion);
        extend_ttl_for_key(&env, &DataKey::Version(proposal.new_version.clone()));
        env.storage()
            .instance()
            .extend_ttl(TTL_THRESHOLD, TTL_EXTEND_TO);

        env.events().publish(
            (symbol_short!("upgrade"), symbol_short!("applied")),
            UpgradeAppliedEvent {
                proposal_id,
                old_version: previous_version
                    .map(|v| v.version)
                    .unwrap_or(String::from_str(&env, "none")),
                new_version: proposal.new_version,
                wasm_hash: proposal.new_wasm_hash,
                admin: executor_address,
                rollback_deadline,
            },
        );

        Ok(())
    }

    /// Revert this contract's executable to the hash captured at execution.
    ///
    /// CODE-ONLY REVERT. This restores the previous WASM; it does **not** undo
    /// any storage mutation the post-upgrade migration performed. It reuses
    /// `update_current_contract_wasm` because that is the only primitive the
    /// platform offers, so "rollback" and "upgrade" are the same operation
    /// pointed at a different hash.
    pub fn rollback_upgrade(
        env: Env,
        executor: Address,
        proposal_id: u64,
    ) -> Result<(), UpgradeError> {
        require_not_paused(&env)?;
        require_governance_member(&env, &executor)?;

        let mut proposal = load_proposal(&env, proposal_id)?;
        if proposal.status != ProposalStatus::Executed {
            return Err(UpgradeError::NoRollbackAvailable);
        }

        let record: RollbackRecord = env
            .storage()
            .persistent()
            .get(&DataKey::Rollback(proposal_id))
            .ok_or(UpgradeError::NoRollbackAvailable)?;

        if !record.can_rollback {
            return Err(UpgradeError::NoRollbackAvailable);
        }
        if env.ledger().sequence() > record.rollback_deadline {
            return Err(UpgradeError::RollbackDeadlineExpired);
        }

        let reverted_version = proposal.new_version.clone();
        let restored_wasm_hash = record.previous_version.wasm_hash.clone();
        let restored_version = record.previous_version.version.clone();

        // Perform the rollback
        swap_wasm(&env, &rollback_record.previous_version.wasm_hash)
            .map_err(|_| UpgradeError::SwapUnavailable)?;

        env.storage()
            .persistent()
            .set(&DataKey::CurrentVersion, &record.previous_version);

        // Single-use: a second rollback must not be possible.
        env.storage()
            .persistent()
            .remove(&DataKey::Rollback(proposal_id));

        proposal.status = ProposalStatus::RolledBack;
        save_proposal(&env, &proposal);

        extend_ttl_for_key(&env, &DataKey::CurrentVersion);
        env.storage()
            .instance()
            .extend_ttl(TTL_THRESHOLD, TTL_EXTEND_TO);

        env.events().publish(
            (symbol_short!("upgrade"), symbol_short!("rollback")),
            UpgradeRolledBackEvent {
                proposal_id,
                reverted_version,
                restored_version,
                restored_wasm_hash,
                admin: executor,
            },
        );

        Ok(())
    }

    /// Read a proposal, resolving the derived `Ready` status.
    pub fn get_proposal(env: Env, proposal_id: u64) -> Option<UpgradeProposal> {
        let mut proposal: UpgradeProposal = env
            .storage()
            .persistent()
            .get(&DataKey::Proposal(proposal_id))?;
        proposal.status = effective_status(&proposal, env.ledger().timestamp());
        Some(proposal)
    }

    /// Get rollback information for a proposal, if one is recorded.
    pub fn get_rollback_info(env: Env, proposal_id: u64) -> Option<RollbackRecord> {
        env.storage()
            .persistent()
            .get(&DataKey::Rollback(proposal_id))
    }

    /// Whether the given proposal can still be rolled back.
    pub fn can_rollback(env: Env, proposal_id: u64) -> bool {
        match env
            .storage()
            .persistent()
            .get::<DataKey, RollbackRecord>(&DataKey::Rollback(proposal_id))
        {
            Some(record) => {
                record.can_rollback && env.ledger().sequence() <= record.rollback_deadline
            }
            None => false,
        }
    }

    /// Mark expired, non-terminal proposals as `Expired`.
    ///
    /// Bounded by [`MAX_SWEEP_PROPOSALS`] to cap gas. Returns how many
    /// proposals were transitioned.
    pub fn sweep_expired_proposals(env: Env, caller: Address) -> Result<u32, UpgradeError> {
        require_governance_member(&env, &caller)?;
        let admin = caller.clone();
        let now = env.ledger().timestamp();
        let next_id = next_proposal_id(&env);
        let mut swept = 0u32;

        let mut id = 1u64;
        while id < next_id && swept < MAX_SWEEP_PROPOSALS {
            if let Some(mut proposal) = env
                .storage()
                .persistent()
                .get::<DataKey, UpgradeProposal>(&DataKey::Proposal(id))
            {
                if !proposal.status.is_terminal() && now > proposal.expires_at {
                    proposal.status = ProposalStatus::Expired;
                    save_proposal(&env, &proposal);
                    swept += 1;
                }
            }
            id += 1;
        }

        env.events().publish(
            (symbol_short!("upgrade"), symbol_short!("swept")),
            ExpiredProposalsSweptEvent { swept, admin },
        );

        Ok(swept)
    }

    /// Estimate gas costs for a migration plan.
    pub fn estimate_migration_gas(env: Env, migration_plan: MigrationPlan) -> u64 {
        estimate_migration_gas(&env, &migration_plan)
    }

    /// Get the proposal id that will be assigned to the next proposal.
    pub fn next_proposal_id(env: Env) -> u64 {
        next_proposal_id(&env)
    }

    /// Get all version history (for debugging/auditing).
    pub fn get_version_history(env: Env) -> Vec<ContractVersion> {
        let mut history = Vec::new(&env);
        let mut i = index.len();
        while i > 0 {
            i -= 1;
            let tag = index.get_unchecked(i);
            if let Some(v) = env
                .storage()
                .persistent()
                .get::<DataKey, ContractVersion>(&DataKey::Version(tag))
            {
                history.push_back(v);
            }
        }
        history
    }
}

#[cfg(test)]
mod tests;

fn estimate_migration_gas(_env: &Env, migration_plan: &MigrationPlan) -> u64 {
    let base_cost = GAS_UPGRADE_BASE;
    let item_cost = GAS_MIGRATION_PER_ITEM * migration_plan.estimated_items as u64;

    // Add overhead for each migration step
    let step_overhead = (migration_plan.pre_migration_checks.len()
        + migration_plan.data_transformations.len()
        + migration_plan.post_migration_validations.len()) as u64
        * GAS_MIGRATION_STEP_OVERHEAD;

    base_cost + item_cost + step_overhead
}

#[cfg(test)]
mod contract_tests {
    use super::*;
    use soroban_sdk::{
        testutils::{Address as _, Ledger as _},
        BytesN, Env,
    };

    fn create_test_env() -> (Env, UpgradeManagerClient<'static>, Address) {
        let env = Env::default();
        env.ledger().set_sequence_number(1);
        env.mock_all_auths();
        let contract_id = env.register(UpgradeManager, ());
        let client = UpgradeManagerClient::new(&env, &contract_id);
        let admin = Address::generate(&env);
        (env, client, admin)
    }

    fn test_wasm_hash(env: &Env, seed: u8) -> BytesN<32> {
        let mut bytes = [0u8; 32];
        bytes[0] = seed;
        BytesN::from_array(env, &bytes)
    }

    #[test]
    fn test_initialize_upgrade_manager() {
        let (env, client, admin) = create_test_env();
        let initial_hash = test_wasm_hash(&env, 1);

        client.initialize(&admin, &String::from_str(&env, "1.0.0"), &initial_hash);

        assert_eq!(client.get_admin(), Some(admin));

        let version = client.get_current_version().unwrap();
        assert_eq!(version.version, String::from_str(&env, "1.0.0"));
        assert_eq!(version.wasm_hash, initial_hash);
    }

    #[test]
    fn test_propose_and_execute_upgrade() {
        let (env, client, admin) = create_test_env();
        let initial_hash = test_wasm_hash(&env, 1);
        let new_hash = test_wasm_hash(&env, 2);

        client.initialize(&admin, &String::from_str(&env, "1.0.0"), &initial_hash);

        let migration_plan = MigrationPlan {
            pre_migration_checks: Vec::new(&env),
            data_transformations: Vec::new(&env),
            post_migration_validations: Vec::new(&env),
            estimated_items: 10,
        };

        // Propose upgrade
        let result = client.try_propose_upgrade(
            &String::from_str(&env, "2.0.0"),
            &new_hash,
            &String::from_str(&env, "Major upgrade"),
            &migration_plan,
        );
        assert!(result.is_ok());

        // Validate proposal
        let gas_estimate = client.validate_proposal();
        assert!(gas_estimate > 0);

        // Execute upgrade
        let result = client.try_execute_upgrade();
        assert!(result.is_ok());

        let new_version = client.get_current_version().unwrap();
        assert_eq!(new_version.version, String::from_str(&env, "2.0.0"));
        assert_eq!(new_version.wasm_hash, new_hash);
    }

    #[test]
    fn test_rollback_within_window() {
        let (env, client, admin) = create_test_env();
        let initial_hash = test_wasm_hash(&env, 1);
        let new_hash = test_wasm_hash(&env, 2);

        client.initialize(&admin, &String::from_str(&env, "1.0.0"), &initial_hash);

        let migration_plan = MigrationPlan {
            pre_migration_checks: Vec::new(&env),
            data_transformations: Vec::new(&env),
            post_migration_validations: Vec::new(&env),
            estimated_items: 5,
        };

        // Perform upgrade
        client.propose_upgrade(
            &String::from_str(&env, "2.0.0"),
            &new_hash,
            &String::from_str(&env, "Test upgrade"),
            &migration_plan,
        );
        client.validate_proposal();
        client.execute_upgrade();

        // Check rollback is available
        assert!(client.can_rollback());

        // Perform rollback
        let result = client.try_rollback_upgrade();
        assert!(result.is_ok());

        // Verify we're back to original version
        let current = client.get_current_version().unwrap();
        assert_eq!(current.version, String::from_str(&env, "1.0.0"));
        assert_eq!(current.wasm_hash, initial_hash);

        // Verify rollback is no longer available
        assert!(!client.can_rollback());
    }

    #[test]
    fn test_rollback_after_deadline() {
        let (env, client, admin) = create_test_env();
        let initial_hash = test_wasm_hash(&env, 1);
        let new_hash = test_wasm_hash(&env, 2);

        client.initialize(&admin, &String::from_str(&env, "1.0.0"), &initial_hash);

        let migration_plan = MigrationPlan {
            pre_migration_checks: Vec::new(&env),
            data_transformations: Vec::new(&env),
            post_migration_validations: Vec::new(&env),
            estimated_items: 5,
        };

        // Perform upgrade
        client.propose_upgrade(
            &String::from_str(&env, "2.0.0"),
            &new_hash,
            &String::from_str(&env, "Test upgrade"),
            &migration_plan,
        );
        client.validate_proposal();
        client.execute_upgrade();

        // Advance ledger past rollback deadline
        let current_seq = env.ledger().sequence();
        env.ledger()
            .set_sequence_number(current_seq + ROLLBACK_WINDOW_LEDGERS + 1);

        // Rollback should fail
        let result = client.try_rollback_upgrade();
        assert_eq!(result, Err(Ok(UpgradeError::RollbackDeadlineExpired)));
    }

    fn empty_plan(env: &Env) -> MigrationPlan {
        MigrationPlan {
            pre_migration_checks: Vec::new(env),
            data_transformations: Vec::new(env),
            post_migration_validations: Vec::new(env),
            estimated_items: 0,
        }
    }

    #[test]
    fn propose_upgrade_uses_semver_precedence() {
        // (current, proposed, expected result of propose_upgrade)
        let cases: &[(&str, &str, Result<(), UpgradeError>)] = &[
            ("1.9.0", "1.10.0", Ok(())),
            ("1.99.0", "1.100.0", Ok(())),
            ("2.0.0", "10.0.0", Ok(())),
            ("1.0.0-rc.1", "1.0.0", Ok(())),
            ("1.0.0", "1.0.0-rc.1", Err(UpgradeError::DowngradeNotAllowed)),
            ("1.0.0", "1.0.0", Err(UpgradeError::DowngradeNotAllowed)),
            ("1.0.1", "1.0.0", Err(UpgradeError::DowngradeNotAllowed)),
            ("1.0", "1.0.0.1", Ok(())),
            ("1.0.0", "1.x.0", Err(UpgradeError::MalformedVersion)),
            ("1.0.0", "", Err(UpgradeError::MalformedVersion)),
        ];
        for (current, proposed, expected) in cases {
            let (env, client, admin) = create_test_env();
            client.initialize(&admin, &String::from_str(&env, current), &test_wasm_hash(&env, 1));
            let result = client.try_propose_upgrade(
                &String::from_str(&env, proposed),
                &test_wasm_hash(&env, 2),
                &String::from_str(&env, "upgrade"),
                &empty_plan(&env),
            );
            let actual = match result {
                Ok(_) => Ok(()),
                Err(Ok(e)) => Err(e),
                Err(Err(_)) => panic!("host error"),
            };
            assert_eq!(actual, *expected, "{} -> {}", current, proposed);
        }
    }

    #[test]
    fn execute_upgrade_invokes_swap_with_proposed_hash() {
        let (env, client, admin) = create_test_env();
        let initial_hash = test_wasm_hash(&env, 1);
        let new_hash = test_wasm_hash(&env, 2);
        client.initialize(&admin, &String::from_str(&env, "1.9.0"), &initial_hash);

        let calls = env.as_contract(&client.address, || mock_swap_calls(&env));
        assert_eq!(calls.len(), 0);
        assert_eq!(
            env.as_contract(&client.address, || stored_wasm_hash(&env)),
            Some(initial_hash.clone())
        );

        client.propose_upgrade(
            &String::from_str(&env, "1.10.0"),
            &new_hash,
            &String::from_str(&env, "upgrade"),
            &empty_plan(&env),
        );
        client.validate_proposal();
        client.execute_upgrade();

        let calls = env.as_contract(&client.address, || mock_swap_calls(&env));
        assert_eq!(calls.len(), 1);
        assert_eq!(calls.get(0).unwrap(), new_hash);
        assert_eq!(
            env.as_contract(&client.address, || stored_wasm_hash(&env)),
            Some(new_hash)
        );

        client.rollback_upgrade();
        let calls = env.as_contract(&client.address, || mock_swap_calls(&env));
        assert_eq!(calls.len(), 2);
        assert_eq!(calls.get(1).unwrap(), initial_hash);
    }

    #[test]
    fn test_negative_auth_initialize() {
        let env = Env::default();
        env.ledger().set_sequence_number(1);
        env.mock_auths(&[]);
        let contract_id = env.register(UpgradeManager, ());
        let client = UpgradeManagerClient::new(&env, &contract_id);
        let admin = Address::generate(&env);
        let initial_hash = test_wasm_hash(&env, 1);
        assert!(client
            .try_initialize(&admin, &String::from_str(&env, "1.0.0"), &initial_hash)
            .is_err());
    }

    #[test]
    fn test_gas_estimation() {
        let (env, client, _admin) = create_test_env();

        let mut migration_plan = MigrationPlan {
            pre_migration_checks: Vec::new(&env),
            data_transformations: Vec::new(&env),
            post_migration_validations: Vec::new(&env),
            estimated_items: 100,
        };

        migration_plan
            .pre_migration_checks
            .push_back(String::from_str(&env, "check1"));
        migration_plan
            .data_transformations
            .push_back(String::from_str(&env, "transform1"));
        migration_plan
            .post_migration_validations
            .push_back(String::from_str(&env, "validate1"));

        let gas_estimate = client.estimate_migration_gas(&migration_plan);

        let expected = GAS_UPGRADE_BASE + (GAS_MIGRATION_PER_ITEM * 100) + (3 * 5000);
        assert_eq!(gas_estimate, expected);
    }

    #[test]
    fn test_version_history_newest_first() {
        let (env, client, admin) = create_test_env();
        client.initialize(
            &admin,
            &String::from_str(&env, "1.0.0"),
            &test_wasm_hash(&env, 1),
        );

        let migration_plan = MigrationPlan {
            pre_migration_checks: Vec::new(&env),
            data_transformations: Vec::new(&env),
            post_migration_validations: Vec::new(&env),
            estimated_items: 0,
        };
        client.propose_upgrade(
            &String::from_str(&env, "2.0.0"),
            &test_wasm_hash(&env, 2),
            &String::from_str(&env, "Upgrade"),
            &migration_plan,
        );
        client.validate_proposal();
        client.execute_upgrade();

        let history = client.get_version_history();
        assert_eq!(history.len(), 2);
        assert_eq!(
            history.get_unchecked(0).version,
            String::from_str(&env, "2.0.0")
        );
        assert_eq!(
            history.get_unchecked(1).version,
            String::from_str(&env, "1.0.0")
        );
    }

    // ========================================================================
    // Negative Authorization Tests (Issue #549)
    // ========================================================================

    #[test]
    fn negative_auth_set_admin() {
        let (env, client, admin) = create_test_env();
        let initial_hash = test_wasm_hash(&env, 1);
        client.initialize(&admin, &String::from_str(&env, "1.0.0"), &initial_hash);

        let intruder = Address::generate(&env);
        env.mock_auths(&[]);

        let result = client.try_set_admin(&intruder);
        assert_eq!(result, Err(Ok(UpgradeError::Unauthorized)));
    }

    #[test]
    fn negative_auth_pause() {
        let (env, client, admin) = create_test_env();
        let initial_hash = test_wasm_hash(&env, 1);
        client.initialize(&admin, &String::from_str(&env, "1.0.0"), &initial_hash);

        env.mock_auths(&[]);

        let result = client.try_pause();
        assert_eq!(result, Err(Ok(UpgradeError::Unauthorized)));
    }

    #[test]
    fn negative_auth_unpause() {
        let (env, client, admin) = create_test_env();
        let initial_hash = test_wasm_hash(&env, 1);
        client.initialize(&admin, &String::from_str(&env, "1.0.0"), &initial_hash);

        env.mock_all_auths();
        client.pause();

        env.mock_auths(&[]);

        let result = client.try_unpause();
        assert_eq!(result, Err(Ok(UpgradeError::Unauthorized)));
    }

    #[test]
    fn negative_auth_propose_upgrade() {
        let (env, client, admin) = create_test_env();
        let initial_hash = test_wasm_hash(&env, 1);
        let new_hash = test_wasm_hash(&env, 2);
        client.initialize(&admin, &String::from_str(&env, "1.0.0"), &initial_hash);

        let migration_plan = MigrationPlan {
            pre_migration_checks: Vec::new(&env),
            data_transformations: Vec::new(&env),
            post_migration_validations: Vec::new(&env),
            estimated_items: 10,
        };

        env.mock_auths(&[]);

        let result = client.try_propose_upgrade(
            &String::from_str(&env, "2.0.0"),
            &new_hash,
            &String::from_str(&env, "Unauthorized upgrade"),
            &migration_plan,
        );
        assert_eq!(result, Err(Ok(UpgradeError::Unauthorized)));
    }

    #[test]
    fn negative_auth_validate_proposal() {
        let (env, client, admin) = create_test_env();
        let initial_hash = test_wasm_hash(&env, 1);
        let new_hash = test_wasm_hash(&env, 2);
        client.initialize(&admin, &String::from_str(&env, "1.0.0"), &initial_hash);

        let migration_plan = MigrationPlan {
            pre_migration_checks: Vec::new(&env),
            data_transformations: Vec::new(&env),
            post_migration_validations: Vec::new(&env),
            estimated_items: 10,
        };

        env.mock_all_auths();
        client.propose_upgrade(
            &String::from_str(&env, "2.0.0"),
            &new_hash,
            &String::from_str(&env, "Test upgrade"),
            &migration_plan,
        );

        env.mock_auths(&[]);

        let result = client.try_validate_proposal();
        assert_eq!(result, Err(Ok(UpgradeError::Unauthorized)));
    }

    #[test]
    fn negative_auth_execute_upgrade() {
        let (env, client, admin) = create_test_env();
        let initial_hash = test_wasm_hash(&env, 1);
        let new_hash = test_wasm_hash(&env, 2);
        client.initialize(&admin, &String::from_str(&env, "1.0.0"), &initial_hash);

        let migration_plan = MigrationPlan {
            pre_migration_checks: Vec::new(&env),
            data_transformations: Vec::new(&env),
            post_migration_validations: Vec::new(&env),
            estimated_items: 10,
        };

        env.mock_all_auths();
        client.propose_upgrade(
            &String::from_str(&env, "2.0.0"),
            &new_hash,
            &String::from_str(&env, "Test upgrade"),
            &migration_plan,
        );
        client.validate_proposal();

        env.mock_auths(&[]);

        let result = client.try_execute_upgrade();
        assert_eq!(result, Err(Ok(UpgradeError::Unauthorized)));
    }

    #[test]
    fn negative_auth_rollback_upgrade() {
        let (env, client, admin) = create_test_env();
        let initial_hash = test_wasm_hash(&env, 1);
        let new_hash = test_wasm_hash(&env, 2);
        client.initialize(&admin, &String::from_str(&env, "1.0.0"), &initial_hash);

        let migration_plan = MigrationPlan {
            pre_migration_checks: Vec::new(&env),
            data_transformations: Vec::new(&env),
            post_migration_validations: Vec::new(&env),
            estimated_items: 5,
        };

        env.mock_all_auths();
        client.propose_upgrade(
            &String::from_str(&env, "2.0.0"),
            &new_hash,
            &String::from_str(&env, "Test upgrade"),
            &migration_plan,
        );
        client.validate_proposal();
        client.execute_upgrade();

        env.mock_auths(&[]);

        let result = client.try_rollback_upgrade();
        assert_eq!(result, Err(Ok(UpgradeError::Unauthorized)));
    }

    #[test]
    fn test_set_admin_and_auth() {
        let (env, client, admin) = create_test_env();
        let initial_hash = test_wasm_hash(&env, 1);
        client.initialize(&admin, &String::from_str(&env, "1.0.0"), &initial_hash);

        let new_admin = Address::generate(&env);
        client.set_admin(&new_admin);
        assert_eq!(client.get_admin(), Some(new_admin));
    }

    #[test]
    fn test_pause_blocks_operations() {
        let (env, client, admin) = create_test_env();
        let initial_hash = test_wasm_hash(&env, 1);
        client.initialize(&admin, &String::from_str(&env, "1.0.0"), &initial_hash);

        assert!(!client.is_paused());
        client.pause();
        assert!(client.is_paused());

        let migration_plan = MigrationPlan {
            pre_migration_checks: Vec::new(&env),
            data_transformations: Vec::new(&env),
            post_migration_validations: Vec::new(&env),
            estimated_items: 5,
        };

        let res = client.try_propose_upgrade(
            &String::from_str(&env, "2.0.0"),
            &test_wasm_hash(&env, 2),
            &String::from_str(&env, "Paused upgrade"),
            &migration_plan,
        );
        assert_eq!(res, Err(Ok(UpgradeError::ContractPaused)));

        client.unpause();
        assert!(!client.is_paused());
    }

    #[test]
    fn test_propose_downgrade_fails() {
        let (env, client, admin) = create_test_env();
        let initial_hash = test_wasm_hash(&env, 1);
        client.initialize(&admin, &String::from_str(&env, "2.0.0"), &initial_hash);

        let migration_plan = MigrationPlan {
            pre_migration_checks: Vec::new(&env),
            data_transformations: Vec::new(&env),
            post_migration_validations: Vec::new(&env),
            estimated_items: 5,
        };

        // Proposing 1.0.0 when current is 2.0.0 fails
        let res = client.try_propose_upgrade(
            &String::from_str(&env, "1.0.0"),
            &test_wasm_hash(&env, 2),
            &String::from_str(&env, "Downgrade"),
            &migration_plan,
        );
        assert_eq!(res, Err(Ok(UpgradeError::DowngradeNotAllowed)));
    }

    #[test]
    fn test_execute_unvalidated_proposal_fails() {
        let (env, client, admin) = create_test_env();
        let initial_hash = test_wasm_hash(&env, 1);
        client.initialize(&admin, &String::from_str(&env, "1.0.0"), &initial_hash);

        let migration_plan = MigrationPlan {
            pre_migration_checks: Vec::new(&env),
            data_transformations: Vec::new(&env),
            post_migration_validations: Vec::new(&env),
            estimated_items: 5,
        };

        client.propose_upgrade(
            &String::from_str(&env, "2.0.0"),
            &test_wasm_hash(&env, 2),
            &String::from_str(&env, "Unvalidated"),
            &migration_plan,
        );

        // Execute without validate_proposal fails
        let res = client.try_execute_upgrade();
        assert_eq!(res, Err(Ok(UpgradeError::ProposalNotValidated)));
    }
}
