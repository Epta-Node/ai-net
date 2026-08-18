#![no_std]

//! # Agent Registry Contract
//!
//! On-chain registry for AI agents with batch-optimized registration and
//! error-resolution paths.
//!
//! ## Batch semantics
//!
//! `register_agents` and `resolve_errors` validate the entire batch before
//! writing storage. If any item fails validation, no writes are committed.
//!
//! ## Important authorization rule
//!
//! When implementing batch operations that require authorization, do not call
//! `require_auth()` multiple times for the same address in one transaction.
//! Unique owners are collected and authorized exactly once.

mod events;

use soroban_sdk::{
    contract, contracterror, contractimpl, contracttype, symbol_short, Address, BytesN, Env, Map,
    String, Symbol, Val, Vec,
};

// ─── Limits ──────────────────────────────────────────────────────────────────

#[allow(dead_code)]
const MAX_AGENT_ID: u32 = 64;

const MAX_METADATA_ENTRIES: u32 = 16;

#[allow(dead_code)]
const MAX_METADATA_VALUE_SIZE: u32 = 256;

#[allow(dead_code)]
const MAX_TOTAL_AGENT_STORAGE: u32 = 4096;

// ─── Gas budget constants ────────────────────────────────────────────────────

/// Fixed overhead charged once per transaction invocation.
pub const GAS_TX_OVERHEAD: u64 = 40_000;

/// Full cost of a single `register_agent`.
pub const GAS_REGISTER_AGENT: u64 = 100_000;

/// Marginal cost of each additional agent in a batch.
pub const GAS_REGISTER_AGENT_MARGINAL: u64 = 55_556;

/// Full cost of a single error resolution.
pub const GAS_RESOLVE_ERROR: u64 = 50_000;

/// Marginal cost of each additional error resolution in a batch.
pub const GAS_RESOLVE_ERROR_MARGINAL: u64 = 30_000;

/// Default TTL threshold.
pub const TTL_THRESHOLD: u32 = 100_000;

/// Target TTL after extension.
pub const TTL_EXTEND_TO: u32 = 535_680;

// ─── Types ───────────────────────────────────────────────────────────────────

/// Input / stored agent record.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AgentRecord {
    pub id: Symbol,
    pub capability: Symbol,
    pub price_stroops: i128,
    pub endpoint: String,
    pub owner: Address,
    pub metadata: Map<Symbol, Val>,
}

/// Aggregate view of an agent's standing.
#[contracttype]
#[derive(Clone)]
pub struct AgentHealth {
    pub agent_id: Symbol,
    pub exists: bool,
    pub frozen: bool,
    pub error_count: u32,
}

/// How an on-chain error was closed.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum Resolution {
    Fixed,
    Ignored,
    Escalated,
}

/// Persistent error entry.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ErrorEntry {
    pub id: BytesN<32>,
    pub reporter: Address,
    pub message: String,
    pub resolved: bool,
    pub resolution: Resolution,
}

/// Empirical gas budget parameters.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct GasConfig {
    pub tx_overhead: u64,
    pub register_agent: u64,
    pub register_agent_marginal: u64,
    pub resolve_error: u64,
    pub resolve_error_marginal: u64,
}

impl GasConfig {
    pub fn default_config() -> Self {
        Self {
            tx_overhead: GAS_TX_OVERHEAD,
            register_agent: GAS_REGISTER_AGENT,
            register_agent_marginal: GAS_REGISTER_AGENT_MARGINAL,
            resolve_error: GAS_RESOLVE_ERROR,
            resolve_error_marginal: GAS_RESOLVE_ERROR_MARGINAL,
        }
    }
}

#[contracttype]
#[derive(Clone)]
pub enum DataKey {
    Admin,
    Paused,
    Agent(Symbol),
    CapabilityIndex(Symbol),
    FrozenAgent(Symbol),
    ErrorRecord(BytesN<32>),
    GasConfig,
}

/// Per-item result for batch registration.
///
/// The error is represented as a raw `u32` contract error code because
/// contract error types cannot be nested directly inside another
/// `#[contracttype]` enum.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum BatchResult {
    Ok(Symbol),
    Err(u32),
}

/// Per-item result for batch error resolution.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum VoidBatchResult {
    Ok,
    Err(u32),
}

/// Contract errors.
#[contracterror]
#[derive(Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum Error {
    NotFound = 1,
    Unauthorized = 2,
    AlreadyExists = 3,
    ContractPaused = 4,
    AgentFrozen = 5,
    NotAdmin = 6,
    AlreadyResolved = 7,
    DuplicateInBatch = 8,

    /// Price must be strictly greater than zero.
    InvalidPrice = 9,

    /// Agent record contains invalid data.
    InvalidRecord = 10,
}

impl Error {
    /// Recover the typed error from a raw contract error code.
    pub fn from_code(code: u32) -> Option<Self> {
        match code {
            1 => Some(Self::NotFound),
            2 => Some(Self::Unauthorized),
            3 => Some(Self::AlreadyExists),
            4 => Some(Self::ContractPaused),
            5 => Some(Self::AgentFrozen),
            6 => Some(Self::NotAdmin),
            7 => Some(Self::AlreadyResolved),
            8 => Some(Self::DuplicateInBatch),
            9 => Some(Self::InvalidPrice),
            10 => Some(Self::InvalidRecord),
            _ => None,
        }
    }
}

#[contract]
pub struct AgentRegistryContract;

// ─── Helpers ─────────────────────────────────────────────────────────────────

fn gas_config(env: &Env) -> GasConfig {
    env.storage()
        .instance()
        .get(&DataKey::GasConfig)
        .unwrap_or_else(GasConfig::default_config)
}

/// Extend TTL for a persistent entry if it exists.
fn extend_ttl_for_key(env: &Env, key: &DataKey) {
    if env.storage().persistent().has(key) {
        env.storage()
            .persistent()
            .extend_ttl(key, TTL_THRESHOLD, TTL_EXTEND_TO);
    }
}

/// Extend TTL for multiple persistent entries.
fn extend_ttl_batch(env: &Env, keys: &Vec<DataKey>) {
    for key in keys.iter() {
        extend_ttl_for_key(env, &key);
    }
}

/// Append an agent ID to the capability index.
fn append_capability_index(env: &Env, capability: &Symbol, agent_id: &Symbol) {
    let cap_key = DataKey::CapabilityIndex(capability.clone());

    let mut ids: Vec<Symbol> = env
        .storage()
        .persistent()
        .get(&cap_key)
        .unwrap_or_else(|| Vec::new(env));

    ids.push_back(agent_id.clone());

    env.storage().persistent().set(&cap_key, &ids);

    extend_ttl_for_key(env, &cap_key);
}

/// Returns true if an agent ID has already appeared in the batch.
fn is_duplicate_in_batch(
    agents: &Vec<AgentRecord>,
    index: u32,
    id: &Symbol,
) -> bool {
    let mut seen = 0u32;

    for i in 0..=index {
        if let Some(agent) = agents.get(i) {
            if agent.id == *id {
                seen += 1;

                if seen > 1 {
                    return true;
                }
            }
        }
    }

    false
}

/// Returns true if an error ID has already appeared in the batch.
fn is_duplicate_error_id(
    ids: &Vec<BytesN<32>>,
    index: u32,
    id: &BytesN<32>,
) -> bool {
    let mut seen = 0u32;

    for i in 0..=index {
        if let Some(other) = ids.get(i) {
            if other == *id {
                seen += 1;

                if seen > 1 {
                    return true;
                }
            }
        }
    }

    false
}

/// Ensure the contract isn't paused.
fn require_not_paused(env: &Env) -> Result<(), Error> {
    let paused: bool = env
        .storage()
        .instance()
        .get(&DataKey::Paused)
        .unwrap_or(false);

    if paused {
        return Err(Error::ContractPaused);
    }

    Ok(())
}

/// Require the configured admin to authorize the operation.
fn require_admin(env: &Env) -> Result<Address, Error> {
    let admin: Address = env
        .storage()
        .instance()
        .get(&DataKey::Admin)
        .ok_or(Error::NotAdmin)?;

    admin.require_auth();

    Ok(admin)
}

/// Ensure an agent isn't frozen.
fn require_not_frozen(env: &Env, agent_id: &Symbol) -> Result<(), Error> {
    let frozen: bool = env
        .storage()
        .persistent()
        .get(&DataKey::FrozenAgent(agent_id.clone()))
        .unwrap_or(false);

    if frozen {
        return Err(Error::AgentFrozen);
    }

    Ok(())
}

/// Validate an agent record.
fn validate_record(_env: &Env, record: &AgentRecord) -> Result<(), Error> {
    // Critical validation:
    // Prices must always be strictly positive.
    if record.price_stroops <= 0 {
        return Err(Error::InvalidPrice);
    }

    if record.metadata.len() > MAX_METADATA_ENTRIES {
        return Err(Error::InvalidRecord);
    }

    Ok(())
}

// ─── Contract implementation ─────────────────────────────────────────────────

#[contractimpl]
impl AgentRegistryContract {
    // ── Initialization / administration ──────────────────────────────────────

    pub fn initialize(
        env: Env,
        admin: Address,
    ) -> Result<(), Error> {
        if env.storage().instance().has(&DataKey::Admin) {
            return Err(Error::AlreadyExists);
        }

        env.storage()
            .instance()
            .set(&DataKey::Admin, &admin);

        env.storage()
            .instance()
            .set(&DataKey::Paused, &false);

        Ok(())
    }

    pub fn set_admin(
        env: Env,
        new_admin: Address,
    ) -> Result<(), Error> {
        require_admin(&env)?;

        env.storage()
            .instance()
            .set(&DataKey::Admin, &new_admin);

        Ok(())
    }

    pub fn get_admin(env: Env) -> Option<Address> {
        env.storage()
            .instance()
            .get(&DataKey::Admin)
    }

    pub fn pause(env: Env) -> Result<(), Error> {
        require_admin(&env)?;

        env.storage()
            .instance()
            .set(&DataKey::Paused, &true);

        env.events().publish(
            (
                symbol_short!("registry"),
                symbol_short!("paused"),
            ),
            (),
        );

        Ok(())
    }

    pub fn unpause(env: Env) -> Result<(), Error> {
        require_admin(&env)?;

        env.storage()
            .instance()
            .set(&DataKey::Paused, &false);

        env.events().publish(
            (
                symbol_short!("registry"),
                symbol_short!("unpaused"),
            ),
            (),
        );

        Ok(())
    }

    pub fn is_paused(env: Env) -> bool {
        env.storage()
            .instance()
            .get(&DataKey::Paused)
            .unwrap_or(false)
    }

    // ── Agent freezing ───────────────────────────────────────────────────────

    pub fn freeze_agent(
        env: Env,
        agent_id: Symbol,
    ) -> Result<(), Error> {
        require_admin(&env)?;

        env.storage()
            .persistent()
            .set(
                &DataKey::FrozenAgent(agent_id.clone()),
                &true,
            );

        env.events().publish(
            (
                symbol_short!("registry"),
                symbol_short!("freeze"),
            ),
            agent_id,
        );

        Ok(())
    }

    pub fn unfreeze_agent(
        env: Env,
        agent_id: Symbol,
    ) -> Result<(), Error> {
        require_admin(&env)?;

        env.storage()
            .persistent()
            .set(
                &DataKey::FrozenAgent(agent_id.clone()),
                &false,
            );

        env.events().publish(
            (
                symbol_short!("registry"),
                symbol_short!("unfreeze"),
            ),
            agent_id,
        );

        Ok(())
    }

    pub fn is_agent_frozen(
        env: Env,
        agent_id: Symbol,
    ) -> bool {
        env.storage()
            .persistent()
            .get(&DataKey::FrozenAgent(agent_id))
            .unwrap_or(false)
    }

    // ── Agent registration ───────────────────────────────────────────────────

    pub fn register_agent(
        env: Env,
        record: AgentRecord,
    ) -> Result<(), Error> {
        require_not_paused(&env)?;

        require_not_frozen(&env, &record.id)?;

        // The owner must authorize registration.
        record.owner.require_auth();

        // Validate price and metadata before writing.
        validate_record(&env, &record)?;

        let agent_key = DataKey::Agent(record.id.clone());

        if env.storage().persistent().has(&agent_key) {
            return Err(Error::AlreadyExists);
        }

        append_capability_index(
            &env,
            &record.capability,
            &record.id,
        );

        env.storage()
            .persistent()
            .set(&agent_key, &record);

        extend_ttl_for_key(&env, &agent_key);

        Ok(())
    }

    /// Batch-register agents atomically.
    pub fn register_agents(
        env: Env,
        agents: Vec<AgentRecord>,
    ) -> Vec<BatchResult> {
        let mut results: Vec<BatchResult> = Vec::new(&env);

        let mut all_ok = true;

        // Contract-level pause applies to the entire batch.
        if require_not_paused(&env).is_err() {
            for _ in 0..agents.len() {
                results.push_back(
                    BatchResult::Err(Error::ContractPaused as u32),
                );
            }

            return results;
        }

        // ── Phase 0: authorize each unique owner exactly once ────────────────

        let mut unique_owners: Vec<Address> = Vec::new(&env);

        for i in 0..agents.len() {
            let record = agents.get(i).unwrap();

            let mut already_seen = false;

            for j in 0..unique_owners.len() {
                if unique_owners.get(j).unwrap() == record.owner {
                    already_seen = true;
                    break;
                }
            }

            if !already_seen {
                unique_owners.push_back(record.owner.clone());
            }
        }

        for i in 0..unique_owners.len() {
            unique_owners
                .get(i)
                .unwrap()
                .require_auth();
        }

        // ── Phase 1: validate everything ─────────────────────────────────────

        for i in 0..agents.len() {
            let record = agents.get(i).unwrap();

            // Validate price and metadata.
            if let Err(error) = validate_record(&env, &record) {
                results.push_back(
                    BatchResult::Err(error as u32),
                );

                all_ok = false;
                continue;
            }

            // Check frozen state.
            if require_not_frozen(&env, &record.id).is_err() {
                results.push_back(
                    BatchResult::Err(Error::AgentFrozen as u32),
                );

                all_ok = false;
                continue;
            }

            // Check duplicates inside this batch.
            if is_duplicate_in_batch(
                &agents,
                i,
                &record.id,
            ) {
                results.push_back(
                    BatchResult::Err(
                        Error::DuplicateInBatch as u32,
                    ),
                );

                all_ok = false;
                continue;
            }

            // Check existing storage.
            let agent_key =
                DataKey::Agent(record.id.clone());

            if env.storage().persistent().has(&agent_key) {
                results.push_back(
                    BatchResult::Err(
                        Error::AlreadyExists as u32,
                    ),
                );

                all_ok = false;
                continue;
            }

            results.push_back(
                BatchResult::Ok(record.id.clone()),
            );
        }

        // Empty batch or validation failure means no writes.
        if !all_ok || agents.is_empty() {
            return results;
        }

        // ── Phase 2: commit ──────────────────────────────────────────────────

        let mut ttl_keys: Vec<DataKey> = Vec::new(&env);

        for i in 0..agents.len() {
            let record = agents.get(i).unwrap();

            let agent_key =
                DataKey::Agent(record.id.clone());

            append_capability_index(
                &env,
                &record.capability,
                &record.id,
            );

            env.storage()
                .persistent()
                .set(&agent_key, &record);

            ttl_keys.push_back(agent_key);
        }

        extend_ttl_batch(&env, &ttl_keys);

        results
    }

    // ── Agent lookup ─────────────────────────────────────────────────────────

    pub fn lookup_agents(
        env: Env,
        capability: Symbol,
    ) -> Vec<AgentRecord> {
        let cap_key =
            DataKey::CapabilityIndex(capability);

        let ids: Vec<Symbol> = env
            .storage()
            .persistent()
            .get(&cap_key)
            .unwrap_or_else(|| Vec::new(&env));

        extend_ttl_for_key(&env, &cap_key);

        let mut records: Vec<AgentRecord> =
            Vec::new(&env);

        let mut ttl_keys: Vec<DataKey> =
            Vec::new(&env);

        for id in ids.iter() {
            let agent_key =
                DataKey::Agent(id.clone());

            if let Some(record) =
                env.storage().persistent().get(&agent_key)
            {
                ttl_keys.push_back(agent_key);
                records.push_back(record);
            }
        }

        extend_ttl_batch(&env, &ttl_keys);

        records
    }

    // ── Deregistration ──────────────────────────────────────────────────────

    pub fn deregister_agent(
        env: Env,
        agent_id: Symbol,
    ) -> Result<(), Error> {
        require_not_paused(&env)?;

        let agent_key =
            DataKey::Agent(agent_id.clone());

        let record: AgentRecord = env
            .storage()
            .persistent()
            .get(&agent_key)
            .ok_or(Error::NotFound)?;

        record.owner.require_auth();

        let cap_key =
            DataKey::CapabilityIndex(
                record.capability.clone(),
            );

        let ids: Vec<Symbol> = env
            .storage()
            .persistent()
            .get(&cap_key)
            .unwrap_or_else(|| Vec::new(&env));

        let mut updated: Vec<Symbol> =
            Vec::new(&env);

        for id in ids.iter() {
            if id != agent_id {
                updated.push_back(id);
            }
        }

        env.storage()
            .persistent()
            .set(&cap_key, &updated);

        env.storage()
            .persistent()
            .remove(&agent_key);

        Ok(())
    }

    // ── Agent health ─────────────────────────────────────────────────────────

    pub fn get_agent_health(
        env: Env,
        agent_id: Symbol,
    ) -> AgentHealth {
        let exists = env
            .storage()
            .persistent()
            .has(&DataKey::Agent(agent_id.clone()));

        let frozen = env
            .storage()
            .persistent()
            .get(&DataKey::FrozenAgent(agent_id.clone()))
            .unwrap_or(false);

        // Error resolver integration can be added later.
        let error_count = 0;

        AgentHealth {
            agent_id,
            exists,
            frozen,
            error_count,
        }
    }

    // ── Pricing ──────────────────────────────────────────────────────────────

    pub fn update_pricing(
        env: Env,
        agent_id: Symbol,
        new_price: i128,
    ) -> Result<(), Error> {
        require_not_paused(&env)?;

        require_not_frozen(&env, &agent_id)?;

        // Critical validation:
        // zero and negative prices are invalid.
        if new_price <= 0 {
            return Err(Error::InvalidPrice);
        }

        let agent_key =
            DataKey::Agent(agent_id.clone());

        let mut record: AgentRecord = env
            .storage()
            .persistent()
            .get(&agent_key)
            .ok_or(Error::NotFound)?;

        record.owner.require_auth();

        record.price_stroops = new_price;

        env.storage()
            .persistent()
            .set(&agent_key, &record);

        extend_ttl_for_key(&env, &agent_key);

        env.events().publish(
            (
                symbol_short!("registry"),
                symbol_short!("price_upd"),
            ),
            (agent_id, new_price),
        );

        Ok(())
    }

    // ── Error reporting ──────────────────────────────────────────────────────

    pub fn report_error(
        env: Env,
        error_id: BytesN<32>,
        reporter: Address,
        message: String,
    ) -> Result<(), Error> {
        reporter.require_auth();

        let key =
            DataKey::ErrorRecord(error_id.clone());

        if env.storage().persistent().has(&key) {
            return Err(Error::AlreadyExists);
        }

        let entry = ErrorEntry {
            id: error_id,
            reporter,
            message,
            resolved: false,

            // Default value until resolution occurs.
            resolution: Resolution::Fixed,
        };

        env.storage()
            .persistent()
            .set(&key, &entry);

        extend_ttl_for_key(&env, &key);

        Ok(())
    }

    // ── Batch error resolution ───────────────────────────────────────────────

    pub fn resolve_errors(
        env: Env,
        error_ids: Vec<BytesN<32>>,
        resolution: Resolution,
    ) -> Result<Vec<VoidBatchResult>, Error> {
        require_admin(&env)?;

        let mut results: Vec<VoidBatchResult> =
            Vec::new(&env);

        let mut all_ok = true;

        // ── Phase 1: validate ────────────────────────────────────────────────

        for i in 0..error_ids.len() {
            let id = error_ids.get(i).unwrap();

            if is_duplicate_error_id(
                &error_ids,
                i,
                &id,
            ) {
                results.push_back(
                    VoidBatchResult::Err(
                        Error::DuplicateInBatch as u32,
                    ),
                );

                all_ok = false;
                continue;
            }

            let key =
                DataKey::ErrorRecord(id.clone());

            let entry: Option<ErrorEntry> =
                env.storage()
                    .persistent()
                    .get(&key);

            match entry {
                None => {
                    results.push_back(
                        VoidBatchResult::Err(
                            Error::NotFound as u32,
                        ),
                    );

                    all_ok = false;
                }

                Some(entry) if entry.resolved => {
                    results.push_back(
                        VoidBatchResult::Err(
                            Error::AlreadyResolved as u32,
                        ),
                    );

                    all_ok = false;
                }

                Some(_) => {
                    results.push_back(
                        VoidBatchResult::Ok,
                    );
                }
            }
        }

        // Empty batch or validation failure.
        if !all_ok || error_ids.is_empty() {
            return Ok(results);
        }

        // ── Phase 2: commit ──────────────────────────────────────────────────

        let mut ttl_keys: Vec<DataKey> =
            Vec::new(&env);

        for i in 0..error_ids.len() {
            let id = error_ids.get(i).unwrap();

            let key =
                DataKey::ErrorRecord(id);

            let mut entry: ErrorEntry = env
                .storage()
                .persistent()
                .get(&key)
                .unwrap();

            entry.resolved = true;
            entry.resolution = resolution.clone();

            env.storage()
                .persistent()
                .set(&key, &entry);

            ttl_keys.push_back(key);
        }

        extend_ttl_batch(&env, &ttl_keys);

        Ok(results)
    }

    pub fn get_error(
        env: Env,
        error_id: BytesN<32>,
    ) -> Option<ErrorEntry> {
        env.storage()
            .persistent()
            .get(&DataKey::ErrorRecord(error_id))
    }

    // ── Gas estimation ───────────────────────────────────────────────────────

    pub fn estimate_gas(
        env: Env,
        operation: String,
        count: u32,
    ) -> u64 {
        if count == 0 {
            return 0;
        }

        let cfg = gas_config(&env);

        let register_agent =
            String::from_str(&env, "register_agent");

        let register_agents =
            String::from_str(&env, "register_agents");

        let resolve_error =
            String::from_str(&env, "resolve_error");

        let resolve_errors =
            String::from_str(&env, "resolve_errors");

        if operation == register_agent
            || operation == register_agents
        {
            cfg.register_agent
                + cfg
                    .register_agent_marginal
                    .saturating_mul(
                        (count - 1) as u64
                    )
        } else if operation == resolve_error
            || operation == resolve_errors
        {
            cfg.resolve_error
                + cfg
                    .resolve_error_marginal
                    .saturating_mul(
                        (count - 1) as u64
                    )
        } else {
            0
        }
    }

    pub fn set_gas_config(
        env: Env,
        config: GasConfig,
    ) -> Result<(), Error> {
        require_admin(&env)?;

        env.storage()
            .instance()
            .set(&DataKey::GasConfig, &config);

        env.storage()
            .instance()
            .extend_ttl(
                TTL_THRESHOLD,
                TTL_EXTEND_TO,
            );

        Ok(())
    }

    pub fn get_gas_config(env: Env) -> GasConfig {
        gas_config(&env)
    }
}

// ─── Unit tests ──────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    extern crate std;

    use super::*;

    use soroban_sdk::{
        testutils::Address as _,
        Address,
        BytesN,
        Env,
    };

    fn setup() -> (
        Env,
        AgentRegistryContractClient<'static>,
    ) {
        let env = Env::default();

        env.mock_all_auths();

        let contract_id =
            env.register(AgentRegistryContract, ());

        let client =
            AgentRegistryContractClient::new(
                &env,
                &contract_id,
            );

        (env, client)
    }

    fn setup_with_admin() -> (
        Env,
        AgentRegistryContractClient<'static>,
        Address,
    ) {
        let env = Env::default();

        env.mock_all_auths();

        let contract_id =
            env.register(AgentRegistryContract, ());

        let client =
            AgentRegistryContractClient::new(
                &env,
                &contract_id,
            );

        let admin =
            Address::generate(&env);

        client.initialize(&admin);

        (env, client, admin)
    }

    fn make_record(
        env: &Env,
        id: &str,
        capability: &str,
        owner: Address,
    ) -> AgentRecord {
        AgentRecord {
            id: Symbol::new(env, id),
            capability: Symbol::new(env, capability),
            price_stroops: 1_000,
            endpoint: String::from_str(
                env,
                "https://agent.example.com",
            ),
            owner,
            metadata: Map::new(env),
        }
    }

    fn error_id(
        env: &Env,
        byte: u8,
    ) -> BytesN<32> {
        let mut arr = [0u8; 32];

        arr[0] = byte;

        BytesN::from_array(env, &arr)
    }

    // ── Price validation ─────────────────────────────────────────────────────

    #[test]
    fn register_rejects_zero_price() {
        let (env, client) = setup();

        let owner =
            Address::generate(&env);

        let agent = AgentRecord {
            id: Symbol::new(
                &env,
                "agent_zero",
            ),
            capability: Symbol::new(
                &env,
                "test",
            ),
            price_stroops: 0,
            endpoint: String::from_str(
                &env,
                "https://agent.example.com",
            ),
            owner,
            metadata: Map::new(&env),
        };

        let result =
            client.try_register_agent(&agent);

        assert_eq!(
            result,
            Err(Ok(Error::InvalidPrice))
        );
    }

    #[test]
    fn register_rejects_negative_price() {
        let (env, client) = setup();

        let owner =
            Address::generate(&env);

        let agent = AgentRecord {
            id: Symbol::new(
                &env,
                "agent_negative",
            ),
            capability: Symbol::new(
                &env,
                "test",
            ),
            price_stroops: -100,
            endpoint: String::from_str(
                &env,
                "https://agent.example.com",
            ),
            owner,
            metadata: Map::new(&env),
        };

        let result =
            client.try_register_agent(&agent);

        assert_eq!(
            result,
            Err(Ok(Error::InvalidPrice))
        );
    }

    #[test]
    fn update_pricing_rejects_zero_price() {
        let (env, client) = setup();

        let owner =
            Address::generate(&env);

        let agent =
            make_record(
                &env,
                "agent_update_zero",
                "test",
                owner,
            );

        client.register_agent(&agent);

        let result =
            client.try_update_pricing(
                &agent.id,
                &0i128,
            );

        assert_eq!(
            result,
            Err(Ok(Error::InvalidPrice))
        );
    }

    #[test]
    fn update_pricing_rejects_negative_price() {
        let (env, client) = setup();

        let owner =
            Address::generate(&env);

        let agent =
            make_record(
                &env,
                "agent_update_negative",
                "test",
                owner,
            );

        client.register_agent(&agent);

        let result =
            client.try_update_pricing(
                &agent.id,
                &-50i128,
            );

        assert_eq!(
            result,
            Err(Ok(Error::InvalidPrice))
        );
    }

    #[test]
    fn update_pricing_accepts_positive_price() {
        let (env, client) = setup();

        let owner =
            Address::generate(&env);

        let agent =
            make_record(
                &env,
                "agent_update_valid",
                "test",
                owner,
            );

        client.register_agent(&agent);

        client.update_pricing(
            &agent.id,
            &5_000i128,
        );

        let results =
            client.lookup_agents(
                &Symbol::new(&env, "test"),
            );

        assert_eq!(
            results.get(0).unwrap().price_stroops,
            5_000
        );
    }

    // ── Registration ─────────────────────────────────────────────────────────

    #[test]
    fn register_and_lookup() {
        let (env, client) = setup();

        let owner =
            Address::generate(&env);

        let record =
            make_record(
                &env,
                "agent1",
                "research",
                owner,
            );

        let result =
            client.try_register_agent(&record);

        assert!(result.is_ok());
        assert!(result.unwrap().is_ok());

        let results =
            client.lookup_agents(
                &Symbol::new(&env, "research"),
            );

        assert_eq!(results.len(), 1);

        assert_eq!(
            results.get(0).unwrap().id,
            Symbol::new(&env, "agent1")
        );
    }

    #[test]
    fn register_duplicate_returns_error() {
        let (env, client) = setup();

        let owner =
            Address::generate(&env);

        let record =
            make_record(
                &env,
                "duplicate",
                "research",
                owner,
            );

        client.register_agent(&record);

        assert_eq!(
            client.try_register_agent(&record),
            Err(Ok(Error::AlreadyExists))
        );
    }

    #[test]
    fn lookup_multiple_agents_same_capability() {
        let (env, client) = setup();

        client.register_agent(
            &make_record(
                &env,
                "a1",
                "analytics",
                Address::generate(&env),
            ),
        );

        client.register_agent(
            &make_record(
                &env,
                "a2",
                "analytics",
                Address::generate(&env),
            ),
        );

        client.register_agent(
            &make_record(
                &env,
                "a3",
                "other",
                Address::generate(&env),
            ),
        );

        let results =
            client.lookup_agents(
                &Symbol::new(
                    &env,
                    "analytics",
                ),
            );

        assert_eq!(results.len(), 2);
    }

    #[test]
    fn lookup_unknown_capability_returns_empty() {
        let (env, client) = setup();

        let results =
            client.lookup_agents(
                &Symbol::new(
                    &env,
                    "unknown",
                ),
            );

        assert_eq!(results.len(), 0);
    }

    // ── Deregistration ───────────────────────────────────────────────────────

    #[test]
    fn deregister_removes_from_index() {
        let (env, client) = setup();

        let owner =
            Address::generate(&env);

        client.register_agent(
            &make_record(
                &env,
                "agent2",
                "coding",
                owner,
            ),
        );

        client.deregister_agent(
            &Symbol::new(&env, "agent2"),
        );

        let results =
            client.lookup_agents(
                &Symbol::new(&env, "coding"),
            );

        assert_eq!(results.len(), 0);
    }

    #[test]
    fn deregister_missing_agent_returns_not_found() {
        let (env, client) = setup();

        assert_eq!(
            client.try_deregister_agent(
                &Symbol::new(&env, "ghost"),
            ),
            Err(Ok(Error::NotFound))
        );
    }

    // ── Administration ───────────────────────────────────────────────────────

    #[test]
    fn initialize_sets_admin() {
        let (env, client) = setup();

        let admin =
            Address::generate(&env);

        client.initialize(&admin);

        assert_eq!(
            client.get_admin(),
            Some(admin)
        );
    }

    #[test]
    fn initialize_cannot_be_called_twice() {
        let (env, client) = setup();

        let admin =
            Address::generate(&env);

        client.initialize(&admin);

        assert_eq!(
            client.try_initialize(
                &Address::generate(&env)
            ),
            Err(Ok(Error::AlreadyExists))
        );
    }

    #[test]
    fn set_admin_changes_admin() {
        let (env, client, _) =
            setup_with_admin();

        let new_admin =
            Address::generate(&env);

        client.set_admin(&new_admin);

        assert_eq!(
            client.get_admin(),
            Some(new_admin)
        );
    }

    #[test]
    fn pause_blocks_register_agent() {
        let (env, client, _) =
            setup_with_admin();

        client.pause();

        let owner =
            Address::generate(&env);

        let result =
            client.try_register_agent(
                &make_record(
                    &env,
                    "paused",
                    "test",
                    owner,
                ),
            );

        assert_eq!(
            result,
            Err(Ok(Error::ContractPaused))
        );
    }

    #[test]
    fn pause_blocks_update_pricing() {
        let (env, client, _) =
            setup_with_admin();

        let owner =
            Address::generate(&env);

        let agent =
            make_record(
                &env,
                "paused_update",
                "test",
                owner,
            );

        client.register_agent(&agent);
        client.pause();

        let result =
            client.try_update_pricing(
                &agent.id,
                &999i128,
            );

        assert_eq!(
            result,
            Err(Ok(Error::ContractPaused))
        );
    }

    #[test]
    fn unpause_allows_operations() {
        let (env, client, _) =
            setup_with_admin();

        client.pause();
        client.unpause();

        let owner =
            Address::generate(&env);

        client.register_agent(
            &make_record(
                &env,
                "agent_unpause",
                "test",
                owner,
            ),
        );

        let results =
            client.lookup_agents(
                &Symbol::new(&env, "test"),
            );

        assert_eq!(results.len(), 1);
    }

    // ── Freeze ───────────────────────────────────────────────────────────────

    #[test]
    fn freeze_agent_blocks_update_pricing() {
        let (env, client, _) =
            setup_with_admin();

        let owner =
            Address::generate(&env);

        let agent =
            make_record(
                &env,
                "agent_frozen",
                "test",
                owner,
            );

        client.register_agent(&agent);

        client.freeze_agent(&agent.id);

        let result =
            client.try_update_pricing(
                &agent.id,
                &777i128,
            );

        assert_eq!(
            result,
            Err(Ok(Error::AgentFrozen))
        );
    }

    #[test]
    fn freeze_agent_blocks_register() {
        let (env, client, _) =
            setup_with_admin();

        let id =
            Symbol::new(
                &env,
                "frozen_id",
            );

        client.freeze_agent(&id);

        let owner =
            Address::generate(&env);

        let result =
            client.try_register_agent(
                &make_record(
                    &env,
                    "frozen_id",
                    "test",
                    owner,
                ),
            );

        assert_eq!(
            result,
            Err(Ok(Error::AgentFrozen))
        );
    }

    #[test]
    fn unfreeze_agent_allows_operations() {
        let (env, client, _) =
            setup_with_admin();

        let owner =
            Address::generate(&env);

        let agent =
            make_record(
                &env,
                "agent_unfreeze",
                "test",
                owner,
            );

        client.register_agent(&agent);

        client.freeze_agent(&agent.id);

        assert!(
            client.is_agent_frozen(&agent.id)
        );

        client.unfreeze_agent(&agent.id);

        assert!(
            !client.is_agent_frozen(&agent.id)
        );

        client.update_pricing(
            &agent.id,
            &333i128,
        );

        let results =
            client.lookup_agents(
                &Symbol::new(&env, "test"),
            );

        assert_eq!(
            results.get(0).unwrap().price_stroops,
            333
        );
    }

    // ── Batch registration ───────────────────────────────────────────────────

    #[test]
    fn register_agents_batch_success() {
        let (env, client) = setup();

        let mut agents =
            Vec::new(&env);

        agents.push_back(
            make_record(
                &env,
                "b1",
                "research",
                Address::generate(&env),
            ),
        );

        agents.push_back(
            make_record(
                &env,
                "b2",
                "research",
                Address::generate(&env),
            ),
        );

        agents.push_back(
            make_record(
                &env,
                "b3",
                "coding",
                Address::generate(&env),
            ),
        );

        let results =
            client.register_agents(&agents);

        assert_eq!(results.len(), 3);

        assert_eq!(
            results.get(0).unwrap(),
            BatchResult::Ok(
                Symbol::new(&env, "b1")
            )
        );

        assert_eq!(
            results.get(1).unwrap(),
            BatchResult::Ok(
                Symbol::new(&env, "b2")
            )
        );

        assert_eq!(
            results.get(2).unwrap(),
            BatchResult::Ok(
                Symbol::new(&env, "b3")
            )
        );

        assert_eq!(
            client
                .lookup_agents(
                    &Symbol::new(
                        &env,
                        "research"
                    )
                )
                .len(),
            2
        );

        assert_eq!(
            client
                .lookup_agents(
                    &Symbol::new(
                        &env,
                        "coding"
                    )
                )
                .len(),
            1
        );
    }

    #[test]
    fn register_agents_rejects_invalid_price_atomically() {
        let (env, client) = setup();

        let mut agents =
            Vec::new(&env);

        agents.push_back(
            make_record(
                &env,
                "valid",
                "research",
                Address::generate(&env),
            ),
        );

        let invalid = AgentRecord {
            id: Symbol::new(
                &env,
                "invalid",
            ),
            capability: Symbol::new(
                &env,
                "coding",
            ),
            price_stroops: 0,
            endpoint: String::from_str(
                &env,
                "https://agent.example.com",
            ),
            owner: Address::generate(&env),
            metadata: Map::new(&env),
        };

        agents.push_back(invalid);

        let results =
            client.register_agents(&agents);

        assert_eq!(
            results.get(0).unwrap(),
            BatchResult::Ok(
                Symbol::new(&env, "valid")
            )
        );

        assert_eq!(
            results.get(1).unwrap(),
            BatchResult::Err(
                Error::InvalidPrice as u32
            )
        );

        // Atomic: valid agent must not have been written.
        assert_eq!(
            client
                .lookup_agents(
                    &Symbol::new(
                        &env,
                        "research"
                    )
                )
                .len(),
            0
        );
    }

    #[test]
    fn register_agents_partial_failure_is_atomic() {
        let (env, client) = setup();

        client.register_agent(
            &make_record(
                &env,
                "exists",
                "research",
                Address::generate(&env),
            ),
        );

        let mut agents =
            Vec::new(&env);

        agents.push_back(
            make_record(
                &env,
                "new1",
                "research",
                Address::generate(&env),
            ),
        );

        agents.push_back(
            make_record(
                &env,
                "exists",
                "research",
                Address::generate(&env),
            ),
        );

        agents.push_back(
            make_record(
                &env,
                "new2",
                "coding",
                Address::generate(&env),
            ),
        );

        let results =
            client.register_agents(&agents);

        assert_eq!(
            results.get(0).unwrap(),
            BatchResult::Ok(
                Symbol::new(&env, "new1")
            )
        );

        assert_eq!(
            results.get(1).unwrap(),
            BatchResult::Err(
                Error::AlreadyExists as u32
            )
        );

        assert_eq!(
            results.get(2).unwrap(),
            BatchResult::Ok(
                Symbol::new(&env, "new2")
            )
        );

        // Atomic rollback.
        assert_eq!(
            client
                .lookup_agents(
                    &Symbol::new(
                        &env,
                        "research"
                    )
                )
                .len(),
            1
        );

        assert_eq!(
            client
                .lookup_agents(
                    &Symbol::new(
                        &env,
                        "coding"
                    )
                )
                .len(),
            0
        );
    }

    #[test]
    fn register_agents_duplicate_ids_in_batch() {
        let (env, client) = setup();

        let mut agents =
            Vec::new(&env);

        agents.push_back(
            make_record(
                &env,
                "same",
                "research",
                Address::generate(&env),
            ),
        );

        agents.push_back(
            make_record(
                &env,
                "same",
                "coding",
                Address::generate(&env),
            ),
        );

        let results =
            client.register_agents(&agents);

        assert_eq!(
            results.get(0).unwrap(),
            BatchResult::Ok(
                Symbol::new(&env, "same")
            )
        );

        assert_eq!(
            results.get(1).unwrap(),
            BatchResult::Err(
                Error::DuplicateInBatch as u32
            )
        );

        assert_eq!(
            client
                .lookup_agents(
                    &Symbol::new(
                        &env,
                        "research"
                    )
                )
                .len(),
            0
        );

        assert_eq!(
            client
                .lookup_agents(
                    &Symbol::new(
                        &env,
                        "coding"
                    )
                )
                .len(),
            0
        );
    }

    #[test]
    fn register_agents_empty_batch() {
        let (env, client) = setup();

        let agents =
            Vec::new(&env);

        let results =
            client.register_agents(&agents);

        assert_eq!(results.len(), 0);
    }

    // ── Error resolution ─────────────────────────────────────────────────────

    #[test]
    fn resolve_errors_batch_success() {
        let (env, client, _) =
            setup_with_admin();

        let reporter =
            Address::generate(&env);

        let id1 =
            error_id(&env, 1);

        let id2 =
            error_id(&env, 2);

        let id3 =
            error_id(&env, 3);

        client.report_error(
            &id1,
            &reporter,
            &String::from_str(
                &env,
                "timeout",
            ),
        );

        client.report_error(
            &id2,
            &reporter,
            &String::from_str(
                &env,
                "auth",
            ),
        );

        client.report_error(
            &id3,
            &reporter,
            &String::from_str(
                &env,
                "budget",
            ),
        );

        let mut ids =
            Vec::new(&env);

        ids.push_back(id1.clone());
        ids.push_back(id2.clone());
        ids.push_back(id3.clone());

        let results =
            client.resolve_errors(
                &ids,
                &Resolution::Fixed,
            );

        assert_eq!(results.len(), 3);

        assert_eq!(
            results.get(0).unwrap(),
            VoidBatchResult::Ok
        );

        assert_eq!(
            results.get(1).unwrap(),
            VoidBatchResult::Ok
        );

        assert_eq!(
            results.get(2).unwrap(),
            VoidBatchResult::Ok
        );

        let error =
            client.get_error(&id1).unwrap();

        assert!(error.resolved);

        assert_eq!(
            error.resolution,
            Resolution::Fixed
        );
    }

    #[test]
    fn resolve_errors_partial_failure_is_atomic() {
        let (env, client, _) =
            setup_with_admin();

        let reporter =
            Address::generate(&env);

        let id1 =
            error_id(&env, 10);

        let missing =
            error_id(&env, 99);

        client.report_error(
            &id1,
            &reporter,
            &String::from_str(
                &env,
                "real",
            ),
        );

        let mut ids =
            Vec::new(&env);

        ids.push_back(id1.clone());
        ids.push_back(missing);

        let results =
            client.resolve_errors(
                &ids,
                &Resolution::Ignored,
            );

        assert_eq!(
            results.get(0).unwrap(),
            VoidBatchResult::Ok
        );

        assert_eq!(
            results.get(1).unwrap(),
            VoidBatchResult::Err(
                Error::NotFound as u32
            )
        );

        let error =
            client.get_error(&id1).unwrap();

        assert!(!error.resolved);
    }

    #[test]
    fn resolve_errors_duplicate_ids_fail_atomically() {
        let (env, client, _) =
            setup_with_admin();

        let reporter =
            Address::generate(&env);

        let id =
            error_id(&env, 50);

        client.report_error(
            &id,
            &reporter,
            &String::from_str(
                &env,
                "duplicate test",
            ),
        );

        let mut ids =
            Vec::new(&env);

        ids.push_back(id.clone());
        ids.push_back(id.clone());

        let results =
            client.resolve_errors(
                &ids,
                &Resolution::Fixed,
            );

        assert_eq!(
            results.get(0).unwrap(),
            VoidBatchResult::Ok
        );

        assert_eq!(
            results.get(1).unwrap(),
            VoidBatchResult::Err(
                Error::DuplicateInBatch as u32
            )
        );

        let error =
            client.get_error(&id).unwrap();

        assert!(!error.resolved);
    }

    // ── Gas estimation ───────────────────────────────────────────────────────

    #[test]
    fn estimate_gas_register_scales_with_count() {
        let (env, client) = setup();

        let one =
            client.estimate_gas(
                &String::from_str(
                    &env,
                    "register_agent",
                ),
                &1,
            );

        let ten =
            client.estimate_gas(
                &String::from_str(
                    &env,
                    "register_agents",
                ),
                &10,
            );

        assert_eq!(
            one,
            GAS_REGISTER_AGENT
        );

        assert_eq!(
            ten,
            GAS_REGISTER_AGENT
                + GAS_REGISTER_AGENT_MARGINAL
                    * 9
        );

        assert!(
            ten < 610_000
        );

        assert!(
            ten < GAS_REGISTER_AGENT * 10
        );
    }

    #[test]
    fn estimate_gas_resolve_scales_with_count() {
        let (env, client) = setup();

        let one =
            client.estimate_gas(
                &String::from_str(
                    &env,
                    "resolve_error",
                ),
                &1,
            );

        let ten =
            client.estimate_gas(
                &String::from_str(
                    &env,
                    "resolve_errors",
                ),
                &10,
            );

        assert_eq!(
            one,
            GAS_RESOLVE_ERROR
        );

        assert_eq!(
            ten,
            GAS_RESOLVE_ERROR
                + GAS_RESOLVE_ERROR_MARGINAL
                    * 9
        );

        assert!(
            ten < GAS_RESOLVE_ERROR * 10
        );
    }

    #[test]
    fn estimate_gas_unknown_operation_is_zero() {
        let (env, client) = setup();

        let result =
            client.estimate_gas(
                &String::from_str(
                    &env,
                    "not_a_real_op",
                ),
                &5,
            );

        assert_eq!(result, 0);
    }

    #[test]
    fn estimate_gas_zero_count_is_zero() {
        let (env, client) = setup();

        let result =
            client.estimate_gas(
                &String::from_str(
                    &env,
                    "register_agents",
                ),
                &0,
            );

        assert_eq!(result, 0);
    }
}