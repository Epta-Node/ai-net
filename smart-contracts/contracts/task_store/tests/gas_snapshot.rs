//! Gas snapshots for the task_store hot paths (Issue #773).

use contract_test_utils::gas::{assert_snapshot, reset};
use soroban_sdk::{testutils::Address as _, Address, Bytes, BytesN, Env, Vec};
use task_store::{TaskStatus, TaskStoreContract, TaskStoreContractClient};

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

#[test]
fn task_store_gas_snapshots() {
    let (env, client) = setup();
    let submitter = Address::generate(&env);

    let dag_task = task_id(&env, 1);
    reset(&env);
    store(&env, &client, &submitter, &dag_task);
    assert_snapshot(&env, "task_store", "store_task_metadata");

    reset(&env);
    client.get_task_metadata(&dag_task);
    assert_snapshot(&env, "task_store", "get_task_metadata");

    reset(&env);
    client.update_task_status(&dag_task, &submitter, &TaskStatus::Running);
    assert_snapshot(&env, "task_store", "update_task_status");

    reset(&env);
    client.create_task(
        &task_id(&env, 2),
        &submitter,
        &BytesN::from_array(&env, &[7; 32]),
        &1_000_000,
    );
    assert_snapshot(&env, "task_store", "create_task");
}
