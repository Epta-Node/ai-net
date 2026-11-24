use agent_registry::{
    AgentRecord, AgentRegistryContract, AgentRegistryContractClient, DEFAULT_MIN_BOND_STROOPS,
};
use soroban_sdk::{testutils::Address as _, Address, Env, Map, String, Symbol, Vec};

#[test]
fn estimates_are_within_twenty_percent_for_registration_and_batch() {
    let env = Env::default();
    env.mock_all_auths();
    let id = env.register(AgentRegistryContract, ());
    let client = AgentRegistryContractClient::new(&env, &id);
    client.initialize(&Address::generate(&env));

    env.cost_estimate().budget().reset_tracker();
    client.register_agent(&record(&env, "gas_one", &Address::generate(&env)));
    let actual = env.cost_estimate().budget().cpu_instruction_cost();
    let estimate = client.estimate_gas(&String::from_str(&env, "register_agent"), &1);
    std::println!("registry register estimate={estimate}, actual={actual}");
    assert_within_twenty_percent(estimate, actual);

    let batch = Vec::from_array(
        &env,
        [
            record(&env, "gas_two", &Address::generate(&env)),
            record(&env, "gas_three", &Address::generate(&env)),
        ],
    );
    env.cost_estimate().budget().reset_tracker();
    client.register_agents(&batch);
    let actual = env.cost_estimate().budget().cpu_instruction_cost();
    let estimate = client.estimate_gas(&String::from_str(&env, "register_agents"), &2);
    std::println!("registry batch registration estimate={estimate}, actual={actual}");
    assert_within_twenty_percent(estimate, actual);
}

fn record(env: &Env, id: &str, owner: &Address) -> AgentRecord {
    AgentRecord {
        id: Symbol::new(env, id),
        capability: Symbol::new(env, "gas_cap"),
        price_stroops: 1_000,
        endpoint: String::from_str(env, "https://gas.example"),
        owner: owner.clone(),
        metadata: Map::new(env),
        bond_amount: DEFAULT_MIN_BOND_STROOPS,
    }
}

fn assert_within_twenty_percent(estimate: u64, actual: u64) {
    assert!(actual > 0);
    assert!(estimate.saturating_mul(100) >= actual.saturating_mul(80));
    assert!(estimate.saturating_mul(100) <= actual.saturating_mul(120));
}
