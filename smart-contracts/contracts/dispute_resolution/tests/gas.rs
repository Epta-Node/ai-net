//! Gas estimation tests for the dispute-resolution hot paths (Issue #927).
//!
//! Each test measures one top-level entrypoint with the native Soroban budget
//! tracker and compares it against `smart-contracts/gas-baselines.json`:
//!
//! - `create_dispute` -> [`file_dispute`] (locks the agent bond in the registry)
//! - `resolve_dispute` -> [`resolve`] (tallies votes, records a provisional ruling)
//! - `slash_agent` -> the binding [`vote_as_arbiter`] call of a 2-of-3 arbiter
//!   panel ruling for the filer, which applies the final ruling and calls
//!   `agent_registry::slash_bond_from_dispute` cross-contract
//!
//! The budget tracker is reset before every top-level call, so each snapshot
//! is taken immediately after the measured call, before any read-back.
//!
//! Record intentional changes with:
//!
//! ```text
//! UPDATE_GAS_BASELINES=1 cargo test -p dispute-resolution --test gas
//! ```

use agent_registry::{AgentRecord, AgentRegistryContract, AgentRegistryContractClient};
use contract_test_utils::gas::{assert_snapshot, measure, reset};
use dispute_resolution::{
    DisputeOutcome, DisputeResolutionContract, DisputeResolutionContractClient, DisputeStatus,
    VoteSide, EVIDENCE_PHASE, VOTING_PHASE,
};
use soroban_sdk::{
    testutils::{Address as _, Ledger as _},
    vec, Address, Env, Map, String, Symbol,
};

const CONTRACT: &str = "dispute_resolution";
const JUROR_COUNT: u32 = 5;

struct Fixture {
    env: Env,
    client: DisputeResolutionContractClient<'static>,
    voters: [Address; JUROR_COUNT as usize],
    arbiters: [Address; 3],
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

    let voters: [Address; JUROR_COUNT as usize] = core::array::from_fn(|_| Address::generate(&env));
    let mut voter_vec = vec![&env];
    for voter in voters.iter() {
        voter_vec.push_back(voter.clone());
        client.set_reputation(voter, &3);
    }
    client.set_voters(&voter_vec);
    let arbiters: [Address; 3] = core::array::from_fn(|_| Address::generate(&env));
    client.set_arbiter_pool(&vec![
        &env,
        arbiters[0].clone(),
        arbiters[1].clone(),
        arbiters[2].clone(),
    ]);

    let filer = Address::generate(&env);
    let agent = Address::generate(&env);
    let task_id = Symbol::new(&env, "gas_task");

    let registry_id = env.register(AgentRegistryContract, ());
    let registry = AgentRegistryContractClient::new(&env, &registry_id);
    let registry_agent_id = Symbol::new(&env, "gas_agent");
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
        voters,
        arbiters,
        filer,
        agent,
        task_id,
    }
}

fn file(fixture: &Fixture) {
    fixture.client.file_dispute(
        &fixture.task_id,
        &fixture.filer,
        &fixture.agent,
        &String::from_str(&fixture.env, "work was not delivered"),
    );
}

fn advance_to_voting(fixture: &Fixture) {
    fixture
        .env
        .ledger()
        .with_mut(|ledger| ledger.timestamp += EVIDENCE_PHASE);
}

/// File, then have a 3-2 majority vote for the filer and close the voting window.
fn file_and_vote_for_filer(fixture: &Fixture) {
    file(fixture);
    advance_to_voting(fixture);
    for (i, voter) in fixture.voters.iter().enumerate() {
        let side = if i < 3 {
            VoteSide::SupportFiler
        } else {
            VoteSide::SupportAgent
        };
        fixture.client.vote(&fixture.task_id, voter, &side);
    }
    fixture
        .env
        .ledger()
        .with_mut(|ledger| ledger.timestamp += VOTING_PHASE);
}

#[test]
fn create_dispute_gas() {
    let fixture = setup();

    reset(&fixture.env);
    file(&fixture);
    assert!(measure(&fixture.env).instructions > 0);
    assert_snapshot(&fixture.env, CONTRACT, "create_dispute");

    assert_eq!(
        fixture.client.get_dispute(&fixture.task_id).unwrap().status,
        DisputeStatus::EvidencePhase
    );
}

#[test]
fn resolve_dispute_gas() {
    let fixture = setup();
    file_and_vote_for_filer(&fixture);

    reset(&fixture.env);
    let outcome = fixture.client.resolve(&fixture.task_id);
    assert!(measure(&fixture.env).instructions > 0);
    assert_snapshot(&fixture.env, CONTRACT, "resolve_dispute");

    assert_eq!(outcome, DisputeOutcome::SupportFiler);
    assert_eq!(
        fixture.client.get_dispute(&fixture.task_id).unwrap().status,
        DisputeStatus::AppealPending
    );
}

#[test]
fn slash_agent_gas() {
    let fixture = setup();
    file(&fixture);
    advance_to_voting(&fixture);
    fixture.client.vote_as_arbiter(
        &fixture.task_id,
        &fixture.arbiters[0],
        &VoteSide::SupportFiler,
    );

    // The second matching arbiter vote is binding: it applies the final ruling
    // and slashes 50% of the agent's bond through the agent registry.
    reset(&fixture.env);
    fixture.client.vote_as_arbiter(
        &fixture.task_id,
        &fixture.arbiters[1],
        &VoteSide::SupportFiler,
    );
    assert!(measure(&fixture.env).instructions > 0);
    assert_snapshot(&fixture.env, CONTRACT, "slash_agent");

    let dispute = fixture.client.get_dispute(&fixture.task_id).unwrap();
    assert_eq!(dispute.status, DisputeStatus::Resolved);
    assert_eq!(dispute.bond_slashed, 50);
    assert_eq!(fixture.client.get_agent_bond(&fixture.agent), 50);
}

#[test]
fn dispute_estimate_is_within_twenty_percent_of_file_dispute_cost() {
    let fixture = setup();

    reset(&fixture.env);
    file(&fixture);
    let actual = measure(&fixture.env).instructions;
    let estimate = fixture
        .client
        .estimate_gas(&Symbol::new(&fixture.env, "dispute"), &JUROR_COUNT);

    assert!(actual > 0);
    assert!(
        estimate.saturating_mul(100) >= actual.saturating_mul(80),
        "estimate {estimate} is below actual {actual}"
    );
    assert!(
        estimate.saturating_mul(100) <= actual.saturating_mul(120),
        "estimate {estimate} is above actual {actual}"
    );
}
