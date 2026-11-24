//! Gas snapshots for the registry's hot entrypoints (Issue #773).
//!
//! Run with `UPDATE_GAS_BASELINES=1` to record intentional changes.

use agent_registry::{
    AgentRecord, AgentRegistryContract, AgentRegistryContractClient, DEFAULT_MIN_BOND_STROOPS,
};
use contract_test_utils::gas::{assert_snapshot, reset};
use soroban_sdk::{testutils::Address as _, Address, Env, Map, String, Symbol, Vec};

fn setup() -> (Env, AgentRegistryContractClient<'static>) {
    let env = Env::default();
    env.mock_all_auths();
    let id = env.register(AgentRegistryContract, ());
    let client = AgentRegistryContractClient::new(&env, &id);
    client.initialize(&Address::generate(&env));
    (env, client)
}

fn record(env: &Env, id: &str, owner: Address) -> AgentRecord {
    AgentRecord {
        id: Symbol::new(env, id),
        capability: Symbol::new(env, "research"),
        price_stroops: 1_000,
        endpoint: String::from_str(env, "https://agent.example.com"),
        owner,
        metadata: Map::new(env),
        bond_amount: DEFAULT_MIN_BOND_STROOPS,
    }
}

#[test]
fn registry_gas_snapshots() {
    let (env, client) = setup();

    let first = record(&env, "gas_one", Address::generate(&env));
    reset(&env);
    client.register_agent(&first);
    assert_snapshot(&env, "agent_registry", "register_agent");

    let batch = Vec::from_array(
        &env,
        [
            record(&env, "gas_two", Address::generate(&env)),
            record(&env, "gas_three", Address::generate(&env)),
        ],
    );
    reset(&env);
    client.register_agents(&batch);
    assert_snapshot(&env, "agent_registry", "register_agents_2");

    reset(&env);
    client.lookup_agents(&Symbol::new(&env, "research"));
    assert_snapshot(&env, "agent_registry", "lookup_agents");
}
