use soroban_sdk::{testutils::Address as _, Address, Bytes, BytesN, Env, Symbol, Vec};
use task_store::TaskStoreContract;

#[test]
fn estimates_are_within_twenty_percent_for_task_paths() {
    let env = Env::default();
    env.mock_all_auths();
    let id = env.register(TaskStoreContract, ());
    let client = task_store::TaskStoreContractClient::new(&env, &id);
    let submitter = Address::generate(&env);
    let agent = Address::generate(&env);
    client.initialize(&Address::generate(&env));
    let task_a = BytesN::from_array(&env, &[1; 32]);
    let task_b = BytesN::from_array(&env, &[2; 32]);
    let prompt_hash = BytesN::from_array(&env, &[3; 32]);
    let dag = Bytes::from_slice(&env, &[1, 2, 3]);
    let agents = Vec::from_array(&env, [agent.clone()]);

    env.cost_estimate().budget().reset_tracker();
    client.store_task_metadata(&submitter, &task_a, &prompt_hash, &agents, &dag, &1, &None);
    let create_actual = env.cost_estimate().budget().cpu_instruction_cost();
    let create_estimate = client.estimate_gas(&Symbol::new(&env, "create"), &1);
    std::println!("task create estimate={create_estimate}, actual={create_actual}");

    env.cost_estimate().budget().reset_tracker();
    client.get_task_metadata(&task_a);
    let query_actual = env.cost_estimate().budget().cpu_instruction_cost();
    let query_estimate = client.estimate_gas(&Symbol::new(&env, "query"), &1);
    std::println!("task query estimate={query_estimate}, actual={query_actual}");

    env.cost_estimate().budget().reset_tracker();
    client.update_task_status(&task_a, &agent, &task_store::TaskStatus::Running);
    let update_actual = env.cost_estimate().budget().cpu_instruction_cost();
    let update_estimate = client.estimate_gas(&Symbol::new(&env, "update"), &1);
    std::println!("task update estimate={update_estimate}, actual={update_actual}");

    client.store_task_metadata(&submitter, &task_b, &prompt_hash, &agents, &dag, &1, &None);
    env.cost_estimate().budget().reset_tracker();
    let ids = Vec::from_array(&env, [task_a, task_b]);
    client.get_task_metadata_batch(&ids);
    let batch_actual = env.cost_estimate().budget().cpu_instruction_cost();
    let batch_estimate = client.estimate_gas(&Symbol::new(&env, "query"), &2);
    std::println!("task batch query estimate={batch_estimate}, actual={batch_actual}");
    assert_within_twenty_percent(create_estimate, create_actual);
    assert_within_twenty_percent(query_estimate, query_actual);
    assert_within_twenty_percent(update_estimate, update_actual);
    assert_within_twenty_percent(batch_estimate, batch_actual);
}

fn assert_within_twenty_percent(estimate: u64, actual: u64) {
    assert!(actual > 0);
    assert!(estimate.saturating_mul(100) >= actual.saturating_mul(80));
    assert!(estimate.saturating_mul(100) <= actual.saturating_mul(120));
}
