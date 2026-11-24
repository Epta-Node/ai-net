//! Storage-budget assertions for dispute filing and evidence (Issue #771).

use agent_registry::{AgentRecord, AgentRegistryContract, AgentRegistryContractClient};
use contract_test_utils::{assert_storage_within, StorageBudget};
use dispute_resolution::{DisputeResolutionContract, DisputeResolutionContractClient};
use soroban_sdk::{testutils::Address as _, Address, BytesN, Env, Map, String, Symbol};

struct Fixture {
    env: Env,
    client: DisputeResolutionContractClient<'static>,
    filer: Address,
    agent: Address,
    task_id: Symbol,
}

fn setup() -> Fixture {
    let env = Env::default();
    env.mock_all_auths();
    let contract_id = env.register(DisputeResolutionContract, ());
    let client = DisputeResolutionContractClient::new(&env, &contract_id);
    let admin = Address::generate(&env);
    client.initialize(&admin);

    let voters = [
        Address::generate(&env),
        Address::generate(&env),
        Address::generate(&env),
        Address::generate(&env),
        Address::generate(&env),
    ];
    let voter_vec = soroban_sdk::vec![
        &env,
        voters[0].clone(),
        voters[1].clone(),
        voters[2].clone(),
        voters[3].clone(),
        voters[4].clone(),
    ];
    client.set_voters(&voter_vec);
    for voter in voters.iter() {
        client.set_reputation(voter, &3);
    }

    let filer = Address::generate(&env);
    let agent = Address::generate(&env);
    let task_id = Symbol::new(&env, "budget_task");
    client.set_reputation(&filer, &10);
    client.set_reputation(&agent, &10);

    let registry_id = env.register(AgentRegistryContract, ());
    let registry = AgentRegistryContractClient::new(&env, &registry_id);
    let registry_agent_id = Symbol::new(&env, "budget_registry_agent");
    registry.initialize(&admin);
    registry.set_min_bond(&100);
    registry.set_dispute_resolver(&contract_id);
    registry.register_agent(&AgentRecord {
        id: registry_agent_id.clone(),
        capability: Symbol::new(&env, "research"),
        price_stroops: 1,
        endpoint: String::from_str(&env, "https://agent.example"),
        owner: agent.clone(),
        metadata: Map::new(&env),
        bond_amount: 100,
    });
    client.set_agent_registry(&registry_id);
    client.set_agent_registry_id(&agent, &registry_agent_id);
    client.set_agent_bond(&agent, &100);
    client.set_task_escrow(&task_id, &1_000);

    Fixture {
        env,
        client,
        filer,
        agent,
        task_id,
    }
}

/// Filing writes the dispute record, the juror snapshot and the task index.
/// Measured: +3 entries / +1,132 bytes. Ceiling: 3 / 1,200.
#[test]
fn file_dispute_stays_within_storage_budget() {
    let f = setup();

    assert_storage_within(
        &f.env,
        &f.client.address,
        "dispute_resolution::file_dispute",
        StorageBudget::new(3, 1_200),
        || {
            f.client.file_dispute(
                &f.task_id,
                &f.filer,
                &f.agent,
                &String::from_str(&f.env, "work was not delivered"),
            )
        },
    );
}

/// Each evidence submission writes one record plus the dispute counter.
/// Measured: +1 entry / +292 bytes. Ceiling: 1 / 300.
#[test]
fn submit_evidence_stays_within_storage_budget() {
    let f = setup();
    f.client.file_dispute(
        &f.task_id,
        &f.filer,
        &f.agent,
        &String::from_str(&f.env, "work was not delivered"),
    );

    assert_storage_within(
        &f.env,
        &f.client.address,
        "dispute_resolution::submit_evidence",
        StorageBudget::new(1, 300),
        || {
            f.client
                .submit_evidence(&f.task_id, &f.filer, &BytesN::from_array(&f.env, &[4; 32]))
        },
    );
}
