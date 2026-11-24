//! Tests that the agent registry emits lifecycle events.

use agent_registry::{
    AgentRecord, AgentRegistryContract, AgentRegistryContractClient,
    DEFAULT_MIN_BOND_STROOPS,
};
use soroban_sdk::{
    testutils::{Address as _, Events},
    Address, Env, Map, Symbol,
};

fn setup() -> (Env, AgentRegistryContractClient<'static>, Address) {
    let env = Env::default();
    env.mock_all_auths();
    let contract_id = env.register(AgentRegistryContract, ());
    let client = AgentRegistryContractClient::new(&env, &contract_id);
    let admin = Address::generate(&env);
    client.initialize(&admin);
    (env, client, admin)
}

fn record(env: &Env, owner: &Address) -> AgentRecord {
    AgentRecord {
        id: Symbol::new(env, "agent_1"),
        capability: Symbol::new(env, "coding"),
        price_stroops: 1_000,
        endpoint: soroban_sdk::String::from_str(env, "https://example.com"),
        owner: owner.clone(),
        metadata: Map::new(env),
        bond_amount: DEFAULT_MIN_BOND_STROOPS,
    }
}

#[test]
fn register_update_and_deregister_emit_events() {
    let (env, client, _admin) = setup();
    let owner = Address::generate(&env);

    client.register_agent(&record(&env, &owner));
    let registration_events = env.events().all();
    assert!(!registration_events.is_empty());

    client.update_pricing(&Symbol::new(&env, "agent_1"), &2_000);
    let update_events = env.events().all();
    assert!(!update_events.is_empty());

    client.deregister_agent(&Symbol::new(&env, "agent_1"));
    let deregistration_events = env.events().all();
    assert!(!deregistration_events.is_empty());
}
