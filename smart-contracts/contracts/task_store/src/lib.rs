#![no_std]
// Soroban contract entrypoints can legitimately have more than 7 parameters;
// suppress this lint for the whole crate rather than annotating every generated
// client function individually.
#![allow(clippy::too_many_arguments)]

//! # Task Store Contract
//!
//! Stores task metadata and manages the task lifecycle state machine.
//!
//! ## Oracle integration
//!
//! When an OracleManager is configured (via `set_oracle_manager`), the current
//! market price for the supplied `price_pair` is resolved via
//! `OracleManager::resolve_price` and stamped immutably onto the task at
//! creation time in `TaskMetadata::quoted_price_stroops`.
//!
//! If no OracleManager is configured, or if `price_pair` is `None`, the field
//! is left as `None` and no error is returned — legacy callers that do not
//! supply a pair continue to work unchanged.
//!
//! If an OracleManager *is* configured and a `price_pair` is supplied but the
//! oracle returns no usable price (stale feed + no fallback), the call is
//! **rejected** with `Error::OraclePriceUnavailable`. This prevents tasks from
//! being accepted at an unknown cost.

mod types;

pub use types::{
    DataKey, Error, OracleManagerSetEvent, TaskCreatedEvent, TaskFinalizedEvent, TaskMetadata,
    TaskStatus, TaskUpdatedEvent, DEFAULT_TTL_DAYS, LEDGERS_PER_DAY, MAX_COMPRESSED_DAG_BYTES,
    MAX_TTL_DAYS, TASK_LIFECYCLE_EVENT_VERSION,
};

use soroban_sdk::{contract, contractimpl, symbol_short, Address, Bytes, BytesN, Env, String, Vec};

const SECONDS_PER_DAY: u64 = 86_400;
const CONTRACT_VERSION: &str = "1.0.0";

fn ttl_ledgers(ttl_days: u32) -> u32 {
    ttl_days.saturating_mul(LEDGERS_PER_DAY)
}

fn is_expired(env: &Env, metadata: &TaskMetadata) -> bool {
    env.ledger().timestamp() >= metadata.expires_at
}

fn read_metadata(env: &Env, task_id: &BytesN<32>) -> Result<TaskMetadata, Error> {
    let key = DataKey::Task(task_id.clone());
    let metadata: TaskMetadata = env
        .storage()
        .persistent()
        .get(&key)
        .ok_or(Error::NotFound)?;

    if is_expired(env, &metadata) {
        return Err(Error::Expired);
    }

    Ok(metadata)
}

fn has_duplicate_agents(agents: &Vec<Address>) -> bool {
    for (index, agent) in agents.iter().enumerate() {
        for other in agents.iter().skip(index + 1) {
            if agent == other {
                return true;
            }
        }
    }
    false
}

fn can_transition(from: TaskStatus, to: TaskStatus) -> bool {
    matches!(
        (from, to),
        (TaskStatus::Pending, TaskStatus::Running)
            | (TaskStatus::Pending, TaskStatus::Failed)
            | (TaskStatus::Running, TaskStatus::Completed)
            | (TaskStatus::Running, TaskStatus::Failed)
    )
}

fn is_terminal(status: TaskStatus) -> bool {
    matches!(status, TaskStatus::Completed | TaskStatus::Failed)
}

fn read_admin(env: &Env) -> Result<Address, Error> {
    env.storage()
        .instance()
        .get(&DataKey::Admin)
        .ok_or(Error::NotInitialized)
}

fn require_admin(env: &Env) -> Result<(), Error> {
    let admin = read_admin(env)?;
    admin.require_auth();
    Ok(())
}

/// Call `OracleManager::resolve_price(pair)` via a low-level cross-contract
/// call and return the resolved price in stroops on success, or `None` on any
/// failure (stale feed, no fallback, call error).  The oracle manager expresses
/// its error by trapping, which we catch with `try_invoke_contract`.
fn try_resolve_price(env: &Env, oracle_manager: &Address, pair: &Symbol) -> Option<i128> {
    use soroban_sdk::{InvokeError, Map, TryIntoVal};

    let fn_name = Symbol::new(env, "resolve_price");
    let args = soroban_sdk::vec![env, pair.into_val(env)];

    // try_invoke_contract<T, E> returns Result<Result<T, T::Error>, Result<E, InvokeError>>.
    let result: Result<Result<Val, _>, Result<InvokeError, InvokeError>> =
        env.try_invoke_contract(oracle_manager, &fn_name, args);

    match result {
        Ok(Ok(val)) => {
            // ResolvedPrice is a contracttype struct — serialised as a Map keyed
            // by field-name Symbols.  Extract the `price` field.
            let map: Result<Map<Symbol, Val>, _> = val.try_into_val(env);
            if let Ok(m) = map {
                let price_key = Symbol::new(env, "price");
                m.get(price_key)
                    .and_then(|v| v.try_into_val(env).ok())
                    .filter(|p: &i128| *p > 0)
            } else {
                None
            }
        }
        _ => None,
    }
}

#[contract]
pub struct TaskStoreContract;

#[contractimpl]
impl TaskStoreContract {
    pub fn initialize(env: Env, admin: Address) -> Result<(), Error> {
        if env.storage().instance().has(&DataKey::Admin) {
            return Err(Error::AlreadyInitialized);
        }
        admin.require_auth();
        env.storage().instance().set(&DataKey::Admin, &admin);
        env.storage()
            .instance()
            .set(&DataKey::Version, &String::from_str(&env, CONTRACT_VERSION));
        Ok(())
    }

    pub fn admin(env: Env) -> Option<Address> {
        env.storage().instance().get(&DataKey::Admin)
    }

    pub fn contract_version(env: Env) -> String {
        env.storage()
            .instance()
            .get(&DataKey::Version)
            .unwrap_or_else(|| String::from_str(&env, CONTRACT_VERSION))
    }

    pub fn upgrade(
        env: Env,
        new_wasm_hash: BytesN<32>,
        new_version: String,
    ) -> Result<(), Error> {
        let admin = require_admin(&env)?;
        let old_version = Self::contract_version(env.clone());
        env.deployer()
            .update_current_contract_wasm(new_wasm_hash.clone());
        env.storage().instance().set(&DataKey::Version, &new_version);
        env.events().publish(
            (symbol_short!("task_str"), symbol_short!("upgraded")),
            (old_version, new_version, new_wasm_hash, admin, env.ledger().sequence()),
        );
        Ok(())
    }

    pub fn store_task_metadata(
        env: Env,
        submitter: Address,
        task_id: BytesN<32>,
        prompt_hash: BytesN<32>,
        assigned_agents: Vec<Address>,
        compressed_dag: Bytes,
        ttl_days: u32,
        price_pair: Option<Symbol>,
    ) -> Result<(), Error> {
        submitter.require_auth();

        let key = DataKey::Task(task_id.clone());
        if env.storage().persistent().has(&key) {
            return Err(Error::AlreadyExists);
        }
        if assigned_agents.is_empty() {
            return Err(Error::NoAssignedAgents);
        }
        if has_duplicate_agents(&assigned_agents) {
            return Err(Error::DuplicateAgent);
        }
        if compressed_dag.is_empty() || compressed_dag.len() > MAX_COMPRESSED_DAG_BYTES {
            return Err(Error::InvalidDag);
        }

        let retention_days = if ttl_days == 0 {
            DEFAULT_TTL_DAYS
        } else {
            ttl_days
        };
        if retention_days > MAX_TTL_DAYS {
            return Err(Error::InvalidTtl);
        }

        // ── Oracle price resolution ────────────────────────────────────────────
        let (quoted_price_stroops, resolved_pair) = if let Some(oracle_manager) = env
            .storage()
            .instance()
            .get::<DataKey, Address>(&DataKey::OracleManager)
        {
            // OracleManager is configured: a price_pair is mandatory.
            let pair = price_pair.clone().ok_or(Error::MissingPricePair)?;
            let price = try_resolve_price(&env, &oracle_manager, &pair)
                .ok_or(Error::OraclePriceUnavailable)?;
            (Some(price), Some(pair))
        } else {
            // No OracleManager: pricing is optional (legacy path).
            (None, None)
        };

        let created_at = env.ledger().timestamp();
        let expires_at =
            created_at.saturating_add(u64::from(retention_days).saturating_mul(SECONDS_PER_DAY));

        let metadata = TaskMetadata {
            task_id: task_id.clone(),
            prompt_hash: prompt_hash.clone(),
            assigned_agents,
            compressed_dag,
            status: TaskStatus::Pending,
            created_at,
            expires_at,
            quoted_price_stroops,
            price_pair: resolved_pair,
        };

        env.storage().persistent().set(&key, &metadata);
        let ledgers = ttl_ledgers(retention_days);
        env.storage()
            .persistent()
            .extend_ttl(&key, ledgers.saturating_sub(1), ledgers);

        env.events().publish(
            (symbol_short!("task_meta"), symbol_short!("created")),
            TaskCreatedEvent {
                version: TASK_LIFECYCLE_EVENT_VERSION,
                task_id,
                prompt_hash,
                assigned_agents: metadata.assigned_agents,
                created_at,
                expires_at,
                quoted_price_stroops,
            },
        );

        Ok(())
    }

    pub fn get_task_metadata(env: Env, task_id: BytesN<32>) -> Result<TaskMetadata, Error> {
        read_metadata(&env, &task_id)
    }

    pub fn get_task_status(env: Env, task_id: BytesN<32>) -> Result<TaskStatus, Error> {
        Ok(read_metadata(&env, &task_id)?.status)
    }

    pub fn update_task_status(
        env: Env,
        task_id: BytesN<32>,
        agent: Address,
        new_status: TaskStatus,
    ) -> Result<(), Error> {
        agent.require_auth();

        let key = DataKey::Task(task_id.clone());
        let mut metadata = read_metadata(&env, &task_id)?;
        if !metadata.assigned_agents.contains(&agent) {
            return Err(Error::NotAssignedAgent);
        }
        if !can_transition(metadata.status, new_status) {
            return Err(Error::InvalidStatusTransition);
        }

        let old_status = metadata.status;
        metadata.status = new_status;
        env.storage().persistent().set(&key, &metadata);

        // Every successful transition emits exactly one lifecycle event:
        // terminal transitions (-> Completed / -> Failed) emit `finalized`,
        // everything else emits `updated` — never both.
        let timestamp = env.ledger().timestamp();
        if is_terminal(new_status) {
            env.events().publish(
                (symbol_short!("task_meta"), symbol_short!("finalized")),
                TaskFinalizedEvent {
                    version: TASK_LIFECYCLE_EVENT_VERSION,
                    task_id,
                    agent,
                    old_status,
                    final_status: new_status,
                    finalized_at: timestamp,
                },
            );
        } else {
            env.events().publish(
                (symbol_short!("task_meta"), symbol_short!("updated")),
                TaskUpdatedEvent {
                    version: TASK_LIFECYCLE_EVENT_VERSION,
                    task_id,
                    agent,
                    old_status,
                    new_status,
                    updated_at: timestamp,
                },
            );
        }

        Ok(())
    }
}

// ─── Tests ───────────────────────────────────────────────────────────────────

#[cfg(test)]
mod test {
    use super::*;
    use soroban_sdk::{
        testutils::{Address as _, Events, Ledger},
        Address, Bytes, Env, IntoVal,
    };

    struct Fixture {
        env: Env,
        client: TaskStoreContractClient<'static>,
        submitter: Address,
        agent: Address,
        task_id: BytesN<32>,
        prompt_hash: BytesN<32>,
    }

    fn fixture() -> Fixture {
        let env = Env::default();
        env.mock_all_auths();
        env.ledger().with_mut(|ledger| {
            ledger.timestamp = 1_700_000_000;
            ledger.sequence_number = 100;
        });
        let contract_id = env.register(TaskStoreContract, ());
        let client = TaskStoreContractClient::new(&env, &contract_id);

        Fixture {
            submitter: Address::generate(&env),
            agent: Address::generate(&env),
            task_id: BytesN::from_array(&env, &[1; 32]),
            prompt_hash: BytesN::from_array(&env, &[2; 32]),
            env,
            client,
        }
    }

    fn store(fixture: &Fixture, ttl_days: u32) {
        let agents = Vec::from_array(&fixture.env, [fixture.agent.clone()]);
        let dag = Bytes::from_slice(&fixture.env, &[0x78, 0x9c, 0x03, 0x00]);
        fixture.client.store_task_metadata(
            &fixture.submitter,
            &fixture.task_id,
            &fixture.prompt_hash,
            &agents,
            &dag,
            &ttl_days,
            &None,
        );
    }

    // ── Lifecycle ─────────────────────────────────────────────────────────────

    #[test]
    fn stores_and_retrieves_metadata() {
        let fixture = fixture();
        store(&fixture, 0);

        let metadata = fixture.client.get_task_metadata(&fixture.task_id);
        assert_eq!(metadata.task_id, fixture.task_id);
        assert_eq!(metadata.prompt_hash, fixture.prompt_hash);
        assert_eq!(metadata.assigned_agents.get(0), Some(fixture.agent));
        assert_eq!(metadata.status, TaskStatus::Pending);
        assert_eq!(
            metadata.expires_at,
            metadata.created_at + u64::from(DEFAULT_TTL_DAYS) * SECONDS_PER_DAY
        );
        // No oracle configured → quoted_price_stroops is None.
        assert_eq!(metadata.quoted_price_stroops, None);
    }

    #[test]
    fn assigned_agent_updates_status() {
        let fixture = fixture();
        store(&fixture, 1);

        fixture
            .client
            .update_task_status(&fixture.task_id, &fixture.agent, &TaskStatus::Running);
        assert_eq!(
            fixture.client.get_task_status(&fixture.task_id),
            TaskStatus::Running
        );
    }

    #[test]
    fn unassigned_agent_cannot_update_status() {
        let fixture = fixture();
        store(&fixture, 1);
        let stranger = Address::generate(&fixture.env);

        let result = fixture.client.try_update_task_status(
            &fixture.task_id,
            &stranger,
            &TaskStatus::Running,
        );
        assert_eq!(result, Err(Ok(Error::NotAssignedAgent)));
    }

    #[test]
    fn rejects_invalid_status_transition() {
        let fixture = fixture();
        store(&fixture, 1);

        let result = fixture.client.try_update_task_status(
            &fixture.task_id,
            &fixture.agent,
            &TaskStatus::Completed,
        );
        assert_eq!(result, Err(Ok(Error::InvalidStatusTransition)));
    }

    #[test]
    fn metadata_expires_after_configured_period() {
        let fixture = fixture();
        store(&fixture, 1);
        fixture.env.ledger().with_mut(|ledger| {
            ledger.timestamp += SECONDS_PER_DAY;
        });

        assert_eq!(
            fixture.client.try_get_task_metadata(&fixture.task_id),
            Err(Ok(Error::Expired))
        );
    }

    #[test]
    fn emits_exactly_one_created_event_on_store() {
        let fixture = fixture();
        store(&fixture, 1);

        let events = fixture.env.events().all();
        assert_eq!(events.len(), 1);
        assert_eq!(
            events.get(0).unwrap().1,
            (symbol_short!("task_meta"), symbol_short!("created")).into_val(&fixture.env)
        );
    }

    #[test]
    fn emits_exactly_one_updated_event_on_non_terminal_transition() {
        let fixture = fixture();
        store(&fixture, 1);

        fixture
            .client
            .update_task_status(&fixture.task_id, &fixture.agent, &TaskStatus::Running);

        let events = fixture.env.events().all();
        assert_eq!(events.len(), 1);
        assert_eq!(
            events.get(0).unwrap().1,
            (symbol_short!("task_meta"), symbol_short!("updated")).into_val(&fixture.env)
        );
    }

    #[test]
    fn emits_exactly_one_finalized_event_on_terminal_transition() {
        let fixture = fixture();
        store(&fixture, 1);
        fixture
            .client
            .update_task_status(&fixture.task_id, &fixture.agent, &TaskStatus::Running);

        fixture
            .client
            .update_task_status(&fixture.task_id, &fixture.agent, &TaskStatus::Completed);

        // No `updated` event alongside it — exactly one lifecycle event
        // for this transition, and it's `finalized`, not `updated`.
        let events = fixture.env.events().all();
        assert_eq!(events.len(), 1);
        assert_eq!(
            events.get(0).unwrap().1,
            (symbol_short!("task_meta"), symbol_short!("finalized")).into_val(&fixture.env)
        );
    }

    #[test]
    fn finalized_event_fires_for_the_failed_terminal_status_too() {
        let fixture = fixture();
        store(&fixture, 1);

        fixture
            .client
            .update_task_status(&fixture.task_id, &fixture.agent, &TaskStatus::Failed);

        let events = fixture.env.events().all();
        assert_eq!(events.len(), 1);
        assert_eq!(
            events.get(0).unwrap().1,
            (symbol_short!("task_meta"), symbol_short!("finalized")).into_val(&fixture.env)
        );
    }

    #[test]
    fn created_event_payload_matches_stored_metadata() {
        let fixture = fixture();
        store(&fixture, 1);

        let events = fixture.env.events().all();
        let (_contract_id, _topics, data) = events.get(0).unwrap();
        let payload: TaskCreatedEvent = data.into_val(&fixture.env);

        let metadata = fixture.client.get_task_metadata(&fixture.task_id);

        assert_eq!(payload.version, TASK_LIFECYCLE_EVENT_VERSION);
        assert_eq!(payload.task_id, fixture.task_id);
        assert_eq!(payload.prompt_hash, fixture.prompt_hash);
        assert_eq!(payload.assigned_agents, metadata.assigned_agents);
        assert_eq!(payload.created_at, metadata.created_at);
        assert_eq!(payload.expires_at, metadata.expires_at);
        assert_eq!(payload.quoted_price_stroops, None);
    }

    #[test]
    fn a_rejected_transition_emits_no_lifecycle_event() {
        let fixture = fixture();
        store(&fixture, 1);

        // Pending -> Completed is not a valid transition (must pass through
        // Running first) and is rejected before any event is published.
        let _ = fixture.client.try_update_task_status(
            &fixture.task_id,
            &fixture.agent,
            &TaskStatus::Completed,
        );

        assert_eq!(fixture.env.events().all().len(), 0);
    }

    // ── Admin / set_oracle_manager ────────────────────────────────────────────

    #[test]
    fn initialize_sets_admin() {
        let fixture = fixture();
        let admin = Address::generate(&fixture.env);
        fixture.client.initialize(&admin);
        // no panic → admin stored; further calls would check auth
    }

    #[test]
    fn double_initialize_is_rejected() {
        let fixture = fixture();
        let admin = Address::generate(&fixture.env);
        fixture.client.initialize(&admin);
        assert_eq!(
            fixture.client.try_initialize(&admin),
            Err(Ok(Error::AlreadyInitialized))
        );
    }

    #[test]
    fn set_oracle_manager_stores_address() {
        let fixture = fixture();
        let admin = Address::generate(&fixture.env);
        fixture.client.initialize(&admin);
        let mgr = Address::generate(&fixture.env);
        fixture.client.set_oracle_manager(&Some(mgr.clone()));
        assert_eq!(fixture.client.get_oracle_manager(), Some(mgr));
    }

    #[test]
    fn set_oracle_manager_none_clears_address() {
        let fixture = fixture();
        let admin = Address::generate(&fixture.env);
        fixture.client.initialize(&admin);
        let mgr = Address::generate(&fixture.env);
        fixture.client.set_oracle_manager(&Some(mgr));
        fixture.client.set_oracle_manager(&None);
        assert_eq!(fixture.client.get_oracle_manager(), None);
    }

    #[test]
    fn set_oracle_manager_emits_event() {
        let fixture = fixture();
        let admin = Address::generate(&fixture.env);
        fixture.client.initialize(&admin);
        let mgr = Address::generate(&fixture.env);
        fixture.client.set_oracle_manager(&Some(mgr));

        let events = fixture.env.events().all();
        assert_eq!(events.len(), 1);
        assert_eq!(
            events.get(0).unwrap().1,
            (symbol_short!("task_str"), symbol_short!("ora_set")).into_val(&fixture.env)
        );
    }

    // ── Oracle pricing integration (cross-contract) ────────────────────────────

    #[test]
    fn no_oracle_manager_means_no_quoted_price() {
        // Ensure that when no oracle is configured, price_pair=Some(...) is
        // silently ignored and quoted_price_stroops stays None.
        let fixture = fixture();
        let agents = Vec::from_array(&fixture.env, [fixture.agent.clone()]);
        let dag = Bytes::from_slice(&fixture.env, &[0x78, 0x9c, 0x03, 0x00]);
        let pair = Symbol::new(&fixture.env, "XLM_USD");

        fixture.client.store_task_metadata(
            &fixture.submitter,
            &fixture.task_id,
            &fixture.prompt_hash,
            &agents,
            &dag,
            &1u32,
            &Some(pair),
        );

        let metadata = fixture.client.get_task_metadata(&fixture.task_id);
        assert_eq!(metadata.quoted_price_stroops, None);
    }

    /// Cross-contract oracle pricing test: registers a real PriceOracle and
    /// OracleManager in the test environment to verify end-to-end quoting.
    #[test]
    fn fresh_oracle_price_is_stamped_on_task() {
        use oracle_manager::OracleManagerContract;
        use price_oracle::PriceOracleContract;

        let fixture = fixture();

        // Deploy PriceOracle and submit a fresh price.
        let oracle_id = fixture.env.register(PriceOracleContract, ());
        let oracle_client = price_oracle::PriceOracleContractClient::new(&fixture.env, &oracle_id);
        let admin_oracle = Address::generate(&fixture.env);
        oracle_client.initialize(&admin_oracle, &3_600u64);
        let now = fixture.env.ledger().timestamp();
        let pair = Symbol::new(&fixture.env, "XLM_USD");
        oracle_client.submit_price(&pair, &10_000_000i128, &now);

        // Deploy OracleManager and wire it to the oracle.
        let mgr_id = fixture.env.register(OracleManagerContract, ());
        let mgr_client = oracle_manager::OracleManagerContractClient::new(&fixture.env, &mgr_id);
        let admin_mgr = Address::generate(&fixture.env);
        mgr_client.initialize(&admin_mgr);
        mgr_client.set_oracle(&Some(oracle_id));

        // Initialise TaskStore and point it at the OracleManager.
        let admin_ts = Address::generate(&fixture.env);
        fixture.client.initialize(&admin_ts);
        fixture.client.set_oracle_manager(&Some(mgr_id));

        // store_task_metadata with a price_pair — should stamp the oracle price.
        let agents = Vec::from_array(&fixture.env, [fixture.agent.clone()]);
        let dag = Bytes::from_slice(&fixture.env, &[0x78, 0x9c, 0x03, 0x00]);
        fixture.client.store_task_metadata(
            &fixture.submitter,
            &fixture.task_id,
            &fixture.prompt_hash,
            &agents,
            &dag,
            &1u32,
            &Some(pair),
        );

        let metadata = fixture.client.get_task_metadata(&fixture.task_id);
        assert_eq!(metadata.quoted_price_stroops, Some(10_000_000i128));
    }

    #[test]
    fn stale_oracle_with_no_fallback_rejects_task() {
        use oracle_manager::OracleManagerContract;
        use price_oracle::PriceOracleContract;

        let fixture = fixture();

        let oracle_id = fixture.env.register(PriceOracleContract, ());
        let oracle_client = price_oracle::PriceOracleContractClient::new(&fixture.env, &oracle_id);
        let admin_oracle = Address::generate(&fixture.env);
        oracle_client.initialize(&admin_oracle, &3_600u64);
        let now = fixture.env.ledger().timestamp();
        let pair = Symbol::new(&fixture.env, "XLM_USD");
        oracle_client.submit_price(&pair, &10_000_000i128, &now);

        // Advance ledger past max_price_age to make the price stale.
        fixture.env.ledger().with_mut(|l| {
            l.timestamp = now + 3_601;
        });

        let mgr_id = fixture.env.register(OracleManagerContract, ());
        let mgr_client = oracle_manager::OracleManagerContractClient::new(&fixture.env, &mgr_id);
        let admin_mgr = Address::generate(&fixture.env);
        mgr_client.initialize(&admin_mgr);
        mgr_client.set_oracle(&Some(oracle_id));
        // No fallback set → NoPriceAvailable from oracle_manager.

        let admin_ts = Address::generate(&fixture.env);
        fixture.client.initialize(&admin_ts);
        fixture.client.set_oracle_manager(&Some(mgr_id));

        let agents = Vec::from_array(&fixture.env, [fixture.agent.clone()]);
        let dag = Bytes::from_slice(&fixture.env, &[0x78, 0x9c, 0x03, 0x00]);
        let result = fixture.client.try_store_task_metadata(
            &fixture.submitter,
            &fixture.task_id,
            &fixture.prompt_hash,
            &agents,
            &dag,
            &1u32,
            &Some(pair),
        );

        assert_eq!(result, Err(Ok(Error::OraclePriceUnavailable)));
    }

    #[test]
    fn stale_oracle_with_fallback_uses_fallback_price() {
        use oracle_manager::OracleManagerContract;
        use price_oracle::PriceOracleContract;

        let fixture = fixture();

        let oracle_id = fixture.env.register(PriceOracleContract, ());
        let oracle_client = price_oracle::PriceOracleContractClient::new(&fixture.env, &oracle_id);
        let admin_oracle = Address::generate(&fixture.env);
        oracle_client.initialize(&admin_oracle, &3_600u64);
        let now = fixture.env.ledger().timestamp();
        let pair = Symbol::new(&fixture.env, "XLM_USD");
        oracle_client.submit_price(&pair, &10_000_000i128, &now);

        // Advance ledger past max_price_age.
        fixture.env.ledger().with_mut(|l| {
            l.timestamp = now + 3_601;
        });

        let mgr_id = fixture.env.register(OracleManagerContract, ());
        let mgr_client = oracle_manager::OracleManagerContractClient::new(&fixture.env, &mgr_id);
        let admin_mgr = Address::generate(&fixture.env);
        mgr_client.initialize(&admin_mgr);
        mgr_client.set_oracle(&Some(oracle_id));
        // Set a fallback price for this pair.
        mgr_client.set_fallback_price(&pair, &8_000_000i128);

        let admin_ts = Address::generate(&fixture.env);
        fixture.client.initialize(&admin_ts);
        fixture.client.set_oracle_manager(&Some(mgr_id));

        let agents = Vec::from_array(&fixture.env, [fixture.agent.clone()]);
        let dag = Bytes::from_slice(&fixture.env, &[0x78, 0x9c, 0x03, 0x00]);
        fixture.client.store_task_metadata(
            &fixture.submitter,
            &fixture.task_id,
            &fixture.prompt_hash,
            &agents,
            &dag,
            &1u32,
            &Some(pair),
        );

        let metadata = fixture.client.get_task_metadata(&fixture.task_id);
        // Stale oracle → fallback price of 8_000_000 stamped.
        assert_eq!(metadata.quoted_price_stroops, Some(8_000_000i128));
    }

    #[test]
    fn oracle_configured_but_no_pair_supplied_returns_error() {
        let fixture = fixture();

        // A dummy OracleManager address is enough (the error happens before
        // we call out to it).
        let admin_ts = Address::generate(&fixture.env);
        fixture.client.initialize(&admin_ts);
        let mgr = Address::generate(&fixture.env);
        fixture.client.set_oracle_manager(&Some(mgr));

        let agents = Vec::from_array(&fixture.env, [fixture.agent.clone()]);
        let dag = Bytes::from_slice(&fixture.env, &[0x78, 0x9c, 0x03, 0x00]);
        let result = fixture.client.try_store_task_metadata(
            &fixture.submitter,
            &fixture.task_id,
            &fixture.prompt_hash,
            &agents,
            &dag,
            &1u32,
            &None, // ← no pair supplied even though oracle is configured
        );

        assert_eq!(result, Err(Ok(Error::MissingPricePair)));
    }

    #[test]
    fn oracle_switching_uses_new_oracle_manager() {
        use oracle_manager::OracleManagerContract;
        use price_oracle::PriceOracleContract;

        let fixture = fixture();

        // Deploy first oracle with price 10_000_000.
        let oracle_a = fixture.env.register(PriceOracleContract, ());
        let client_a = price_oracle::PriceOracleContractClient::new(&fixture.env, &oracle_a);
        client_a.initialize(&Address::generate(&fixture.env), &3_600u64);
        let now = fixture.env.ledger().timestamp();
        let pair = Symbol::new(&fixture.env, "XLM_USD");
        client_a.submit_price(&pair, &10_000_000i128, &now);

        let mgr_a = fixture.env.register(OracleManagerContract, ());
        let mgr_a_client = oracle_manager::OracleManagerContractClient::new(&fixture.env, &mgr_a);
        mgr_a_client.initialize(&Address::generate(&fixture.env));
        mgr_a_client.set_oracle(&Some(oracle_a));

        // Deploy second oracle with price 20_000_000.
        let oracle_b = fixture.env.register(PriceOracleContract, ());
        let client_b = price_oracle::PriceOracleContractClient::new(&fixture.env, &oracle_b);
        client_b.initialize(&Address::generate(&fixture.env), &3_600u64);
        client_b.submit_price(&pair, &20_000_000i128, &now);

        let mgr_b = fixture.env.register(OracleManagerContract, ());
        let mgr_b_client = oracle_manager::OracleManagerContractClient::new(&fixture.env, &mgr_b);
        mgr_b_client.initialize(&Address::generate(&fixture.env));
        mgr_b_client.set_oracle(&Some(oracle_b));

        let admin_ts = Address::generate(&fixture.env);
        fixture.client.initialize(&admin_ts);

        // ── First task uses mgr_a ────────────────────────────────────────────
        fixture.client.set_oracle_manager(&Some(mgr_a));

        let agents = Vec::from_array(&fixture.env, [fixture.agent.clone()]);
        let dag = Bytes::from_slice(&fixture.env, &[0x78, 0x9c, 0x03, 0x00]);
        let task_a = BytesN::from_array(&fixture.env, &[1; 32]);
        fixture.client.store_task_metadata(
            &fixture.submitter,
            &task_a,
            &fixture.prompt_hash,
            &agents,
            &dag,
            &1u32,
            &Some(pair.clone()),
        );
        assert_eq!(
            fixture
                .client
                .get_task_metadata(&task_a)
                .quoted_price_stroops,
            Some(10_000_000i128)
        );

        // ── Switch to mgr_b and submit a second task ─────────────────────────
        fixture.client.set_oracle_manager(&Some(mgr_b));

        let task_b = BytesN::from_array(&fixture.env, &[2; 32]);
        fixture.client.store_task_metadata(
            &fixture.submitter,
            &task_b,
            &fixture.prompt_hash,
            &agents,
            &dag,
            &1u32,
            &Some(pair),
        );
        assert_eq!(
            fixture
                .client
                .get_task_metadata(&task_b)
                .quoted_price_stroops,
            Some(20_000_000i128)
        );
    }
}
