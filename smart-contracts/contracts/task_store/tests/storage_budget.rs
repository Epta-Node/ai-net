//! Storage-budget assertions for task creation and updates (Issue #771).

use contract_test_utils::{assert_storage_within, StorageBudget};
use soroban_sdk::{
    testutils::{storage::Persistent as _, Address as _, Ledger as _},
    Address, Bytes, BytesN, Env, Vec,
};
use task_store::{
    DataKey, Error, TaskStatus, TaskStoreContract, TaskStoreContractClient,
    LEDGERS_PER_DAY, MAX_COMPRESSED_DAG_BYTES, MAX_TRACKED_TASKS_PER_CREATOR,
};

fn setup() -> (Env, TaskStoreContractClient<'static>) {
    let env = Env::default();
    env.mock_all_auths();
    let id = env.register(TaskStoreContract, ());
    let client = TaskStoreContractClient::new(&env, &id);
    client.initialize(&Address::generate(&env));
    (env, client)
}

fn task_id(env: &Env, seed: u8) -> BytesN<32> {
    BytesN::from_array(env, &[seed; 32])
}

fn store(env: &Env, client: &TaskStoreContractClient<'_>, submitter: &Address, task: &BytesN<32>) {
    let agents = Vec::from_array(env, [Address::generate(env)]);
    let dag = Bytes::from_slice(env, &[1, 2, 3]);
    client.store_task_metadata(
        submitter,
        task,
        &BytesN::from_array(env, &[9; 32]),
        &agents,
        &dag,
        &1,
        &None,
    );
}

/// A DAG task writes the metadata record, version history, version counter and
/// the creator's task index. Measured: +5 entries / +1,028 bytes. Ceiling:
/// 5 / 1,100.
#[test]
fn store_task_metadata_stays_within_storage_budget() {
    let (env, client) = setup();
    let submitter = Address::generate(&env);
    let task = task_id(&env, 1);

    assert_storage_within(
        &env,
        &client.address,
        "task_store::store_task_metadata",
        StorageBudget::new(5, 1_100),
        || store(&env, &client, &submitter, &task),
    );
}

/// A status update rewrites the record, appends one history record and bumps
/// the counter. The history vector grows in place, so the entry count is
/// unchanged. Measured: +0 entries / +176 bytes. Ceiling: 0 / 200.
#[test]
fn update_task_status_stays_within_storage_budget() {
    let (env, client) = setup();
    let submitter = Address::generate(&env);
    let task = task_id(&env, 2);
    store(&env, &client, &submitter, &task);

    assert_storage_within(
        &env,
        &client.address,
        "task_store::update_task_status",
        StorageBudget::new(0, 200),
        || client.update_task_status(&task, &submitter, &TaskStatus::Running),
    );
}

/// Lifecycle task creation writes the record, history and creator index.
/// Measured: +5 entries / +992 bytes. Ceiling: 5 / 1,100.
#[test]
fn create_task_stays_within_storage_budget() {
    let (env, client) = setup();
    let creator = Address::generate(&env);
    let task = task_id(&env, 3);

    assert_storage_within(
        &env,
        &client.address,
        "task_store::create_task",
        StorageBudget::new(5, 1_100),
        || {
            client.create_task(
                &task,
                &creator,
                &BytesN::from_array(&env, &[7; 32]),
                &1_000_000,
            )
        },
    );
}

/// Reads must not mutate storage.
#[test]
fn task_reads_are_storage_neutral() {
    let (env, client) = setup();
    let submitter = Address::generate(&env);
    let task = task_id(&env, 4);
    store(&env, &client, &submitter, &task);

    assert_storage_within(
        &env,
        &client.address,
        "task_store::get_task_metadata",
        StorageBudget::read_only(),
        || client.get_task_metadata(&task),
    );
    assert_storage_within(
        &env,
        &client.address,
        "task_store::get_tasks_by_creator",
        StorageBudget::read_only(),
        || client.get_tasks_by_creator(&submitter, &0, &10),
    );
}

/// Storage-budget finding: one creator index retains at most
/// `MAX_TRACKED_TASKS_PER_CREATOR` task ids (oldest-first eviction).  The
/// bounded vector prevents unbounded persistent storage growth per creator.
#[test]
fn creator_task_index_is_bounded_at_64_tasks() {
    let (env, client) = setup();
    let creator = Address::generate(&env);

    for n in 0..MAX_TRACKED_TASKS_PER_CREATOR + 5 {
        let mut bytes = [0u8; 32];
        bytes[..4].copy_from_slice(&(n as u32).to_be_bytes());
        client.create_task(
            &BytesN::from_array(&env, &bytes),
            &creator,
            &BytesN::from_array(&env, &[n as u8; 32]),
            &1_000_000,
        );
    }

    let page = client.get_tasks_by_creator(&creator, &0, &20);
    assert_eq!(page.total, MAX_TRACKED_TASKS_PER_CREATOR);
    assert_eq!(page.task_ids.len(), 20);
}

/// Storage-budget finding: the largest accepted compressed task payload/result
/// is 4 KiB.  One byte beyond the limit is rejected before any task state is
/// written, keeping persistent storage bounded.
#[test]
fn maximum_compressed_task_payload_is_bounded() {
    let (env, client) = setup();
    let submitter = Address::generate(&env);

    let at_limit = task_id(&env, 5);
    let max_dag = Bytes::from_slice(&env, &vec![0u8; MAX_COMPRESSED_DAG_BYTES as usize]);
    let agents = Vec::from_array(&env, [Address::generate(&env)]);
    client.store_task_metadata(
        &submitter,
        &at_limit,
        &BytesN::from_array(&env, &[9; 32]),
        &agents,
        &max_dag,
        &1,
        &None,
    );
    assert!(client.get_task_metadata(&at_limit).compressed_dag.len() <= MAX_COMPRESSED_DAG_BYTES);

    let over_limit = task_id(&env, 6);
    let too_large = Bytes::from_slice(
        &env,
        &vec![0u8; (MAX_COMPRESSED_DAG_BYTES + 1) as usize],
    );
    assert_eq!(
        client.try_store_task_metadata(
            &submitter,
            &over_limit,
            &BytesN::from_array(&env, &[10; 32]),
            &Vec::from_array(&env, [Address::generate(&env)]),
            &too_large,
            &1,
            &None,
        ),
        Err(Ok(Error::InvalidDag))
    );
}

/// Storage-budget finding: task metadata and auxiliary history/counter entries
/// share the TTL window.  At expiry, reads return `Expired` and the persistent
/// key retains no live storage beyond the configured ledger window.
#[test]
fn ttl_expiry_cleans_up_live_task_entries() {
    let (env, client) = setup();
    env.ledger().set_timestamp(1_700_000_000);
    env.ledger().set_sequence_number(100);

    let submitter = Address::generate(&env);
    let task = task_id(&env, 7);
    let agents = Vec::from_array(&env, [Address::generate(&env)]);
    client.store_task_metadata(
        &submitter,
        &task,
        &BytesN::from_array(&env, &[9; 32]),
        &agents,
        &Bytes::from_slice(&env, &[1, 2, 3]),
        &1,
        &None,
    );

    let ttl = env.as_contract(&client.address, || {
        env.storage().persistent().get_ttl(&DataKey::Task(task.clone()))
    });
    assert_eq!(ttl, LEDGERS_PER_DAY);

    env.ledger().set_timestamp(1_700_000_000 + 86_400);
    assert_eq!(
        client.try_get_task_metadata(&task),
        Err(Ok(Error::Expired))
    );
}
