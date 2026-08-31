#![no_std]

//! # Upgradeable Trait
//!
//! Provides a standard interface for contracts that support safe upgrades.
//! Contracts implementing this trait can integrate with the upgrade manager
//! to provide version tracking, data migration, and rollback capabilities.

use soroban_sdk::{contracttype, Address, BytesN, Env, String, Vec};

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
#[contracttype]
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
}

impl From<UpgradeableError> for soroban_sdk::Error {
    fn from(err: UpgradeableError) -> Self {
        soroban_sdk::Error::from_contract_error(err as u32)
    }
}

/// Utility functions for version comparison and compatibility checking
pub mod version_utils {
    use crate::{UpgradeableError, VersionCompatibility};
    use soroban_sdk::{Env, String, Vec};

    /// Simple version comparison for strings (semantic versioning approximation)
    /// In production, you would use proper semver parsing
    pub fn compare_versions(v1: &str, v2: &str) -> std::cmp::Ordering {
        v1.cmp(v2)
    }

    /// Check if upgrade from one version to another is compatible
    pub fn check_compatibility(
        env: &Env,
        current: String,
        target: String,
    ) -> Result<VersionCompatibility, UpgradeableError> {
        let current_str = current.to_string();
        let target_str = target.to_string();

        let mut issues = Vec::new(env);
        let mut is_compatible = true;
        let mut migration_required = false;

        // Simple version comparison - in practice would use proper semver
        match current_str.cmp(&target_str) {
            std::cmp::Ordering::Less => {
                // Upgrading to newer version - generally compatible
                migration_required = true;
            }
            std::cmp::Ordering::Equal => {
                // Same version - no migration needed
                migration_required = false;
            }
            std::cmp::Ordering::Greater => {
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
        from_version: &str,
        to_version: &str,
    ) -> Result<Vec<String>, UpgradeableError> {
        let mut steps = Vec::new(env);

        // Simple version-based migration planning
        match from_version.cmp(to_version) {
            std::cmp::Ordering::Less => {
                // Upgrading
                if from_version.starts_with("1.") && to_version.starts_with("2.") {
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
            std::cmp::Ordering::Equal => {
                // Same version - minimal validation
                steps.push_back(String::from_str(env, "validate_compatibility"));
            }
            std::cmp::Ordering::Greater => {
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

            fn get_wasm_hash(env: Env) -> BytesN<32> {
                env.current_contract_address().into() // Placeholder
            }

            // Other methods need custom implementation
        }
    };
}
