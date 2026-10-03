use super::*;
use soroban_sdk::{
    testutils::{Address as _, Ledger as _},
    Address, Env, FromVal, Map,
};

fn setup() -> (Env, AgentRegistryContractClient<'static>, Symbol, Address) {
    let env = Env::default();
    env.mock_all_auths();
    env.ledger().set_max_entry_ttl(100_000_000);
    env.ledger().set_min_persistent_entry_ttl(100_000_000);
    let contract_id = env.register(AgentRegistryContract, ());
    let client = AgentRegistryContractClient::new(&env, &contract_id);
    let admin = Address::generate(&env);
    let owner = Address::generate(&env);
    let agent_id = Symbol::new(&env, "bond_agent");
    client.initialize(&admin);
    client.register_agent(&AgentRecord {
        id: agent_id.clone(),
        capability: Symbol::new(&env, "research"),
        price_stroops: 1,
        endpoint: soroban_sdk::String::from_str(&env, "https://agent.example"),
        owner: owner.clone(),
        metadata: Map::new(&env),
        bond_amount: DEFAULT_MIN_BOND_STROOPS,
    });
    (env, client, agent_id, owner)
}

#[test]
fn deposit_enforces_minimum_and_updates_bond() {
    let (_env, client, agent_id, _owner) = setup();
    assert_eq!(
        client.try_deposit_bond(&agent_id, &1),
        Err(Ok(Error::InsufficientBond))
    );
    client.deposit_bond(&agent_id, &DEFAULT_MIN_BOND_STROOPS);
    let bond = client.get_bond(&agent_id).unwrap();
    assert_eq!(bond.amount_stroops, DEFAULT_MIN_BOND_STROOPS * 2);
    assert_eq!(bond.status, bond::BondStatus::Active);
}

#[test]
fn partial_slash_funds_reward_pool() {
    let (env, client, agent_id, _owner) = setup();
    client.slash_bond(
        &agent_id,
        &50,
        &soroban_sdk::String::from_str(&env, "policy violation"),
    );
    let remaining = client.get_bond(&agent_id).unwrap();
    assert_eq!(remaining.amount_stroops, DEFAULT_MIN_BOND_STROOPS / 2);
    assert_eq!(remaining.status, bond::BondStatus::Active);
    assert_eq!(client.get_bond_reward_pool(), DEFAULT_MIN_BOND_STROOPS / 2);
    let events = env.events().all();
    let (_, _, data) = events.get(events.len() - 1).unwrap();
    let slash_event = events::BondSlashed::from_val(&env, &data).unwrap();
    assert_eq!(slash_event.penalty_stroops, DEFAULT_MIN_BOND_STROOPS / 2);
    assert_eq!(
        slash_event.reason,
        soroban_sdk::String::from_str(&env, "policy violation")
    );
    client.reward_bond(&agent_id, &10_000_000);
    assert_eq!(
        client.get_bond_reward_pool(),
        DEFAULT_MIN_BOND_STROOPS / 2 - 10_000_000
    );
    assert_eq!(
        client.get_bond(&agent_id).unwrap().amount_stroops,
        DEFAULT_MIN_BOND_STROOPS / 2 + 10_000_000
    );
}

#[test]
fn cooldown_blocks_early_claim_and_returns_bond_after_expiry() {
    let (env, client, agent_id, _owner) = setup();
    client.initiate_bond_return(&agent_id);
    assert_eq!(
        client.try_claim_bond(&agent_id),
        Err(Ok(Error::CooldownNotElapsed))
    );
    env.ledger()
        .set_sequence_number(env.ledger().sequence() + BOND_COOLDOWN_LEDGERS + 1);
    assert_eq!(client.claim_bond(&agent_id), DEFAULT_MIN_BOND_STROOPS);
    let bond = client.get_bond(&agent_id).unwrap();
    assert_eq!(bond.amount_stroops, 0);
    assert_eq!(bond.status, bond::BondStatus::Returned);
}

#[test]
fn slashed_agent_must_restore_bond_before_reregistration() {
    let (env, client, agent_id, owner) = setup();
    client.slash_bond(
        &agent_id,
        &100,
        &soroban_sdk::String::from_str(&env, "verified fraud"),
    );
    client.deregister_agent(&agent_id);
    env.ledger()
        .set_sequence_number(env.ledger().sequence() + BOND_COOLDOWN_LEDGERS + 1);
    client.deregister_agent(&agent_id);

    let record = AgentRecord {
        id: agent_id.clone(),
        capability: Symbol::new(&env, "research"),
        price_stroops: 1,
        endpoint: soroban_sdk::String::from_str(&env, "https://agent.example"),
        owner: owner.clone(),
        metadata: Map::new(&env),
        bond_amount: DEFAULT_MIN_BOND_STROOPS,
    };
    assert_eq!(
        client.try_register_agent(&record),
        Err(Ok(Error::InsufficientBond))
    );

    assert_eq!(
        client.restore_slashed_bond(&agent_id, &DEFAULT_MIN_BOND_STROOPS),
        DEFAULT_MIN_BOND_STROOPS
    );
    client.register_agent(&record);
    assert_eq!(
        client.get_bond(&agent_id).unwrap().amount_stroops,
        DEFAULT_MIN_BOND_STROOPS
    );
}
