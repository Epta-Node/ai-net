#![no_std]

//! # Agent Registry Contract
//!
//! On-chain registry for AI agents with **batch-optimized** registration and
//! error-resolution paths to amortize base transaction fees.
//!
//! ## Gas model (approximate CPU instructions / CU)
//!
//! | Operation            | count=1   | count=10 (batched) | vs 10 separate txs |
//! |----------------------|-----------|--------------------|--------------------|
//! | `register_agent(s)`  | ~100,000  | ~600,000           | 1,000,000          |
//! | `resolve_error(s)`   | ~50,000   | ~320,000           | 500,000            |
//!
//! Shared per-transaction overhead (~40k CU) is paid once in a batch.
//! Marginal cost per extra item is lower than a full single-item invocation.
//! See `docs/gas_costs.md` for the full table and `estimate_gas` for budgeting.
//!
//! ## Batch semantics
//!
//! Both `register_agents` and `resolve_errors` are **atomic**:
//! 1. Validate every item (auth, existence, duplicates in-batch).
//! 2. Collect per-item results.
//! 3. Write storage **only if every item validated successfully**.
//!
//! **IMPORTANT**: When implementing new batch operations that require authorization,
//! never call `require_auth()` multiple times for the same address within a single
//! transaction. Soroban's authorization system prevents this to avoid replay attacks.
//! Instead, collect unique addresses first and authorize each unique address once.
//! See `register_agents` Phase 0 for the correct pattern.
//!
//! Callers inspect the returned `Vec<BatchResult>` / `Vec<VoidBatchResult>`:
//! all-success means the batch committed; any failure means **no** writes occurred.

mod events;

use events::{
    AdminChangedEvent, AgentDeregisteredEvent, AgentRegisteredEvent, ErrorReportedEvent,
    ErrorResolvedEvent, RegistryInitializedEvent,
};
use soroban_sdk::{
    contract, contractimpl, contracttype, symbol_short, Address, BytesN, Env, Map, String, Symbol,
    Val, Vec,
};

#[allow(dead_code)]
const MAX_AGENT_ID: u32 = 64;
const MAX_METADATA_ENTRIES: u32 = 16;
#[allow(dead_code)]
const MAX_METADATA_VALUE_SIZE: u32 = 256;
#[allow(dead_code)]
const MAX_TOTAL_AGENT_STORAGE: u32 = 4096;

// ─── Gas budget constants (empirical, CU / CPU instructions) ─────────────────
// Stored as defaults in contract config; overridable via `set_gas_config`.

/// Fixed overhead charged once per transaction invocation.
pub const GAS_TX_OVERHEAD: u64 = 40_000;
/// Full cost of a single `register_agent` (includes overhead).
pub const GAS_REGISTER_AGENT: u64 = 100_000;
/// Marginal cost of each additional agent in a batch after the first.
/// Chosen so a batch of 10 ≈ 600_000 CU (issue #120 gas analysis).
pub const GAS_REGISTER_AGENT_MARGINAL: u64 = 55_556;
/// Full cost of a single error resolution (includes overhead).
pub const GAS_RESOLVE_ERROR: u64 = 50_000;
/// Marginal cost of each additional error resolution in a batch.
pub const GAS_RESOLVE_ERROR_MARGINAL: u64 = 30_000;

/// Default TTL threshold (ledgers remaining) below which we extend.
pub const TTL_THRESHOLD: u32 = 100_000;
/// Target TTL after extension (~31 days at 5s ledgers: 535_680).
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

/// Aggregate view of an agent's standing, including its error count as
/// tracked by error-resolver. `error_count` is 0 whenever error-resolver
/// isn't configured or the cross-contract call fails, rather than causing
/// this query to fail: health information degrades gracefully.
#[contracttype]
#[derive(Clone)]
pub struct AgentHealth {
    pub agent_id: Symbol,
    pub exists: bool,
    pub frozen: bool,
    pub error_count: u32,
}

/// Alias used by the batch API (`register_agents(agents: Vec<AgentParams>)`).
pub type AgentParams = AgentRecord;

/// How an on-chain error was closed.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
#[repr(u32)]
pub enum Resolution {
    Fixed = 0,
    Ignored = 1,
    Escalated = 2,
}

/// Persistent error entry that can be batch-resolved.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ErrorEntry {
    pub id: BytesN<32>,
    pub reporter: Address,
    pub message: String,
    pub resolved: bool,
    pub resolution: Resolution,
}

/// Empirical gas budget parameters (instance storage).
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

/// Per-item outcome for batch registration (`Ok(agent_id)` / `Err(code)`).
///
/// The failure payload is the raw `u32` error code rather than [`Error`]
/// itself: a `#[contracterror]` type is represented on the wire as a bare
/// status code and cannot be embedded inside a `#[contracttype]`. Use
/// [`Error::from_code`] to recover the typed variant.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum BatchResult {
    Ok(Symbol),
    Err(u32),
}

/// Per-item outcome for batch error resolution. See [`BatchResult`] for why
/// the failure payload is a `u32` code.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum VoidBatchResult {
    Ok,
    Err(u32),
}

#[contracttype]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
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
    InvalidRecord = 9,
}

impl From<Error> for soroban_sdk::Error {
    fn from(err: Error) -> Self {
        soroban_sdk::Error::from_contract_error(err as u32)
    }
}

impl From<soroban_sdk::Error> for Error {
    fn from(err: soroban_sdk::Error) -> Self {
        match err.get_code() {
            1 => Error::NotFound,
            2 => Error::Unauthorized,
            3 => Error::AlreadyExists,
            4 => Error::ContractPaused,
            5 => Error::AgentFrozen,
            6 => Error::NotAdmin,
            7 => Error::AlreadyResolved,
            8 => Error::DuplicateInBatch,
            9 => Error::InvalidRecord,
            _ => Error::NotFound,
        }
    }
}

impl Error {
    /// Recover the typed variant from a raw code as carried by
    /// [`BatchResult::Err`] / [`VoidBatchResult::Err`]. Returns `None` for
    /// codes this contract version doesn't define.
    pub fn from_code(code: u32) -> Option<Self> {
        match code {
            1 => Some(Error::NotFound),
            2 => Some(Error::Unauthorized),
            3 => Some(Error::AlreadyExists),
            4 => Some(Error::ContractPaused),
            5 => Some(Error::AgentFrozen),
            6 => Some(Error::NotAdmin),
            7 => Some(Error::AlreadyResolved),
            8 => Some(Error::DuplicateInBatch),
            9 => Some(Error::InvalidRecord),
            _ => None,
        }
    }
}

impl<'a> From<&'a Error> for soroban_sdk::Error {
    fn from(err: &'a Error) -> Self {
        soroban_sdk::Error::from_contract_error(*err as u32)
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

fn extend_ttl_for_key(env: &Env, key: &DataKey) {
    // Only extend when the entry exists; extend_ttl panics on missing keys.
    if env.storage().persistent().has(key) {
        env.storage()
            .persistent()
            .extend_ttl(key, TTL_THRESHOLD, TTL_EXTEND_TO);
    }
}

/// Extend TTL for a set of persistent keys in one pass (batched rent bump).
fn extend_ttl_batch(env: &Env, keys: &Vec<DataKey>) {
    for key in keys.iter() {
        extend_ttl_for_key(env, &key);
    }
}

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

/// True if `id` appears more than once in `agents` at or before `index`.
fn is_duplicate_in_batch(agents: &Vec<AgentRecord>, index: u32, id: &Symbol) -> bool {
    let mut seen = 0u32;
    for i in 0..=index {
        if let Some(a) = agents.get(i) {
            if a.id == *id {
                seen += 1;
                if seen > 1 {
                    return true;
                }
            }
        }
    }
    false
}

fn is_duplicate_error_id(ids: &Vec<BytesN<32>>, index: u32, id: &BytesN<32>) -> bool {
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

fn require_admin(env: &Env) -> Result<Address, Error> {
    let admin: Address = env
        .storage()
        .instance()
        .get(&DataKey::Admin)
        .ok_or(Error::NotAdmin)?;
    admin.require_auth();
    Ok(admin)
}

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

fn validate_record(_env: &Env, record: &AgentRecord) -> Result<(), Error> {
    if record.metadata.len() > MAX_METADATA_ENTRIES {
        return Err(Error::InvalidRecord);
    }
    Ok(())
}

#[contractimpl]
impl AgentRegistryContract {
    pub fn initialize(env: Env, admin: Address) -> Result<(), Error> {
        if env.storage().instance().has(&DataKey::Admin) {
            return Err(Error::AlreadyExists);
        }
        env.storage().instance().set(&DataKey::Admin, &admin);
        env.storage().instance().set(&DataKey::Paused, &false);

        // Emit (registry, init) so indexers know exactly when the
        // contract became active and who the genesis admin is.
        env.events().publish(
            (symbol_short!("registry"), symbol_short!("init")),
            RegistryInitializedEvent {
                admin: admin.clone(),
            },
        );

        Ok(())
    }

    pub fn set_admin(env: Env, new_admin: Address) -> Result<(), Error> {
        let old_admin = require_admin(&env)?;
        env.storage().instance().set(&DataKey::Admin, &new_admin);

        // Emit (registry, admin_changed) with both old and new admin addresses
        // to provide a complete audit trail for on-chain governance changes.
        env.events().publish(
            (symbol_short!("registry"), symbol_short!("adm_chngd")),
            AdminChangedEvent {
                old_admin,
                new_admin,
            },
        );

        Ok(())
    }

    pub fn pause(env: Env) -> Result<(), Error> {
        require_admin(&env)?;
        env.storage().instance().set(&DataKey::Paused, &true);
        env.events()
            .publish((symbol_short!("registry"), symbol_short!("paused")), ());
        Ok(())
    }

    pub fn unpause(env: Env) -> Result<(), Error> {
        require_admin(&env)?;
        env.storage().instance().set(&DataKey::Paused, &false);
        env.events()
            .publish((symbol_short!("registry"), symbol_short!("unpaused")), ());
        Ok(())
    }

    pub fn is_paused(env: Env) -> bool {
        env.storage()
            .instance()
            .get(&DataKey::Paused)
            .unwrap_or(false)
    }

    pub fn get_admin(env: Env) -> Option<Address> {
        env.storage().instance().get(&DataKey::Admin)
    }

    pub fn freeze_agent(env: Env, agent_id: Symbol) -> Result<(), Error> {
        require_admin(&env)?;
        env.storage()
            .persistent()
            .set(&DataKey::FrozenAgent(agent_id.clone()), &true);
        env.events().publish(
            (symbol_short!("registry"), symbol_short!("freeze")),
            agent_id,
        );
        Ok(())
    }

    pub fn unfreeze_agent(env: Env, agent_id: Symbol) -> Result<(), Error> {
        require_admin(&env)?;
        env.storage()
            .persistent()
            .set(&DataKey::FrozenAgent(agent_id.clone()), &false);
        env.events().publish(
            (symbol_short!("registry"), symbol_short!("unfreeze")),
            agent_id,
        );
        Ok(())
    }

    pub fn is_agent_frozen(env: Env, agent_id: Symbol) -> bool {
        env.storage()
            .persistent()
            .get(&DataKey::FrozenAgent(agent_id))
            .unwrap_or(false)
    }

    pub fn register_agent(env: Env, record: AgentRecord) -> Result<(), Error> {
        require_not_paused(&env)?;
        require_not_frozen(&env, &record.id)?;
        record.owner.require_auth();

        validate_record(&env, &record)?;

        let agent_key = DataKey::Agent(record.id.clone());
        if env.storage().persistent().has(&agent_key) {
            return Err(Error::AlreadyExists);
        }

        append_capability_index(&env, &record.capability, &record.id);
        env.storage().persistent().set(&agent_key, &record);
        extend_ttl_for_key(&env, &agent_key);

        // Emit (registry, agent_registered) so off-chain indexers can
        // immediately detect new agents without polling storage.
        env.events().publish(
            (symbol_short!("registry"), symbol_short!("agent_reg")),
            AgentRegisteredEvent {
                agent_id: record.id.clone(),
                owner: record.owner.clone(),
                capability: record.capability.clone(),
                price_stroops: record.price_stroops,
            },
        );

        Ok(())
    }

    /// Batch-register agents in **one** transaction.
    ///
    /// * Validates every agent first (auth, not already registered, no in-batch
    ///   duplicate ids).
    /// * Returns a per-agent [`BatchResult`].
    /// * Writes storage only when **all** items validate (atomic all-or-nothing).
    /// * On success, extends TTL for every written key in a single pass.
    pub fn register_agents(env: Env, agents: Vec<AgentRecord>) -> Vec<BatchResult> {
        let mut results: Vec<BatchResult> = Vec::new(&env);
        let mut all_ok = true;

        // Contract-level pause applies to the whole batch.
        if require_not_paused(&env).is_err() {
            for _ in 0..agents.len() {
                results.push_back(BatchResult::Err(Error::ContractPaused as u32));
            }
            return results;
        }

        // ── Phase 0: collect unique owners and authorize once per owner ──────
        //
        // Soroban's authorization system prevents calling require_auth() multiple
        // times for the same address within a single transaction to avoid replay
        // attacks. When batch processing agents with the same owner, we must
        // deduplicate authorization calls by collecting unique owners first.
        let mut unique_owners = Vec::new(&env);
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

        // Authorize each unique owner once. Host will reject the whole invocation
        // if any required auth is missing.
        for i in 0..unique_owners.len() {
            unique_owners.get(i).unwrap().require_auth();
        }

        // ── Phase 1: validate (no writes) ────────────────────────────────────

        for i in 0..agents.len() {
            let record = agents.get(i).unwrap();

            // Auth already handled in Phase 0 for all unique owners.

            if require_not_frozen(&env, &record.id).is_err() {
                results.push_back(BatchResult::Err(Error::AgentFrozen as u32));
                all_ok = false;
                continue;
            }

            if is_duplicate_in_batch(&agents, i, &record.id) {
                results.push_back(BatchResult::Err(Error::DuplicateInBatch as u32));
                all_ok = false;
                continue;
            }

            let agent_key = DataKey::Agent(record.id.clone());
            if env.storage().persistent().has(&agent_key) {
                results.push_back(BatchResult::Err(Error::AlreadyExists as u32));
                all_ok = false;
                continue;
            }

            results.push_back(BatchResult::Ok(record.id.clone()));
        }

        // ── Phase 2: abort without writing if any item failed ────────────────
        if !all_ok || agents.is_empty() {
            return results;
        }

        // ── Phase 3: commit all writes + batched TTL extension ───────────────
        let mut ttl_keys: Vec<DataKey> = Vec::new(&env);
        for i in 0..agents.len() {
            let record = agents.get(i).unwrap();
            let agent_key = DataKey::Agent(record.id.clone());
            append_capability_index(&env, &record.capability, &record.id);
            env.storage().persistent().set(&agent_key, &record);
            ttl_keys.push_back(agent_key);

            // Emit one (registry, agent_registered) event per committed agent.
            // Batch callers receive the same event shape as single registration,
            // making the indexer event handler uniform across both code paths.
            env.events().publish(
                (symbol_short!("registry"), symbol_short!("agent_reg")),
                AgentRegisteredEvent {
                    agent_id: record.id.clone(),
                    owner: record.owner.clone(),
                    capability: record.capability.clone(),
                    price_stroops: record.price_stroops,
                },
            );
        }
        extend_ttl_batch(&env, &ttl_keys);

        results
    }

    pub fn lookup_agents(env: Env, capability: Symbol) -> Vec<AgentRecord> {
        let cap_key = DataKey::CapabilityIndex(capability);
        let ids: Vec<Symbol> = env
            .storage()
            .persistent()
            .get(&cap_key)
            .unwrap_or_else(|| Vec::new(&env));

        // Touch / extend the index TTL when used.
        if env.storage().persistent().has(&cap_key) {
            extend_ttl_for_key(&env, &cap_key);
        }

        let mut records = Vec::new(&env);
        let mut ttl_keys: Vec<DataKey> = Vec::new(&env);
        for id in ids.iter() {
            let agent_key = DataKey::Agent(id.clone());
            if let Some(r) = env.storage().persistent().get(&agent_key) {
                ttl_keys.push_back(agent_key);
                records.push_back(r);
            }
        }
        // Batch-extend TTLs for every agent loaded in this lookup.
        extend_ttl_batch(&env, &ttl_keys);
        records
    }

    pub fn deregister_agent(env: Env, agent_id: Symbol) -> Result<(), Error> {
        require_not_paused(&env)?;
        let agent_key = DataKey::Agent(agent_id.clone());
        let record: AgentRecord = env
            .storage()
            .persistent()
            .get(&agent_key)
            .ok_or(Error::NotFound)?;

        record.owner.require_auth();

        let cap_key = DataKey::CapabilityIndex(record.capability.clone());
        let ids: Vec<Symbol> = env
            .storage()
            .persistent()
            .get(&cap_key)
            .unwrap_or_else(|| Vec::new(&env));

        let mut updated = Vec::new(&env);
        for id in ids.iter() {
            if id != agent_id {
                updated.push_back(id);
            }
        }
        env.storage().persistent().set(&cap_key, &updated);
        env.storage().persistent().remove(&agent_key);

        // Emit (registry, agent_deregistered) including owner and capability
        // so indexers can update their capability maps without a storage read.
        env.events().publish(
            (symbol_short!("registry"), symbol_short!("agent_drg")),
            AgentDeregisteredEvent {
                agent_id,
                owner: record.owner.clone(),
                capability: record.capability.clone(),
            },
        );

        Ok(())
    }

    /// Aggregate health view for `agent_id`, including its error count from
    /// error-resolver (0 if error-resolver isn't configured or the
    /// cross-contract call fails — see `AgentHealth`).
    pub fn get_agent_health(env: Env, agent_id: Symbol) -> AgentHealth {
        let exists = env
            .storage()
            .persistent()
            .has(&DataKey::Agent(agent_id.clone()));
        let frozen = env
            .storage()
            .persistent()
            .get(&DataKey::FrozenAgent(agent_id.clone()))
            .unwrap_or(false);

        let error_count = 0;

        AgentHealth {
            agent_id,
            exists,
            frozen,
            error_count,
        }
    }

    pub fn update_pricing(env: Env, agent_id: Symbol, new_price: i128) -> Result<(), Error> {
        require_not_paused(&env)?;
        require_not_frozen(&env, &agent_id)?;
        let agent_key = DataKey::Agent(agent_id.clone());
        let mut record: AgentRecord = env
            .storage()
            .persistent()
            .get(&agent_key)
            .ok_or(Error::NotFound)?;

        record.owner.require_auth();

        record.price_stroops = new_price;
        env.storage().persistent().set(&agent_key, &record);
        extend_ttl_for_key(&env, &agent_key);

        env.events().publish(
            (symbol_short!("registry"), symbol_short!("price_upd")),
            (agent_id, new_price),
        );

        Ok(())
    }

    // ── Error reporting / batch resolution ───────────────────────────────────

    /// Report an operational error (creates an unresolved entry).
    pub fn report_error(
        env: Env,
        error_id: BytesN<32>,
        reporter: Address,
        message: String,
    ) -> Result<(), Error> {
        reporter.require_auth();

        let key = DataKey::ErrorRecord(error_id.clone());
        if env.storage().persistent().has(&key) {
            return Err(Error::AlreadyExists);
        }

        let entry = ErrorEntry {
            id: error_id.clone(),
            reporter: reporter.clone(),
            message,
            resolved: false,
            // Placeholder until resolve_errors overwrites with a real resolution.
            resolution: Resolution::Fixed,
        };
        env.storage().persistent().set(&key, &entry);
        extend_ttl_for_key(&env, &key);

        // Emit (registry, error_reported) so monitoring systems can trigger
        // alerting pipelines without polling contract state.
        env.events().publish(
            (symbol_short!("registry"), symbol_short!("err_rptd")),
            ErrorReportedEvent { error_id, reporter },
        );

        Ok(())
    }

    /// Resolve multiple errors in one transaction (atomic all-or-nothing).
    ///
    /// Validates every id first; writes only if all succeed. Per-item results
    /// are always returned so callers can see which ids failed validation.
    pub fn resolve_errors(
        env: Env,
        error_ids: Vec<BytesN<32>>,
        resolution: Resolution,
    ) -> Result<Vec<VoidBatchResult>, Error> {
        require_admin(&env)?;
        let mut results: Vec<VoidBatchResult> = Vec::new(&env);
        let mut all_ok = true;

        // ── Phase 1: validate ────────────────────────────────────────────────
        for i in 0..error_ids.len() {
            let id = error_ids.get(i).unwrap();

            if is_duplicate_error_id(&error_ids, i, &id) {
                results.push_back(VoidBatchResult::Err(Error::DuplicateInBatch as u32));
                all_ok = false;
                continue;
            }

            let key = DataKey::ErrorRecord(id.clone());
            let entry: Option<ErrorEntry> = env.storage().persistent().get(&key);
            match entry {
                None => {
                    results.push_back(VoidBatchResult::Err(Error::NotFound as u32));
                    all_ok = false;
                }
                Some(e) if e.resolved => {
                    results.push_back(VoidBatchResult::Err(Error::AlreadyResolved as u32));
                    all_ok = false;
                }
                Some(_) => {
                    results.push_back(VoidBatchResult::Ok);
                }
            }
        }

        if !all_ok || error_ids.is_empty() {
            return Ok(results);
        }

        // ── Phase 2: commit ──────────────────────────────────────────────────
        let mut ttl_keys: Vec<DataKey> = Vec::new(&env);
        for i in 0..error_ids.len() {
            let id = error_ids.get(i).unwrap();
            let key = DataKey::ErrorRecord(id.clone());
            let mut entry: ErrorEntry = env.storage().persistent().get(&key).unwrap();
            entry.resolved = true;
            entry.resolution = resolution.clone();
            env.storage().persistent().set(&key, &entry);
            ttl_keys.push_back(key);

            // Emit one (registry, error_resolved) event per resolved error.
            // Batch resolutions produce N events so indexers can track each
            // error's lifecycle independently without scanning storage.
            env.events().publish(
                (symbol_short!("registry"), symbol_short!("err_rslvd")),
                ErrorResolvedEvent {
                    error_id: id,
                    resolution_code: resolution.clone() as u32,
                },
            );
        }
        extend_ttl_batch(&env, &ttl_keys);

        Ok(results)
    }

    /// Fetch a single error entry (for tests / off-chain indexing).
    pub fn get_error(env: Env, error_id: BytesN<32>) -> Option<ErrorEntry> {
        env.storage()
            .persistent()
            .get(&DataKey::ErrorRecord(error_id))
    }

    // ── Gas budget estimation ────────────────────────────────────────────────

    /// Estimate CPU instruction budget for a batch operation.
    ///
    /// `operation` is one of:
    /// - `"register_agent"` / `"register_agents"`
    /// - `"resolve_error"` / `"resolve_errors"`
    ///
    /// Returns `0` for unknown operations. Values come from [`GasConfig`]
    /// (defaults match the tables in `docs/gas_costs.md`).
    pub fn estimate_gas(env: Env, operation: String, count: u32) -> u64 {
        if count == 0 {
            return 0;
        }
        let cfg = gas_config(&env);

        let register_agent = String::from_str(&env, "register_agent");
        let register_agents = String::from_str(&env, "register_agents");
        let resolve_error = String::from_str(&env, "resolve_error");
        let resolve_errors = String::from_str(&env, "resolve_errors");

        if operation == register_agent || operation == register_agents {
            // First item pays full single-call cost; rest pay marginal.
            cfg.register_agent
                + cfg
                    .register_agent_marginal
                    .saturating_mul((count - 1) as u64)
        } else if operation == resolve_error || operation == resolve_errors {
            cfg.resolve_error
                + cfg
                    .resolve_error_marginal
                    .saturating_mul((count - 1) as u64)
        } else {
            0
        }
    }

    /// Override empirical gas parameters stored in instance config.
    pub fn set_gas_config(env: Env, config: GasConfig) -> Result<(), Error> {
        require_admin(&env)?;
        env.storage().instance().set(&DataKey::GasConfig, &config);
        env.storage()
            .instance()
            .extend_ttl(TTL_THRESHOLD, TTL_EXTEND_TO);
        Ok(())
    }

    /// Read the current gas configuration (defaults if never set).
    pub fn get_gas_config(env: Env) -> GasConfig {
        gas_config(&env)
    }
}

// ─── Unit tests ──────────────────────────────────────────────────────────────

#[cfg(test)]
mod test {
    extern crate std;

    use super::*;
    use soroban_sdk::xdr::ToXdr;
    use soroban_sdk::{testutils::Address as _, testutils::Events as _, BytesN, Env, FromVal};

    /// Creates a fresh in-memory test environment with the contract registered.
    ///
    /// Soroban's test Env creates an entirely simulated blockchain in memory —
    /// no real deployment, no network calls, no WASM compilation at test time.
    /// Each call to `Env::default()` + `env.register()` completes in microseconds,
    /// so there is no measurable benefit to sharing Env instances across tests.
    /// Test isolation is preserved by design; snapshot/rollback is unnecessary.
    fn setup() -> (Env, AgentRegistryContractClient<'static>) {
        let env = Env::default();
        env.mock_all_auths();
        let id = env.register(AgentRegistryContract, ());
        let client = AgentRegistryContractClient::new(&env, &id);
        (env, client)
    }

    fn setup_with_admin() -> (Env, AgentRegistryContractClient<'static>, Address) {
        let env = Env::default();
        env.mock_all_auths();
        let id = env.register(AgentRegistryContract, ());
        let client = AgentRegistryContractClient::new(&env, &id);
        let admin = Address::generate(&env);
        client.initialize(&admin);
        (env, client, admin)
    }

    fn make_record(env: &Env, id: &str, capability: &str, owner: Address) -> AgentRecord {
        AgentRecord {
            id: Symbol::new(env, id),
            capability: Symbol::new(env, capability),
            price_stroops: 1_000,
            endpoint: String::from_str(env, "https://agent.example.com"),
            owner,
            metadata: Map::new(env),
        }
    }

    fn error_id(env: &Env, byte: u8) -> BytesN<32> {
        let mut arr = [0u8; 32];
        arr[0] = byte;
        BytesN::from_array(env, &arr)
    }

    // ── Existing single-item tests ───────────────────────────────────────────

    #[test]
    fn register_and_lookup() {
        let (env, client) = setup();
        let owner = Address::generate(&env);
        let record = make_record(&env, "agent1", "research", owner);

        let id_bytes = record.id.clone().to_xdr(&env);
        let record_bytes = record.clone().to_xdr(&env);

        assert!(
            id_bytes.len() <= MAX_AGENT_ID + 4,
            "id_bytes.len() is {}",
            id_bytes.len()
        );
        assert!(
            record_bytes.len() <= MAX_TOTAL_AGENT_STORAGE,
            "record_bytes.len() is {}",
            record_bytes.len()
        );

        let reg_res = client.try_register_agent(&record);
        assert!(
            reg_res.is_ok(),
            "try_register_agent returned Err: {:?}",
            reg_res
        );
        let reg_inner = reg_res.unwrap();
        assert!(
            reg_inner.is_ok(),
            "try_register_agent inner result is Err: {:?}",
            reg_inner
        );

        // Check if the record is stored in storage directly
        let agent_key = DataKey::Agent(record.id.clone());
        let opt_record: Option<AgentRecord> = env.as_contract(&client.address, || {
            env.storage().persistent().get(&agent_key)
        });
        assert!(opt_record.is_some(), "opt_record is None in storage!");

        let cap_key = DataKey::CapabilityIndex(record.capability.clone());
        let opt_ids: Option<Vec<Symbol>> =
            env.as_contract(&client.address, || env.storage().persistent().get(&cap_key));
        assert!(opt_ids.is_some(), "opt_ids is None in storage!");
        let ids = opt_ids.unwrap();
        assert_eq!(ids.len(), 1, "ids.len() is {}", ids.len());

        let results = client.lookup_agents(&Symbol::new(&env, "research"));
        assert_eq!(results.len(), 1);
        assert_eq!(results.get(0).unwrap().id, Symbol::new(&env, "agent1"));
    }

    #[test]
    fn register_duplicate_returns_error() {
        let (env, client) = setup();
        let owner = Address::generate(&env);
        let record = make_record(&env, "dup", "research", owner);
        client.register_agent(&record.clone());
        assert_eq!(
            client.try_register_agent(&record),
            Err(Ok(Error::AlreadyExists))
        );
    }

    #[test]
    fn lookup_multiple_agents_same_capability() {
        let (env, client) = setup();
        client.register_agent(&make_record(
            &env,
            "a1",
            "analytics",
            Address::generate(&env),
        ));
        client.register_agent(&make_record(
            &env,
            "a2",
            "analytics",
            Address::generate(&env),
        ));
        client.register_agent(&make_record(&env, "a3", "other", Address::generate(&env)));

        let results = client.lookup_agents(&Symbol::new(&env, "analytics"));
        assert_eq!(results.len(), 2);
    }

    #[test]
    fn lookup_unknown_capability_returns_empty() {
        let (env, client) = setup();
        let results = client.lookup_agents(&Symbol::new(&env, "unknown"));
        assert_eq!(results.len(), 0);
    }

    #[test]
    fn deregister_removes_from_index() {
        let (env, client) = setup();
        let owner = Address::generate(&env);
        client.register_agent(&make_record(&env, "agent2", "coding", owner));
        client.deregister_agent(&Symbol::new(&env, "agent2"));

        let results = client.lookup_agents(&Symbol::new(&env, "coding"));
        assert_eq!(results.len(), 0);
    }

    #[test]
    fn deregister_missing_agent_returns_not_found() {
        let (env, client) = setup();
        assert_eq!(
            client.try_deregister_agent(&Symbol::new(&env, "ghost")),
            Err(Ok(Error::NotFound))
        );
    }

    #[test]
    fn deregister_wrong_signer_is_unauthorized() {
        let env = Env::default();
        let contract_id = env.register(AgentRegistryContract, ());
        let client = AgentRegistryContractClient::new(&env, &contract_id);

        let owner = Address::generate(&env);

        env.mock_all_auths();
        client.register_agent(&make_record(&env, "agent3", "risk", owner.clone()));

        env.mock_auths(&[]);
        let result = client.try_deregister_agent(&Symbol::new(&env, "agent3"));
        assert!(result.is_err());
    }

    #[test]
    fn update_pricing_changes_price_and_emits_event() {
        let (env, client) = setup();
        let owner = Address::generate(&env);
        client.register_agent(&make_record(&env, "agent4", "report", owner));

        client.update_pricing(&Symbol::new(&env, "agent4"), &5_000_i128);

        let results = client.lookup_agents(&Symbol::new(&env, "report"));
        assert_eq!(results.get(0).unwrap().price_stroops, 5_000);
    }

    #[test]
    fn update_pricing_missing_agent_returns_not_found() {
        let (env, client) = setup();
        assert_eq!(
            client.try_update_pricing(&Symbol::new(&env, "ghost"), &100_i128),
            Err(Ok(Error::NotFound))
        );
    }

    #[test]
    fn initialize_sets_admin() {
        let (env, client) = setup();
        let admin = Address::generate(&env);
        client.initialize(&admin);
        assert_eq!(client.get_admin(), Some(admin));
    }

    #[test]
    fn initialize_cannot_be_called_twice() {
        let (env, client) = setup();
        let admin = Address::generate(&env);
        client.initialize(&admin);
        assert_eq!(
            client.try_initialize(&Address::generate(&env)),
            Err(Ok(Error::AlreadyExists))
        );
    }

    #[test]
    fn set_admin_changes_admin() {
        let (env, client, _admin) = setup_with_admin();
        let new_admin = Address::generate(&env);
        client.set_admin(&new_admin);
        assert_eq!(client.get_admin(), Some(new_admin));
    }

    #[test]
    fn set_admin_requires_admin_auth() {
        let env = Env::default();
        let contract_id = env.register(AgentRegistryContract, ());
        let client = AgentRegistryContractClient::new(&env, &contract_id);
        let admin = Address::generate(&env);
        env.mock_all_auths();
        client.initialize(&admin);

        env.mock_auths(&[]);
        let result = client.try_set_admin(&Address::generate(&env));
        assert!(result.is_err());
    }

    #[test]
    fn pause_blocks_register_agent() {
        let (env, client, _admin) = setup_with_admin();
        client.pause();
        let owner = Address::generate(&env);
        let result = client.try_register_agent(&make_record(&env, "agent_p", "test", owner));
        assert_eq!(result, Err(Ok(Error::ContractPaused)));
    }

    #[test]
    fn pause_blocks_deregister_agent() {
        let (env, client, _admin) = setup_with_admin();
        let owner = Address::generate(&env);
        env.mock_all_auths();
        client.register_agent(&make_record(&env, "agent_d", "test", owner));
        client.pause();
        let result = client.try_deregister_agent(&Symbol::new(&env, "agent_d"));
        assert_eq!(result, Err(Ok(Error::ContractPaused)));
    }

    #[test]
    fn pause_blocks_update_pricing() {
        let (env, client, _admin) = setup_with_admin();
        let owner = Address::generate(&env);
        env.mock_all_auths();
        client.register_agent(&make_record(&env, "agent_u", "test", owner));
        client.pause();
        let result = client.try_update_pricing(&Symbol::new(&env, "agent_u"), &999_i128);
        assert_eq!(result, Err(Ok(Error::ContractPaused)));
    }

    #[test]
    fn unpause_allows_operations() {
        let (env, client, _admin) = setup_with_admin();
        client.pause();
        client.unpause();
        let owner = Address::generate(&env);
        client.register_agent(&make_record(&env, "agent_up", "test", owner));
        let results = client.lookup_agents(&Symbol::new(&env, "test"));
        assert_eq!(results.len(), 1);
    }

    #[test]
    fn non_admin_cannot_pause() {
        let env = Env::default();
        let contract_id = env.register(AgentRegistryContract, ());
        let client = AgentRegistryContractClient::new(&env, &contract_id);
        let admin = Address::generate(&env);
        env.mock_all_auths();
        client.initialize(&admin);

        env.mock_auths(&[]);
        let result = client.try_pause();
        assert!(result.is_err());
    }

    #[test]
    fn non_admin_cannot_unpause() {
        let env = Env::default();
        let contract_id = env.register(AgentRegistryContract, ());
        let client = AgentRegistryContractClient::new(&env, &contract_id);
        let admin = Address::generate(&env);
        env.mock_all_auths();
        client.initialize(&admin);
        client.pause();

        env.mock_auths(&[]);
        let result = client.try_unpause();
        assert!(result.is_err());
    }

    #[test]
    fn is_paused_reflects_state() {
        let (_env, client, _admin) = setup_with_admin();
        assert!(!client.is_paused());
        client.pause();
        assert!(client.is_paused());
        client.unpause();
        assert!(!client.is_paused());
    }

    #[test]
    fn freeze_agent_blocks_update_pricing() {
        let (env, client, _admin) = setup_with_admin();
        let owner = Address::generate(&env);
        env.mock_all_auths();
        client.register_agent(&make_record(&env, "agent_f", "test", owner));
        client.freeze_agent(&Symbol::new(&env, "agent_f"));
        let result = client.try_update_pricing(&Symbol::new(&env, "agent_f"), &777_i128);
        assert_eq!(result, Err(Ok(Error::AgentFrozen)));
    }

    #[test]
    fn freeze_agent_blocks_register() {
        let (env, client, _admin) = setup_with_admin();
        client.freeze_agent(&Symbol::new(&env, "frozen_id"));
        let owner = Address::generate(&env);
        let result = client.try_register_agent(&make_record(&env, "frozen_id", "test", owner));
        assert_eq!(result, Err(Ok(Error::AgentFrozen)));
    }

    #[test]
    fn unfreeze_agent_allows_operations() {
        let (env, client, _admin) = setup_with_admin();
        let owner = Address::generate(&env);
        env.mock_all_auths();
        client.register_agent(&make_record(&env, "agent_unf", "test", owner));
        client.freeze_agent(&Symbol::new(&env, "agent_unf"));
        assert!(client.is_agent_frozen(&Symbol::new(&env, "agent_unf")));
        client.unfreeze_agent(&Symbol::new(&env, "agent_unf"));
        assert!(!client.is_agent_frozen(&Symbol::new(&env, "agent_unf")));
        client.update_pricing(&Symbol::new(&env, "agent_unf"), &333_i128);
        let results = client.lookup_agents(&Symbol::new(&env, "test"));
        assert_eq!(results.get(0).unwrap().price_stroops, 333);
    }

    #[test]
    fn is_agent_frozen_reflects_state() {
        let (env, client, _admin) = setup_with_admin();
        assert!(!client.is_agent_frozen(&Symbol::new(&env, "agent_state")));
        client.freeze_agent(&Symbol::new(&env, "agent_state"));
        assert!(client.is_agent_frozen(&Symbol::new(&env, "agent_state")));
        client.unfreeze_agent(&Symbol::new(&env, "agent_state"));
    }

    #[test]
    fn resolve_errors_requires_admin_auth() {
        let env = Env::default();
        let contract_id = env.register(AgentRegistryContract, ());
        let client = AgentRegistryContractClient::new(&env, &contract_id);
        let admin = Address::generate(&env);

        env.mock_all_auths();
        client.initialize(&admin);

        let reporter = Address::generate(&env);
        let id1 = error_id(&env, 40);
        client.report_error(&id1, &reporter, &String::from_str(&env, "some error"));

        let mut ids = Vec::new(&env);
        ids.push_back(id1.clone());

        // Test non-admin cannot resolve errors
        env.mock_auths(&[]);
        let result = client.try_resolve_errors(&ids, &Resolution::Fixed);
        assert!(result.is_err());

        // Test admin succeeds
        env.mock_all_auths();
        let result_admin = client.resolve_errors(&ids, &Resolution::Fixed);
        assert_eq!(result_admin.get(0).unwrap(), VoidBatchResult::Ok);
    }

    #[test]
    fn set_gas_config_requires_admin_auth() {
        let env = Env::default();
        let contract_id = env.register(AgentRegistryContract, ());
        let client = AgentRegistryContractClient::new(&env, &contract_id);
        let admin = Address::generate(&env);

        env.mock_all_auths();
        client.initialize(&admin);

        let new_config = GasConfig {
            tx_overhead: 10_000,
            register_agent: 50_000,
            register_agent_marginal: 20_000,
            resolve_error: 25_000,
            resolve_error_marginal: 15_000,
        };

        // Test non-admin cannot set gas config
        env.mock_auths(&[]);
        let result = client.try_set_gas_config(&new_config);
        assert!(result.is_err());

        // Test admin succeeds
        env.mock_all_auths();
        client.set_gas_config(&new_config);
        assert_eq!(client.get_gas_config(), new_config);
    }

    // ── Batch registration ───────────────────────────────────────────────────

    #[test]
    fn register_agents_batch_success() {
        let (env, client) = setup();
        let mut agents = Vec::new(&env);
        agents.push_back(make_record(&env, "b1", "research", Address::generate(&env)));
        agents.push_back(make_record(&env, "b2", "research", Address::generate(&env)));
        agents.push_back(make_record(&env, "b3", "coding", Address::generate(&env)));

        let results = client.register_agents(&agents);
        assert_eq!(results.len(), 3);
        assert_eq!(
            results.get(0).unwrap(),
            BatchResult::Ok(Symbol::new(&env, "b1"))
        );
        assert_eq!(
            results.get(1).unwrap(),
            BatchResult::Ok(Symbol::new(&env, "b2"))
        );
        assert_eq!(
            results.get(2).unwrap(),
            BatchResult::Ok(Symbol::new(&env, "b3"))
        );

        assert_eq!(
            client.lookup_agents(&Symbol::new(&env, "research")).len(),
            2
        );
        assert_eq!(client.lookup_agents(&Symbol::new(&env, "coding")).len(), 1);
    }

    #[test]
    fn register_agents_partial_failure_is_atomic() {
        let (env, client) = setup();
        // Pre-register one agent so the batch has a conflict.
        client.register_agent(&make_record(
            &env,
            "exists",
            "research",
            Address::generate(&env),
        ));

        let mut agents = Vec::new(&env);
        agents.push_back(make_record(
            &env,
            "new1",
            "research",
            Address::generate(&env),
        ));
        agents.push_back(make_record(
            &env,
            "exists",
            "research",
            Address::generate(&env),
        ));
        agents.push_back(make_record(&env, "new2", "coding", Address::generate(&env)));

        let results = client.register_agents(&agents);
        assert_eq!(results.len(), 3);
        assert_eq!(
            results.get(0).unwrap(),
            BatchResult::Ok(Symbol::new(&env, "new1"))
        );
        assert_eq!(
            results.get(1).unwrap(),
            BatchResult::Err(Error::AlreadyExists as u32)
        );
        assert_eq!(
            results.get(2).unwrap(),
            BatchResult::Ok(Symbol::new(&env, "new2"))
        );

        // Atomic: none of the new agents were written.
        assert_eq!(
            client.lookup_agents(&Symbol::new(&env, "research")).len(),
            1
        );
        assert_eq!(client.lookup_agents(&Symbol::new(&env, "coding")).len(), 0);
    }

    #[test]
    fn register_agents_duplicate_ids_in_batch() {
        let (env, client) = setup();
        let owner1 = Address::generate(&env);
        let owner2 = Address::generate(&env);
        let mut agents = Vec::new(&env);
        agents.push_back(make_record(&env, "same", "research", owner1));
        agents.push_back(make_record(&env, "same", "coding", owner2));

        let results = client.register_agents(&agents);
        assert_eq!(
            results.get(0).unwrap(),
            BatchResult::Ok(Symbol::new(&env, "same"))
        );
        assert_eq!(
            results.get(1).unwrap(),
            BatchResult::Err(Error::DuplicateInBatch as u32)
        );
        // Atomic rollback — agent was not registered.
        assert_eq!(
            client.lookup_agents(&Symbol::new(&env, "research")).len(),
            0
        );
        assert_eq!(client.lookup_agents(&Symbol::new(&env, "coding")).len(), 0);
    }

    #[test]
    fn register_agents_empty_batch() {
        let (env, client) = setup();
        let agents = Vec::new(&env);
        let results = client.register_agents(&agents);
        assert_eq!(results.len(), 0);
    }

    // ── Batch error resolution ───────────────────────────────────────────────

    #[test]
    fn resolve_errors_batch_success() {
        let (env, client, _admin) = setup_with_admin();
        let reporter = Address::generate(&env);
        let id1 = error_id(&env, 1);
        let id2 = error_id(&env, 2);
        let id3 = error_id(&env, 3);

        client.report_error(&id1, &reporter, &String::from_str(&env, "timeout"));
        client.report_error(&id2, &reporter, &String::from_str(&env, "auth"));
        client.report_error(&id3, &reporter, &String::from_str(&env, "budget"));

        let mut ids = Vec::new(&env);
        ids.push_back(id1.clone());
        ids.push_back(id2.clone());
        ids.push_back(id3.clone());

        let results = client.resolve_errors(&ids, &Resolution::Fixed);
        assert_eq!(results.len(), 3);
        assert_eq!(results.get(0).unwrap(), VoidBatchResult::Ok);
        assert_eq!(results.get(1).unwrap(), VoidBatchResult::Ok);
        assert_eq!(results.get(2).unwrap(), VoidBatchResult::Ok);

        let e1 = client.get_error(&id1).unwrap();
        assert!(e1.resolved);
        assert_eq!(e1.resolution, Resolution::Fixed);
    }

    #[test]
    fn resolve_errors_partial_failure_is_atomic() {
        let (env, client, _admin) = setup_with_admin();
        let reporter = Address::generate(&env);
        let id1 = error_id(&env, 10);
        let missing = error_id(&env, 99);

        client.report_error(&id1, &reporter, &String::from_str(&env, "real"));

        let mut ids = Vec::new(&env);
        ids.push_back(id1.clone());
        ids.push_back(missing);

        let results = client.resolve_errors(&ids, &Resolution::Ignored);
        assert_eq!(results.get(0).unwrap(), VoidBatchResult::Ok);
        assert_eq!(
            results.get(1).unwrap(),
            VoidBatchResult::Err(Error::NotFound as u32)
        );

        // Atomic: first error must still be unresolved.
        let e1 = client.get_error(&id1).unwrap();
        assert!(!e1.resolved);
    }

    #[test]
    fn resolve_errors_already_resolved_fails_atomically() {
        let (env, client, _admin) = setup_with_admin();
        let reporter = Address::generate(&env);
        let id1 = error_id(&env, 20);
        let id2 = error_id(&env, 21);

        client.report_error(&id1, &reporter, &String::from_str(&env, "a"));
        client.report_error(&id2, &reporter, &String::from_str(&env, "b"));

        // Resolve id1 alone first via a one-item batch.
        let mut first = Vec::new(&env);
        first.push_back(id1.clone());
        let r = client.resolve_errors(&first, &Resolution::Fixed);
        assert_eq!(r.get(0).unwrap(), VoidBatchResult::Ok);

        // Batch with already-resolved + open must not touch the open one.
        let mut both = Vec::new(&env);
        both.push_back(id1.clone());
        both.push_back(id2.clone());
        let results = client.resolve_errors(&both, &Resolution::Escalated);
        assert_eq!(
            results.get(0).unwrap(),
            VoidBatchResult::Err(Error::AlreadyResolved as u32)
        );
        assert_eq!(results.get(1).unwrap(), VoidBatchResult::Ok);

        let e2 = client.get_error(&id2).unwrap();
        assert!(!e2.resolved);
    }

    // ── Gas estimation ───────────────────────────────────────────────────────

    #[test]
    fn estimate_gas_register_scales_with_count() {
        let (env, client) = setup();
        let one = client.estimate_gas(&String::from_str(&env, "register_agent"), &1);
        let ten = client.estimate_gas(&String::from_str(&env, "register_agents"), &10);

        assert_eq!(one, GAS_REGISTER_AGENT);
        // 100_000 + 9 * 55_556 = 600_004 ≈ 600k (issue #120)
        assert_eq!(ten, GAS_REGISTER_AGENT + GAS_REGISTER_AGENT_MARGINAL * 9);
        assert!(ten < 610_000);
        // Batch of 10 is cheaper than 10 separate txs.
        assert!(ten < GAS_REGISTER_AGENT * 10);
    }

    #[test]
    fn estimate_gas_resolve_scales_with_count() {
        let (env, client) = setup();
        let one = client.estimate_gas(&String::from_str(&env, "resolve_error"), &1);
        let ten = client.estimate_gas(&String::from_str(&env, "resolve_errors"), &10);

        assert_eq!(one, GAS_RESOLVE_ERROR);
        assert_eq!(ten, GAS_RESOLVE_ERROR + GAS_RESOLVE_ERROR_MARGINAL * 9);
        assert!(ten < GAS_RESOLVE_ERROR * 10);
    }

    #[test]
    fn estimate_gas_unknown_operation_is_zero() {
        let (env, client) = setup();
        let v = client.estimate_gas(&String::from_str(&env, "not_a_real_op"), &5);
        assert_eq!(v, 0);
    }

    #[test]
    fn estimate_gas_zero_count_is_zero() {
        let (env, client) = setup();
        let v = client.estimate_gas(&String::from_str(&env, "register_agents"), &0);
        assert_eq!(v, 0);
    }

    // ── Event emission tests ─────────────────────────────────────────────────
    //
    // In Soroban's test Env, `env.events().all()` returns ONLY the events from
    // the most recent contract invocation — it resets on every client.xxx() call.
    // Tests inspect the event list directly after the one call under test.

    fn assert_event_topics(env: &Env, idx: u32, topic0: Symbol, topic1: Symbol) {
        let events = env.events().all();
        assert!(
            idx < events.len(),
            "event index {} out of range (total {})",
            idx,
            events.len()
        );
        let (_, topics, _) = events.get(idx).unwrap();
        let t0 = Symbol::from_val(env, &topics.get(0).unwrap());
        let t1 = Symbol::from_val(env, &topics.get(1).unwrap());
        assert_eq!(t0, topic0, "topic[0] mismatch at event {}", idx);
        assert_eq!(t1, topic1, "topic[1] mismatch at event {}", idx);
    }

    #[test]
    fn initialize_emits_initialized_event() {
        let env = Env::default();
        env.mock_all_auths();
        let id = env.register(AgentRegistryContract, ());
        let client = AgentRegistryContractClient::new(&env, &id);
        let admin = Address::generate(&env);
        client.initialize(&admin);
        // events() reflects this call only
        assert_eq!(env.events().all().len(), 1, "initialize must emit 1 event");
        assert_event_topics(&env, 0, symbol_short!("registry"), symbol_short!("init"));
    }

    #[test]
    fn set_admin_emits_admin_changed_event() {
        let (env, client, _) = setup_with_admin();
        let new_admin = Address::generate(&env);
        client.set_admin(&new_admin);
        // events() reflects set_admin call only
        assert_eq!(env.events().all().len(), 1, "set_admin must emit 1 event");
        assert_event_topics(
            &env,
            0,
            symbol_short!("registry"),
            symbol_short!("adm_chngd"),
        );
    }

    #[test]
    fn register_agent_emits_agent_registered_event() {
        let (env, client) = setup();
        let owner = Address::generate(&env);
        client.register_agent(&make_record(&env, "ev_agent1", "research", owner));
        assert_eq!(
            env.events().all().len(),
            1,
            "register_agent must emit 1 event"
        );
        assert_event_topics(
            &env,
            0,
            symbol_short!("registry"),
            symbol_short!("agent_reg"),
        );
    }

    #[test]
    fn register_agents_batch_emits_one_event_per_agent() {
        let (env, client) = setup();
        let mut agents = Vec::new(&env);
        agents.push_back(make_record(
            &env,
            "bev1",
            "research",
            Address::generate(&env),
        ));
        agents.push_back(make_record(&env, "bev2", "coding", Address::generate(&env)));
        agents.push_back(make_record(&env, "bev3", "report", Address::generate(&env)));
        let results = client.register_agents(&agents);
        assert!(results.iter().all(|r| matches!(r, BatchResult::Ok(_))));
        // events() reflects this register_agents call: 1 per committed agent
        assert_eq!(env.events().all().len(), 3, "batch of 3 must emit 3 events");
        for i in 0..3u32 {
            assert_event_topics(
                &env,
                i,
                symbol_short!("registry"),
                symbol_short!("agent_reg"),
            );
        }
    }

    #[test]
    fn register_agents_failed_batch_emits_no_events() {
        let (env, client) = setup();
        client.register_agent(&make_record(
            &env,
            "conflict",
            "research",
            Address::generate(&env),
        ));
        // failed batch: conflicting id forces atomic abort
        let mut agents = Vec::new(&env);
        agents.push_back(make_record(
            &env,
            "new_ok",
            "coding",
            Address::generate(&env),
        ));
        agents.push_back(make_record(
            &env,
            "conflict",
            "research",
            Address::generate(&env),
        ));
        client.register_agents(&agents);
        // events() reflects this call — aborted, so zero
        assert_eq!(
            env.events().all().len(),
            0,
            "failed batch must emit 0 events"
        );
    }

    #[test]
    fn deregister_agent_emits_agent_deregistered_event() {
        let (env, client) = setup();
        let owner = Address::generate(&env);
        client.register_agent(&make_record(&env, "dreg_ev", "analytics", owner));
        client.deregister_agent(&Symbol::new(&env, "dreg_ev"));
        // events() reflects deregister_agent call only
        assert_eq!(
            env.events().all().len(),
            1,
            "deregister_agent must emit 1 event"
        );
        assert_event_topics(
            &env,
            0,
            symbol_short!("registry"),
            symbol_short!("agent_drg"),
        );
    }

    #[test]
    fn report_error_emits_error_reported_event() {
        let (env, client) = setup();
        let reporter = Address::generate(&env);
        let eid = error_id(&env, 77);
        client.report_error(&eid, &reporter, &String::from_str(&env, "disk full"));
        assert_eq!(
            env.events().all().len(),
            1,
            "report_error must emit 1 event"
        );
        assert_event_topics(
            &env,
            0,
            symbol_short!("registry"),
            symbol_short!("err_rptd"),
        );
    }

    #[test]
    fn resolve_errors_emits_one_event_per_resolved_error() {
        let (env, client, _) = setup_with_admin();
        let reporter = Address::generate(&env);
        let id1 = error_id(&env, 50);
        let id2 = error_id(&env, 51);
        let id3 = error_id(&env, 52);
        client.report_error(&id1, &reporter, &String::from_str(&env, "t1"));
        client.report_error(&id2, &reporter, &String::from_str(&env, "t2"));
        client.report_error(&id3, &reporter, &String::from_str(&env, "t3"));
        let mut ids = Vec::new(&env);
        ids.push_back(id1);
        ids.push_back(id2);
        ids.push_back(id3);
        let results = client.resolve_errors(&ids, &Resolution::Fixed);
        assert!(results.iter().all(|r| r == VoidBatchResult::Ok));
        // events() reflects resolve_errors call: 1 per resolved error
        assert_eq!(
            env.events().all().len(),
            3,
            "resolve_errors must emit 3 events"
        );
        for i in 0..3u32 {
            assert_event_topics(
                &env,
                i,
                symbol_short!("registry"),
                symbol_short!("err_rslvd"),
            );
        }
    }

    #[test]
    fn resolve_errors_failed_batch_emits_no_events() {
        let (env, client, _) = setup_with_admin();
        let reporter = Address::generate(&env);
        let id1 = error_id(&env, 60);
        let missing = error_id(&env, 99);
        client.report_error(&id1, &reporter, &String::from_str(&env, "real"));
        let mut ids = Vec::new(&env);
        ids.push_back(id1);
        ids.push_back(missing);
        let results = client.resolve_errors(&ids, &Resolution::Ignored);
        assert_eq!(
            results.get(1).unwrap(),
            VoidBatchResult::Err(Error::NotFound as u32)
        );
        // events() reflects this call — aborted, zero events
        assert_eq!(
            env.events().all().len(),
            0,
            "aborted resolve_errors must emit 0 events"
        );
    }

    #[test]
    fn resolve_errors_resolution_code_matches_variant() {
        let (env, client, _) = setup_with_admin();
        let reporter = Address::generate(&env);
        let id1 = error_id(&env, 80);
        client.report_error(&id1, &reporter, &String::from_str(&env, "netsplit"));
        let mut ids = Vec::new(&env);
        ids.push_back(id1);
        client.resolve_errors(&ids, &Resolution::Escalated);
        assert_eq!(env.events().all().len(), 1, "must emit 1 err_rslvd event");
        assert_event_topics(
            &env,
            0,
            symbol_short!("registry"),
            symbol_short!("err_rslvd"),
        );
    }
}
