//! Storage-budget assertions for the registry's write hot paths (Issue #771).
//!
//! Each ceiling is the maximum *growth* the operation may cause: one ledger
//! entry per stored record/index and a documented byte payload. Raise a ceiling
//! only together with the matching entry in `smart-contracts/docs/security.md`.

use agent_registry::{
    AgentRecord, AgentRegistryContract, AgentRegistryContractClient, DEFAULT_MIN_BOND_STROOPS,
};
use contract_test_utils::{assert_storage_within, StorageBudget};
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

/// Single registration writes the agent record, its capability index, the
/// bond record, the ordinal index and the two registry counters. Measured:
/// +6 entries / +808 bytes. Ceiling: 6 entries / 900 bytes.
#[test]
fn register_agent_stays_within_storage_budget() {
    let (env, client) = setup();
    let record = record(&env, "budget_one", Address::generate(&env));

    assert_storage_within(
        &env,
        &client.address,
        "agent_registry::register_agent",
        StorageBudget::new(6, 900),
        || client.register_agent(&record),
    );
}

/// A two-agent batch adds one record + bond + ordinal per agent, plus the
/// shared capability index and counters. Measured: +9 entries / +1,464 bytes.
/// Ceiling: 9 entries / 1,600 bytes.
#[test]
fn register_agents_batch_stays_within_storage_budget() {
    let (env, client) = setup();
    let batch = Vec::from_array(
        &env,
        [
            record(&env, "budget_two", Address::generate(&env)),
            record(&env, "budget_three", Address::generate(&env)),
        ],
    );

    assert_storage_within(
        &env,
        &client.address,
        "agent_registry::register_agents(2)",
        StorageBudget::new(9, 1_600),
        || client.register_agents(&batch),
    );
}

/// Reads must not mutate storage at all.
#[test]
fn lookup_agents_is_storage_neutral() {
    let (env, client) = setup();
    client.register_agent(&record(&env, "budget_read", Address::generate(&env)));

    assert_storage_within(
        &env,
        &client.address,
        "agent_registry::lookup_agents",
        StorageBudget::read_only(),
        || client.lookup_agents(&Symbol::new(&env, "research")),
    );
}
