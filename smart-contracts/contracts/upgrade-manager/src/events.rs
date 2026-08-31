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

/// Event emitted when upgrade is proposed
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct UpgradeProposedEvent {
    pub version: String,
    pub wasm_hash: BytesN<32>,
    pub proposer: Address,
    pub description: String,
}

/// Event emitted when upgrade proposal is validated
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct UpgradeValidatedEvent {
    pub version: String,
    pub estimated_gas: u64,
    pub validation_results: Vec<String>,
}

/// Event emitted when upgrade is applied
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct UpgradeAppliedEvent {
    pub old_version: String,
    pub new_version: String,
    pub wasm_hash: BytesN<32>,
    pub admin: Address,
}

/// Event emitted when upgrade is rolled back
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct UpgradeRolledBackEvent {
    pub reverted_version: String,
    pub restored_version: String,
    pub admin: Address,
}

/// Event emitted during migration progress
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct MigrationProgressEvent {
    pub phase: String,
    pub items_processed: u32,
    pub total_items: u32,
    pub gas_used: u64,
}

/// Event emitted when migration completes
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct MigrationCompleteEvent {
    pub version: String,
    pub items_migrated: u32,
    pub total_gas_used: u64,
    pub success: bool,
}
