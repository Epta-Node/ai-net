//! # Data Types for Error Registry

use soroban_sdk::{contracttype, Address, BytesN, String, Symbol};

/// Severity classification for registered errors.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ErrorSeverity {
    Info = 0,
    Warning = 1,
    Error = 2,
    Fatal = 3,
}

/// Typed error definition stored in the registry with XDR-compatible encoding.
/// Enables off-chain clients to decode contract error codes to human-readable
/// messages without querying the resolver at runtime.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ErrorDefinition {
    /// Numeric error code emitted by the contract.
    pub code: u32,
    /// Address of the contract that emits this error.
    pub contract: Address,
    /// Short symbolic name, e.g. "InsufficientBond".
    pub name: Symbol,
    /// Human-readable message template, e.g. "Bond of {actual} is below minimum {required}".
    pub message_template: String,
    /// Severity level for client-side triage.
    pub severity: ErrorSeverity,
}

/// XDR-serializable envelope for a batch of error definitions.
/// Used by the TypeScript decoder to deserialize a contract's full error set.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ErrorDefinitionSet {
    pub contract: Address,
    pub definitions: soroban_sdk::Vec<ErrorDefinition>,
    pub schema_version: u32,
}

/// A single error report stored on-chain.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ErrorRecord {
    pub error_code: u32,
    pub message: Symbol,
    pub agent_id: Symbol,
    pub created_at: u64,
    pub expires_at: u64,
}

/// Statistics returned by cleanup_expired_errors.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CleanupStats {
    pub scanned: u32,
    pub removed: u32,
    pub remaining: u32,
}

/// Detailed record of a contract upgrade or rollback event stored on-chain.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct UpgradeRecord {
    pub old_version: String,
    pub new_version: String,
    pub wasm_hash: BytesN<32>,
    pub admin: Address,
    pub upgrade_ledger: u32,
    pub timestamp: u64,
}

/// Version tracking metadata for contract upgrades.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct VersionInfo {
    pub version: String,
    pub build_hash: BytesN<32>,
    pub updated_at: u64,
}
