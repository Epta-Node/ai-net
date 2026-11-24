//! # Upgradeable Trait
//!
//! Provides a standard interface for contracts that support safe upgrades.
//! Contracts implementing this trait can integrate with the upgrade manager
//! to provide version tracking, data migration, and rollback capabilities.

use soroban_sdk::{
    contracterror, contracttype, symbol_short, Address, BytesN, Env, String, Symbol, Vec,
};

/// Standard interface for upgradeable contracts
pub trait Upgradeable {
    /// Get the current contract version
    fn get_version(env: Env) -> String;

    /// Get the current WASM hash
    fn get_wasm_hash(env: Env) -> BytesN<32>;

    /// Check if the contract supports upgrades
    fn is_upgradeable(env: Env) -> bool;

    /// Get the upgrade manager contract address (if configured)
    fn get_upgrade_manager(env: Env) -> Option<Address>;

    /// Set the upgrade manager contract address (admin only)
    fn set_upgrade_manager(env: Env, upgrade_manager: Address) -> Result<(), UpgradeableError>;

    /// Execute pre-upgrade validation
    fn pre_upgrade_hook(
        env: Env,
        new_version: String,
        new_wasm_hash: BytesN<32>,
    ) -> Result<Vec<String>, UpgradeableError>;

    /// Execute post-upgrade migration
    fn post_upgrade_hook(
        env: Env,
        old_version: String,
        new_version: String,
    ) -> Result<(), UpgradeableError>;

    /// Get migration plan for upgrading to a new version
    fn get_migration_plan(
        env: Env,
        target_version: String,
    ) -> Result<MigrationMetadata, UpgradeableError>;

    /// Initiate upgrade through upgrade manager
    fn initiate_upgrade(
        env: Env,
        new_version: String,
        new_wasm_hash: BytesN<32>,
        description: String,
    ) -> Result<(), UpgradeableError>;
}

/// Migration metadata for upgrade planning
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct MigrationMetadata {
    pub from_version: String,
    pub to_version: String,
    pub required_checks: Vec<String>,
    pub data_transformations: Vec<String>,
    pub validation_steps: Vec<String>,
    pub estimated_data_items: u32,
    pub is_breaking_change: bool,
    pub rollback_supported: bool,
}

/// Version compatibility information
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct VersionCompatibility {
    pub current_version: String,
    pub target_version: String,
    pub is_compatible: bool,
    pub compatibility_issues: Vec<String>,
    pub migration_required: bool,
}

/// Upgrade status information
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct UpgradeStatus {
    pub current_version: String,
    pub pending_upgrade: Option<String>,
    pub last_upgrade_ledger: u32,
    pub rollback_available: bool,
    pub rollback_deadline: u32,
}

/// Errors specific to upgradeable contracts
#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum UpgradeableError {
    /// Contract does not support upgrades
    NotUpgradeable = 1,
    /// Caller is not authorized for upgrade operations
    Unauthorized = 2,
    /// Version compatibility check failed
    IncompatibleVersion = 3,
    /// Migration validation failed
    MigrationValidationFailed = 4,
    /// Upgrade manager not configured
    NoUpgradeManager = 5,
    /// Pre-upgrade hook failed
    PreUpgradeHookFailed = 6,
    /// Post-upgrade hook failed
    PostUpgradeHookFailed = 7,
    /// Migration plan generation failed
    MigrationPlanFailed = 8,
    /// The Wasm swap is not available in this build
    SwapUnavailable = 9,
}

// ─── Wasm swap ───────────────────────────────────────────────────────────────

/// Instance-storage key holding the Wasm hash the contract is running, as
/// recorded by the last successful [`swap_wasm`] (or [`record_wasm_hash`]).
pub const WASM_HASH_KEY: Symbol = symbol_short!("wasm_hash");

/// Instance-storage key holding every hash passed to the mock deployer, in
/// call order. Only written in test / `testutils` builds.
pub const MOCK_SWAP_KEY: Symbol = symbol_short!("mock_swap");

/// Record the Wasm hash the contract is running (e.g. at deployment).
pub fn record_wasm_hash(env: &Env, hash: &BytesN<32>) {
    env.storage().instance().set(&WASM_HASH_KEY, hash);
}

/// The Wasm hash recorded by the last swap, if any.
pub fn stored_wasm_hash(env: &Env) -> Option<BytesN<32>> {
    env.storage().instance().get(&WASM_HASH_KEY)
}

/// Replace the running contract's Wasm with `hash` and record it.
///
/// * On-chain (`wasm32`, no `testutils`): calls
///   `update_current_contract_wasm`.
/// * Test / `testutils` builds: a mock deployer appends `hash` to
///   [`MOCK_SWAP_KEY`] so tests can assert the swap target, since the test
///   host cannot load a real replacement Wasm.
/// * Any other build (native without `testutils`): returns
///   [`UpgradeableError::SwapUnavailable`] so callers never report an upgrade
///   that did not happen.
pub fn swap_wasm(env: &Env, hash: &BytesN<32>) -> Result<(), UpgradeableError> {
    deploy_wasm(env, hash)?;
    record_wasm_hash(env, hash);
    Ok(())
}

#[cfg(all(target_arch = "wasm32", not(any(test, feature = "testutils"))))]
fn deploy_wasm(env: &Env, hash: &BytesN<32>) -> Result<(), UpgradeableError> {
    env.deployer().update_current_contract_wasm(hash.clone());
    Ok(())
}

#[cfg(any(test, feature = "testutils"))]
fn deploy_wasm(env: &Env, hash: &BytesN<32>) -> Result<(), UpgradeableError> {
    let mut calls: Vec<BytesN<32>> = env
        .storage()
        .instance()
        .get(&MOCK_SWAP_KEY)
        .unwrap_or_else(|| Vec::new(env));
    calls.push_back(hash.clone());
    env.storage().instance().set(&MOCK_SWAP_KEY, &calls);
    Ok(())
}

#[cfg(all(not(target_arch = "wasm32"), not(any(test, feature = "testutils"))))]
fn deploy_wasm(_env: &Env, _hash: &BytesN<32>) -> Result<(), UpgradeableError> {
    Err(UpgradeableError::SwapUnavailable)
}

/// Every hash the mock deployer was asked to swap to (test builds only).
#[cfg(any(test, feature = "testutils"))]
pub fn mock_swap_calls(env: &Env) -> Vec<BytesN<32>> {
    env.storage()
        .instance()
        .get(&MOCK_SWAP_KEY)
        .unwrap_or_else(|| Vec::new(env))
}

/// Utility functions for version comparison and compatibility checking
pub mod version_utils {
    use crate::strutil::starts_with;
    use crate::{UpgradeableError, VersionCompatibility};
    use core::cmp::Ordering;
    use soroban_sdk::{Env, String, Vec};

    /// Semver precedence of two version tags (see
    /// [`crate::strutil::compare_versions`]): numeric components compare as
    /// integers (`"1.10.0"` > `"1.9.0"`) and pre-releases sort below their
    /// release. Malformed tags return [`UpgradeableError::IncompatibleVersion`].
    pub fn compare_versions(v1: &String, v2: &String) -> Result<Ordering, UpgradeableError> {
        crate::strutil::compare_versions(v1, v2).ok_or(UpgradeableError::IncompatibleVersion)
    }

    /// Check if upgrade from one version to another is compatible
    pub fn check_compatibility(
        env: &Env,
        current: String,
        target: String,
    ) -> Result<VersionCompatibility, UpgradeableError> {
        if !crate::strutil::is_valid_version(&current) || !crate::strutil::is_valid_version(&target)
        {
            return Err(UpgradeableError::IncompatibleVersion);
        }

        let mut issues = Vec::new(env);
        let mut is_compatible = true;
        let mut migration_required = false;

        match compare_versions(&current, &target)? {
            Ordering::Less => {
                // Upgrading to newer version - generally compatible
                migration_required = true;
            }
            Ordering::Equal => {
                // Same version - no migration needed
                migration_required = false;
            }
            Ordering::Greater => {
                // Downgrading - not allowed without explicit rollback
                is_compatible = false;
                issues.push_back(String::from_str(env, "Downgrade not allowed"));
            }
        }

        Ok(VersionCompatibility {
            current_version: current,
            target_version: target,
            is_compatible,
            compatibility_issues: issues,
            migration_required,
        })
    }

    /// Generate migration steps based on version difference
    pub fn generate_migration_steps(
        env: &Env,
        from_version: &String,
        to_version: &String,
    ) -> Result<Vec<String>, UpgradeableError> {
        let mut steps = Vec::new(env);

        // Version-based migration planning
        match compare_versions(from_version, to_version)? {
            Ordering::Less => {
                // Upgrading
                if starts_with(from_version, "1.") && starts_with(to_version, "2.") {
                    // Major version upgrade
                    steps.push_back(String::from_str(env, "backup_existing_data"));
                    steps.push_back(String::from_str(env, "validate_data_integrity"));
                    steps.push_back(String::from_str(env, "migrate_storage_format"));
                    steps.push_back(String::from_str(env, "update_schema"));
                    steps.push_back(String::from_str(env, "rebuild_indexes"));
                    steps.push_back(String::from_str(env, "verify_migration"));
                } else {
                    // Minor version upgrade
                    steps.push_back(String::from_str(env, "validate_data_integrity"));
                    steps.push_back(String::from_str(env, "update_metadata_format"));
                    steps.push_back(String::from_str(env, "refresh_indexes"));
                }
            }
            Ordering::Equal => {
                // Same version - minimal validation
                steps.push_back(String::from_str(env, "validate_compatibility"));
            }
            Ordering::Greater => {
                // Downgrade - return error
                return Err(UpgradeableError::IncompatibleVersion);
            }
        }

        Ok(steps)
    }
}

/// Events related to upgradeable contract operations
pub mod events {
    use soroban_sdk::{contracttype, Address, BytesN, String};

    #[contracttype]
    #[derive(Clone, Debug, Eq, PartialEq)]
    pub struct UpgradeManagerSetEvent {
        pub contract: Address,
        pub upgrade_manager: Address,
        pub admin: Address,
    }

    #[contracttype]
    #[derive(Clone, Debug, Eq, PartialEq)]
    pub struct UpgradeInitiatedEvent {
        pub contract: Address,
        pub from_version: String,
        pub to_version: String,
        pub wasm_hash: BytesN<32>,
        pub initiator: Address,
    }

    #[contracttype]
    #[derive(Clone, Debug, Eq, PartialEq)]
    pub struct PreUpgradeHookEvent {
        pub contract: Address,
        pub version: String,
        pub validation_results: soroban_sdk::Vec<String>,
        pub success: bool,
    }

    #[contracttype]
    #[derive(Clone, Debug, Eq, PartialEq)]
    pub struct PostUpgradeHookEvent {
        pub contract: Address,
        pub old_version: String,
        pub new_version: String,
        pub migration_results: soroban_sdk::Vec<String>,
        pub success: bool,
    }
}

/// Macro to help implement basic upgrade functionality
#[macro_export]
macro_rules! impl_upgradeable_basics {
    ($contract:ty, $version:expr) => {
        impl $crate::Upgradeable for $contract {
            fn get_version(env: Env) -> String {
                String::from_str(&env, $version)
            }

            fn is_upgradeable(_env: Env) -> bool {
                true
            }

            /// Hash recorded by the last `swap_wasm` / `record_wasm_hash`;
            /// the all-zero hash means none has been recorded yet.
            fn get_wasm_hash(env: Env) -> BytesN<32> {
                $crate::upgradeable::stored_wasm_hash(&env)
                    .unwrap_or_else(|| BytesN::from_array(&env, &[0u8; 32]))
            }

            // Other methods need custom implementation
        }
    };
}
