#![no_std]
// Soroban contract entrypoints can legitimately have more than 7 parameters;
// suppress this lint for the whole crate rather than annotating every generated
// client function individually.
#![allow(clippy::too_many_arguments)]

//! # Task Store Contract
//!
//! Tracks the on-chain lifecycle of AI-net tasks. Every accepted state
//! transition is appended to a per-task, append-only version history, so the
//! sequence `created -> queued -> assigned -> running -> completed | failed |
//! cancelled` is reconstructable after the fact and cannot be rewritten.
//!
//! ## Two submission paths, one history
//!
//! * [`create_task`](TaskStoreContract::create_task) stores a budget-based
//!   record ([`TaskRecord`]) and is the entrypoint the lifecycle audit trail is
//!   built around.
//! * [`store_task_metadata`](TaskStoreContract::store_task_metadata) stores a
//!   DAG plus an assigned-agent list ([`TaskMetadata`]) and optionally stamps an
//!   oracle price.
//!
//! Both write to the same status enum, the same transition table, the same
//! per-task version history and the same per-creator task index, so
//! [`get_history`](TaskStoreContract::get_history) and
//! [`get_tasks_by_creator`](TaskStoreContract::get_tasks_by_creator) work
//! uniformly across them. They keep separate storage slots, so one path can
//! never overwrite the other.
//!
//! ## Authorization
//!
//! [`update_status`](TaskStoreContract::update_status) accepts an updater that
//! is either the task's own creator or the coordinator address configured by the
//! admin via [`set_coordinator`](TaskStoreContract::set_coordinator). The
//! DAG-based [`update_task_status`](TaskStoreContract::update_task_status)
//! additionally accepts the agents assigned to that task. Every mutation
//! requires the acting address to sign, via `require_auth()`.
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

pub mod gas;
mod types;

#[cfg(test)]
mod tests;

pub use types::{
    CoordinatorSetEvent, DataKey, Error, LifecycleStatusChangedEvent, LifecycleTaskCreatedEvent,
    OracleManagerSetEvent, TaskCreatedEvent, TaskFinalizedEvent, TaskMetadata, TaskPage,
    TaskRecord, TaskStatus, TaskUpdatedEvent, TaskVersionRecord, TaskWithHistory, DEFAULT_TTL_DAYS,
    LEDGERS_PER_DAY, MAX_COMPRESSED_DAG_BYTES, MAX_HISTORY_RECORDS, MAX_TASKS_PAGE_SIZE,
    MAX_TRACKED_TASKS_PER_CREATOR, MAX_TTL_DAYS, TASK_LIFECYCLE_EVENT_VERSION,
};

use soroban_sdk::{
    contract, contractimpl, symbol_short, Address, Bytes, BytesN, Env, IntoVal, String, Symbol,
    Val, Vec,
};

const SECONDS_PER_DAY: u64 = 86_400;
const CONTRACT_VERSION: &str = "1.0.0";
const MAX_TASK_QUERY_BATCH: u32 = 50;

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

/// Retention window for a budget-based task, in seconds after `created_at`.
///
/// Lifecycle tasks are given the same default retention as DAG tasks; they
/// carry no caller-supplied TTL because the audit trail, not the rent, is the
/// point of the record.
fn lifecycle_expires_at(created_at: u64) -> u64 {
    created_at.saturating_add(u64::from(DEFAULT_TTL_DAYS).saturating_mul(SECONDS_PER_DAY))
}

fn read_record(env: &Env, task_id: &BytesN<32>) -> Result<TaskRecord, Error> {
    let record: TaskRecord = env
        .storage()
        .persistent()
        .get(&DataKey::LifecycleTask(task_id.clone()))
        .ok_or(Error::NotFound)?;

    if env.ledger().timestamp() >= lifecycle_expires_at(record.created_at) {
        return Err(Error::Expired);
    }

    Ok(record)
}

/// Existence-and-expiry gate for reads that have to work across both submission
/// paths, such as `get_history` and `get_task_creator`.
fn require_live_task(env: &Env, task_id: &BytesN<32>) -> Result<(), Error> {
    if env
        .storage()
        .persistent()
        .has(&DataKey::LifecycleTask(task_id.clone()))
    {
        read_record(env, task_id).map(|_| ())
    } else {
        read_metadata(env, task_id).map(|_| ())
    }
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

/// Ledgers remaining before `expires_at`, used to keep the auxiliary
/// version-history keys alive exactly as long as the task record itself.
fn remaining_ledgers(env: &Env, expires_at: u64) -> u32 {
    let seconds_left = expires_at.saturating_sub(env.ledger().timestamp());
    let days_left = (seconds_left / SECONDS_PER_DAY) as u32;
    days_left.saturating_mul(LEDGERS_PER_DAY)
}

fn read_history(env: &Env, task_id: &BytesN<32>) -> Vec<TaskVersionRecord> {
    env.storage()
        .persistent()
        .get(&DataKey::TaskHistory(task_id.clone()))
        .unwrap_or_else(|| Vec::new(env))
}

/// Append one record to a task's append-only version history and return the
/// resulting number of records, which is the task's current version.
///
/// This is the only writer of [`DataKey::TaskHistory`]. No entry is ever
/// overwritten or removed, so the history is an immutable audit trail of the
/// status transitions the contract accepted.
fn append_version(
    env: &Env,
    task_id: &BytesN<32>,
    status: TaskStatus,
    updater: &Address,
    expires_at: u64,
) -> u32 {
    let history_key = DataKey::TaskHistory(task_id.clone());
    let mut history = read_history(env, task_id);
    let count_key = DataKey::TaskVersionCount(task_id.clone());
    let seq: u32 = env.storage().persistent().get(&count_key).unwrap_or(0);

    // Defensive only: the state machine admits at most five records, so the
    // history can never legitimately reach this cap. If it somehow did, report
    // the unchanged version so `TaskRecord::version` stays equal to the number
    // of records actually retained.
    if history.len() >= MAX_HISTORY_RECORDS {
        return seq;
    }

    let next_seq = seq.saturating_add(1);

    history.push_back(TaskVersionRecord {
        seq: next_seq,
        status,
        timestamp: env.ledger().timestamp(),
        ledger_sequence: env.ledger().sequence(),
        updater: updater.clone(),
    });

    let ledgers = remaining_ledgers(env, expires_at);
    env.storage().persistent().set(&history_key, &history);
    env.storage().persistent().set(&count_key, &next_seq);
    for key in [history_key, count_key] {
        env.storage()
            .persistent()
            .extend_ttl(&key, ledgers.saturating_sub(1), ledgers);
    }

    next_seq
}

/// Record the creator of a task and add it to that creator's task index.
///
/// The index is a persistent vector, so it is capped at
/// [`MAX_TRACKED_TASKS_PER_CREATOR`] with oldest-first eviction rather than
/// growing without limit.
fn index_creator_task(env: &Env, creator: &Address, task_id: &BytesN<32>, expires_at: u64) {
    env.storage()
        .persistent()
        .set(&DataKey::TaskCreator(task_id.clone()), creator);

    let key = DataKey::CreatorTasks(creator.clone());
    let mut ids: Vec<BytesN<32>> = env
        .storage()
        .persistent()
        .get(&key)
        .unwrap_or_else(|| Vec::new(env));

    if ids.len() >= MAX_TRACKED_TASKS_PER_CREATOR {
        ids.remove(0);
    }
    ids.push_back(task_id.clone());
    env.storage().persistent().set(&key, &ids);

    let ledgers = remaining_ledgers(env, expires_at);
    env.storage()
        .persistent()
        .extend_ttl(&key, ledgers.saturating_sub(1), ledgers);
}

/// The lifecycle state machine.
///
/// A task walks `Created -> Queued -> Assigned -> Running` and then leaves for
/// exactly one terminal status (`Completed`, `Failed` or `Cancelled`). The
/// table is deliberately non-linear in two places: `Created -> Assigned` allows
/// a caller to publish and assign in one step, and `Queued -> Running` allows
/// an already-assigned task to skip the redundant re-queue. Everything not
/// listed here is rejected, including every jump that would skip execution
/// (`Created -> Completed`) and every transition out of a terminal status
/// (`Completed -> Running`).
fn can_transition(from: TaskStatus, to: TaskStatus) -> bool {
    use TaskStatus::{Assigned, Cancelled, Completed, Created, Failed, Queued, Running};

    match from {
        Created => matches!(to, Queued | Assigned | Cancelled | Failed),
        Queued => matches!(to, Assigned | Running | Cancelled | Failed),
        Assigned => matches!(to, Running | Cancelled | Failed),
        Running => matches!(to, Completed | Failed | Cancelled),
        Completed | Failed | Cancelled => false,
    }
}

/// Reject any transition the state machine does not admit.
fn ensure_transition(from: TaskStatus, to: TaskStatus) -> Result<(), Error> {
    if !can_transition(from, to) {
        return Err(Error::InvalidStatusTransition);
    }
    Ok(())
}

/// True when `addr` is the coordinator address configured by the admin.
fn is_coordinator(env: &Env, addr: &Address) -> bool {
    env.storage()
        .instance()
        .get::<DataKey, Address>(&DataKey::Coordinator)
        .as_ref()
        == Some(addr)
}

/// Authorize a status update.
///
/// The creator of the task and the configured coordinator may always drive a
/// transition. The agents in `assigned_agents` may additionally drive
/// DAG-based tasks, because assignment is what entitles an agent to report on
/// it. Anyone else is rejected with `denied`.
fn ensure_can_update(
    env: &Env,
    updater: &Address,
    creator: Option<&Address>,
    assigned_agents: Option<&Vec<Address>>,
    denied: Error,
) -> Result<(), Error> {
    if creator.is_some_and(|creator| creator == updater) || is_coordinator(env, updater) {
        return Ok(());
    }
    if assigned_agents.is_some_and(|agents| agents.contains(updater)) {
        return Ok(());
    }
    Err(denied)
}

fn read_admin(env: &Env) -> Result<Address, Error> {
    env.storage()
        .instance()
        .get(&DataKey::Admin)
        .ok_or(Error::NotInitialized)
}

fn require_admin(env: &Env) -> Result<Address, Error> {
    let admin = read_admin(env)?;
    admin.require_auth();
    Ok(admin)
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
    /// Initialise the contract with an admin. Can only be called once.
    pub fn initialize(env: Env, admin: Address) -> Result<(), Error> {
        if env.storage().instance().has(&DataKey::Admin) {
            return Err(Error::AlreadyInitialized);
        }
        env.storage().instance().set(&DataKey::Admin, &admin);
        env.storage().instance().set(&DataKey::Paused, &false);
        env.storage()
            .instance()
            .set(&DataKey::Version, &String::from_str(&env, CONTRACT_VERSION));
        env.events()
            .publish((symbol_short!("task_meta"), symbol_short!("init")), admin);
        Ok(())
    }

    pub fn admin(env: Env) -> Option<Address> {
        env.storage().instance().get(&DataKey::Admin)
    }

    /// Return the current admin address, if set.
    pub fn get_admin(env: Env) -> Option<Address> {
        Self::admin(env)
    }

    /// Pause the contract. Only admin can call this.
    pub fn pause(env: Env) -> Result<(), Error> {
        require_admin(&env)?;
        env.storage().instance().set(&DataKey::Paused, &true);
        env.events()
            .publish((symbol_short!("task_meta"), symbol_short!("paused")), ());
        Ok(())
    }

    /// Unpause the contract. Only admin can call this.
    pub fn unpause(env: Env) -> Result<(), Error> {
        require_admin(&env)?;
        env.storage().instance().set(&DataKey::Paused, &false);
        env.events()
            .publish((symbol_short!("task_meta"), symbol_short!("unpaused")), ());
        Ok(())
    }

    /// Returns whether the contract is currently paused.
    pub fn is_paused(env: Env) -> bool {
        env.storage()
            .instance()
            .get(&DataKey::Paused)
            .unwrap_or(false)
    }

    pub fn set_oracle_manager(env: Env, oracle_manager: Option<Address>) -> Result<(), Error> {
        require_admin(&env)?;
        match &oracle_manager {
            Some(addr) => env.storage().instance().set(&DataKey::OracleManager, addr),
            None => env.storage().instance().remove(&DataKey::OracleManager),
        }
        env.events().publish(
            (symbol_short!("task_meta"), symbol_short!("ora_set")),
            OracleManagerSetEvent { oracle_manager },
        );
        Ok(())
    }

    pub fn get_oracle_manager(env: Env) -> Option<Address> {
        env.storage().instance().get(&DataKey::OracleManager)
    }

    /// Set (or clear) the coordinator address.
    ///
    /// The coordinator is the off-chain service allowed to drive status
    /// transitions on tasks it did not create, e.g. to move a task to
    /// `Assigned` once bidding has closed. It can never move a task out of a
    /// terminal status, because the transition table rejects that regardless of
    /// who asks. Admin only.
    pub fn set_coordinator(env: Env, coordinator: Option<Address>) -> Result<(), Error> {
        require_admin(&env)?;
        match &coordinator {
            Some(addr) => env.storage().instance().set(&DataKey::Coordinator, addr),
            None => env.storage().instance().remove(&DataKey::Coordinator),
        }
        env.events().publish(
            (symbol_short!("task_str"), symbol_short!("coord_set")),
            CoordinatorSetEvent { coordinator },
        );
        Ok(())
    }

    pub fn get_coordinator(env: Env) -> Option<Address> {
        env.storage().instance().get(&DataKey::Coordinator)
    }

    pub fn contract_version(env: Env) -> String {
        env.storage()
            .instance()
            .get(&DataKey::Version)
            .unwrap_or_else(|| String::from_str(&env, CONTRACT_VERSION))
    }

    pub fn upgrade(env: Env, new_wasm_hash: BytesN<32>, new_version: String) -> Result<(), Error> {
        let admin = require_admin(&env)?;
        let old_version = Self::contract_version(env.clone());
        env.deployer()
            .update_current_contract_wasm(new_wasm_hash.clone());
        env.storage()
            .instance()
            .set(&DataKey::Version, &new_version);
        env.events().publish(
            (symbol_short!("task_meta"), symbol_short!("upgraded")),
            (
                old_version,
                new_version,
                new_wasm_hash,
                admin,
                env.ledger().sequence(),
            ),
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
        require_not_paused(&env)?;
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
            // The caller supplies a non-empty agent list, so the task is born
            // `Assigned` rather than `Created`/`Queued`.
            status: TaskStatus::Assigned,
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

        // Seed the append-only version history and the creator's task index.
        // A task always begins with exactly one record, at `Assigned`.
        index_creator_task(&env, &submitter, &task_id, expires_at);
        append_version(&env, &task_id, TaskStatus::Assigned, &submitter, expires_at);

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

    /// Read a bounded set of task records in one invocation.
    pub fn get_task_metadata_batch(
        env: Env,
        task_ids: Vec<BytesN<32>>,
    ) -> Result<Vec<TaskMetadata>, Error> {
        if task_ids.len() > MAX_TASK_QUERY_BATCH {
            return Err(Error::BatchTooLarge);
        }
        let mut result = Vec::new(&env);
        for task_id in task_ids.iter() {
            result.push_back(read_metadata(&env, &task_id)?);
        }
        Ok(result)
    }

    /// Estimate the CPU-instruction cost of `operation` over `count` task
    /// records. Backed by the calibrated model in [`gas`].
    pub fn estimate_gas(_env: Env, operation: Symbol, count: u32) -> u64 {
        gas::estimate(operation, count)
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
        require_not_paused(&env)?;
        agent.require_auth();

        let key = DataKey::Task(task_id.clone());
        let mut metadata = read_metadata(&env, &task_id)?;

        // The creator and the configured coordinator may drive any transition on
        // their own task; agents may drive the task they were assigned.
        let creator: Option<Address> = env
            .storage()
            .persistent()
            .get(&DataKey::TaskCreator(task_id.clone()));
        ensure_can_update(
            &env,
            &agent,
            creator.as_ref(),
            Some(&metadata.assigned_agents),
            Error::NotAssignedAgent,
        )?;
        ensure_transition(metadata.status, new_status)?;

        let old_status = metadata.status;
        metadata.status = new_status;
        env.storage().persistent().set(&key, &metadata);

        // Record the transition in the append-only version history. Written
        // after the state update and only on the success path, so a rejected
        // transition leaves no record behind.
        append_version(&env, &task_id, new_status, &agent, metadata.expires_at);

        // Every successful transition emits exactly one lifecycle event:
        // terminal transitions (-> Completed / -> Failed / -> Cancelled) emit
        // `finalized`, everything else emits `updated`.
        let timestamp = env.ledger().timestamp();
        if new_status.is_terminal() {
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

    // ── Budget-based task lifecycle ──────────────────────────────────────────

    /// Register a new task and seed its version history.
    ///
    /// The task starts at [`TaskStatus::Created`] with exactly one history
    /// record attributed to `creator`. The budget is committed here and is
    /// immutable for the lifetime of the record; the contract does not escrow
    /// it, it only records what the creator committed to.
    ///
    /// `budget_xlm` is denominated in stroops (1 XLM = 10_000_000 stroops), the
    /// same unit as `quoted_price_stroops`, and must not be negative.
    pub fn create_task(
        env: Env,
        task_id: BytesN<32>,
        creator: Address,
        prompt_hash: BytesN<32>,
        budget_xlm: i128,
    ) -> Result<(), Error> {
        require_not_paused(&env)?;
        creator.require_auth();

        if budget_xlm < 0 {
            return Err(Error::InvalidBudget);
        }

        let key = DataKey::LifecycleTask(task_id.clone());
        if env.storage().persistent().has(&key) {
            return Err(Error::AlreadyExists);
        }

        let created_at = env.ledger().timestamp();
        let expires_at = lifecycle_expires_at(created_at);

        // Seed the audit trail and the creator's index first, so the record can
        // be written once with a `version` that already matches the history.
        index_creator_task(&env, &creator, &task_id, expires_at);
        let version = append_version(&env, &task_id, TaskStatus::Created, &creator, expires_at);

        let record = TaskRecord {
            task_id: task_id.clone(),
            creator: creator.clone(),
            prompt_hash: prompt_hash.clone(),
            budget_xlm,
            status: TaskStatus::Created,
            created_at,
            updated_at: created_at,
            version,
        };
        env.storage().persistent().set(&key, &record);

        let ledgers = remaining_ledgers(&env, expires_at);
        env.storage()
            .persistent()
            .extend_ttl(&key, ledgers.saturating_sub(1), ledgers);

        env.events().publish(
            (symbol_short!("task_life"), symbol_short!("created")),
            LifecycleTaskCreatedEvent {
                version: TASK_LIFECYCLE_EVENT_VERSION,
                task_id,
                creator,
                prompt_hash,
                budget_xlm,
                created_at,
            },
        );

        Ok(())
    }

    /// Move a task to `new_status`, appending one version record.
    ///
    /// `updater` must be the task's creator or the coordinator configured by
    /// the admin; anything else is rejected with
    /// [`Error::NotAuthorizedUpdater`]. The transition itself must be admitted
    /// by the state machine, so a terminal task can never move again and no
    /// caller can skip execution by jumping straight to `Completed`.
    pub fn update_status(
        env: Env,
        task_id: BytesN<32>,
        new_status: TaskStatus,
        updater: Address,
    ) -> Result<(), Error> {
        require_not_paused(&env)?;
        updater.require_auth();

        let key = DataKey::LifecycleTask(task_id.clone());
        let mut record = read_record(&env, &task_id)?;
        ensure_can_update(
            &env,
            &updater,
            Some(&record.creator),
            None,
            Error::NotAuthorizedUpdater,
        )?;
        ensure_transition(record.status, new_status)?;

        let from_status = record.status;
        let timestamp = env.ledger().timestamp();
        record.status = new_status;
        record.updated_at = timestamp;
        record.version = append_version(
            &env,
            &task_id,
            new_status,
            &updater,
            lifecycle_expires_at(record.created_at),
        );
        env.storage().persistent().set(&key, &record);

        env.events().publish(
            (symbol_short!("task_life"), symbol_short!("status")),
            LifecycleStatusChangedEvent {
                version: TASK_LIFECYCLE_EVENT_VERSION,
                task_id,
                record_version: record.version,
                from_status,
                to_status: new_status,
                updater,
                updated_at: timestamp,
            },
        );

        Ok(())
    }

    /// Return the full task record together with its version history.
    ///
    /// Returns `Error::NotFound` for an unknown task and `Error::Expired` once
    /// the retention window has passed. The `history` field is identical to
    /// `get_history(task_id)`; it is included so a caller can render the full
    /// audit trail from a single read.
    pub fn get_task(env: Env, task_id: BytesN<32>) -> Result<TaskWithHistory, Error> {
        let task = read_record(&env, &task_id)?;
        let history = read_history(&env, &task_id);
        Ok(TaskWithHistory { task, history })
    }

    /// Return the current status of a budget-based task.
    pub fn get_task_lifecycle_status(env: Env, task_id: BytesN<32>) -> Result<TaskStatus, Error> {
        Ok(read_record(&env, &task_id)?.status)
    }

    // ── Version history & creator index ───────────────────────────────────────

    /// Returns the append-only version history for `task_id`, oldest record
    /// first.
    ///
    /// The first record is always the one written at creation (`Created` for a
    /// [`TaskRecord`], `Assigned` for a [`TaskMetadata`]); every accepted status
    /// update appends exactly one further record. Records are never modified or
    /// deleted, so this is the task's audit trail, and it covers tasks created
    /// through either submission path.
    ///
    /// No transaction hash is included, because a Soroban contract cannot read
    /// the hash of its own invoking transaction. See [`TaskVersionRecord`] for
    /// how indexers are expected to recover it.
    ///
    /// Returns `Error::NotFound` for an unknown task and `Error::Expired` once
    /// the task's retention window has passed.
    pub fn get_history(env: Env, task_id: BytesN<32>) -> Result<Vec<TaskVersionRecord>, Error> {
        require_live_task(&env, &task_id)?;
        Ok(read_history(&env, &task_id))
    }

    /// Returns the address that created `task_id`, or `None` if the task is
    /// unknown or predates the creator index.
    pub fn get_task_creator(env: Env, task_id: BytesN<32>) -> Option<Address> {
        env.storage()
            .persistent()
            .get(&DataKey::TaskCreator(task_id))
    }

    /// Returns one page of the task ids created by `creator`, oldest first.
    ///
    /// The per-creator index is a persistent vector, so it is paginated rather
    /// than returned whole. Start with `cursor: 0`; pass the `next_cursor` from
    /// the previous page to continue, and stop when `next_cursor` is `None`.
    /// `limit` is clamped to [`MAX_TASKS_PAGE_SIZE`], and a `limit` of `0`
    /// returns an empty page that still reports `total` (useful for counting).
    ///
    /// Only the most recent [`MAX_TRACKED_TASKS_PER_CREATOR`] task ids are
    /// retained per creator; older ids are evicted from the index.
    pub fn get_tasks_by_creator(env: Env, creator: Address, cursor: u32, limit: u32) -> TaskPage {
        let ids: Vec<BytesN<32>> = env
            .storage()
            .persistent()
            .get(&DataKey::CreatorTasks(creator))
            .unwrap_or_else(|| Vec::new(&env));

        let total = ids.len();
        let page_size = limit.min(MAX_TASKS_PAGE_SIZE);
        let start = cursor.min(total);
        let end = start.saturating_add(page_size).min(total);

        let mut task_ids = Vec::new(&env);
        let mut index = start;
        while index < end {
            if let Some(id) = ids.get(index) {
                task_ids.push_back(id);
            }
            index += 1;
        }

        TaskPage {
            task_ids,
            total,
            next_cursor: if end < total { Some(end) } else { None },
        }
    }
}

impl gas_interface::GasEstimator for TaskStoreContract {
    fn estimate(operation: Symbol, params: soroban_sdk::Map<Symbol, Val>) -> u64 {
        gas::estimate(operation, params.len())
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
        assert_eq!(metadata.status, TaskStatus::Assigned);
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

        // Assigned -> Completed skips execution, so it is not admissible.
        let result = fixture.client.try_update_task_status(
            &fixture.task_id,
            &fixture.agent,
            &TaskStatus::Completed,
        );
        assert_eq!(result, Err(Ok(Error::InvalidStatusTransition)));
    }

    #[test]
    fn a_terminal_task_accepts_no_further_transitions() {
        let fixture = fixture();
        store(&fixture, 1);
        fixture
            .client
            .update_task_status(&fixture.task_id, &fixture.agent, &TaskStatus::Running);
        fixture
            .client
            .update_task_status(&fixture.task_id, &fixture.agent, &TaskStatus::Completed);

        for status in [
            TaskStatus::Running,
            TaskStatus::Failed,
            TaskStatus::Cancelled,
        ] {
            assert_eq!(
                fixture
                    .client
                    .try_update_task_status(&fixture.task_id, &fixture.agent, &status),
                Err(Ok(Error::InvalidStatusTransition))
            );
        }
    }

    #[test]
    fn a_task_can_be_cancelled_before_completing() {
        let fixture = fixture();
        store(&fixture, 1);
        fixture
            .client
            .update_task_status(&fixture.task_id, &fixture.agent, &TaskStatus::Running);

        fixture
            .client
            .update_task_status(&fixture.task_id, &fixture.agent, &TaskStatus::Cancelled);

        // Read the event buffer before the follow-up read, which would replace it.
        let events = fixture.env.events().all();
        assert_eq!(events.len(), 1);
        assert_eq!(
            events.get(0).unwrap().1,
            (symbol_short!("task_meta"), symbol_short!("finalized")).into_val(&fixture.env)
        );

        assert_eq!(
            fixture.client.get_task_status(&fixture.task_id),
            TaskStatus::Cancelled
        );
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

        // Assigned -> Completed is not a valid transition (must pass through
        // Running first) and is rejected before any event is published.
        let _ = fixture.client.try_update_task_status(
            &fixture.task_id,
            &fixture.agent,
            &TaskStatus::Completed,
        );

        assert_eq!(fixture.env.events().all().len(), 0);
    }

    #[test]
    fn initialize_sets_unpaused() {
        let fixture = fixture();
        assert!(!fixture.client.is_paused());
    }

    #[test]
    fn pause_blocks_store_task_metadata() {
        let fixture = fixture();
        let agents = Vec::from_array(&fixture.env, [fixture.agent.clone()]);
        let dag = Bytes::from_slice(&fixture.env, &[0x78, 0x9c, 0x03, 0x00]);

        fixture.client.pause();

        let result = fixture.client.try_store_task_metadata(
            &fixture.submitter,
            &fixture.task_id,
            &fixture.prompt_hash,
            &agents,
            &dag,
            &1u32,
            &None,
        );
        assert_eq!(result, Err(Ok(Error::ContractPaused)));
    }

    // ── Admin / set_oracle_manager ────────────────────────────────────────────

    #[test]
    fn initialize_sets_admin() {
        // Use a fresh env to test initialize from scratch (fixture() already calls it).
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register(TaskStoreContract, ());
        let client = TaskStoreContractClient::new(&env, &contract_id);
        let admin = Address::generate(&env);
        client.initialize(&admin);
        assert_eq!(client.get_admin(), Some(admin.clone()));
        // Both accessor names resolve to the same stored admin.
        assert_eq!(client.admin(), Some(admin));
    }

    #[test]
    fn double_initialize_is_rejected() {
        // fixture() already called initialize, so a second call should fail.
        let fixture = fixture();
        let admin = Address::generate(&fixture.env);
        assert_eq!(
            fixture.client.try_initialize(&admin),
            Err(Ok(Error::AlreadyExists))
        );
    }

    #[test]
    fn set_oracle_manager_stores_address() {
        let fixture = fixture();
        let mgr = Address::generate(&fixture.env);
        fixture.client.set_oracle_manager(&Some(mgr.clone()));
        assert_eq!(fixture.client.get_oracle_manager(), Some(mgr));
    }

    #[test]
    fn set_oracle_manager_none_clears_address() {
        let fixture = fixture();
        let mgr = Address::generate(&fixture.env);
        fixture.client.set_oracle_manager(&Some(mgr));
        fixture.client.set_oracle_manager(&None);
        assert_eq!(fixture.client.get_oracle_manager(), None);
    }

    #[test]
    fn set_oracle_manager_emits_event() {
        let fixture = fixture();
        let mgr = Address::generate(&fixture.env);
        fixture.client.set_oracle_manager(&Some(mgr));

        let events = fixture.env.events().all();
        assert_eq!(events.len(), 1);
        assert_eq!(
            events.get(0).unwrap().1,
            (symbol_short!("task_meta"), symbol_short!("ora_set")).into_val(&fixture.env)
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

        // TaskStore already initialized by fixture(); just wire up OracleManager.
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

        // TaskStore already initialized by fixture(); just wire up OracleManager.
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

        // TaskStore already initialized by fixture(); just wire up OracleManager.
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
        // we call out to it). TaskStore already initialized by fixture().
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

        // TaskStore already initialized by fixture(); just wire up OracleManager.
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

    // ── Pause / Unpause ────────────────────────────────────────────────────

    #[test]
    fn unpause_allows_store_task_metadata() {
        let fixture = fixture();
        fixture.client.pause();
        fixture.client.unpause();

        store(&fixture, 1);
        let metadata = fixture.client.get_task_metadata(&fixture.task_id);
        assert_eq!(metadata.task_id, fixture.task_id);
    }

    #[test]
    fn pause_blocks_update_task_status() {
        let fixture = fixture();
        store(&fixture, 1);

        fixture.client.pause();

        let result = fixture.client.try_update_task_status(
            &fixture.task_id,
            &fixture.agent,
            &TaskStatus::Running,
        );
        assert_eq!(result, Err(Ok(Error::ContractPaused)));
    }

    #[test]
    fn get_task_metadata_still_works_when_paused() {
        let fixture = fixture();
        store(&fixture, 1);

        fixture.client.pause();

        // Reads should still work when paused.
        let metadata = fixture.client.get_task_metadata(&fixture.task_id);
        assert_eq!(metadata.task_id, fixture.task_id);
    }
}
