#![cfg(test)]
extern crate std;

use super::*;
use soroban_sdk::testutils::{Address as _, Ledger};
use soroban_sdk::{token, Address, Env, Map};

fn create_token_contract<'a>(e: &Env, admin: &Address) -> token::Client<'a> {
    token::Client::new(e, &e.register_stellar_asset_contract(admin.clone()))
}

#[test]
fn test_create_and_release() {
    let env = Env::default();
    env.mock_all_auths();
    
    let router_id = env.register_contract(None, PaymentRouter);
    let router_client = PaymentRouterClient::new(&env, &router_id);

    let admin = Address::generate(&env);
    let token = create_token_contract(&env, &admin);
    let coordinator = Address::generate(&env);
    let agent1 = Address::generate(&env);
    let agent2 = Address::generate(&env);

    token.mint(&coordinator, &1000);

    let mut amounts = Map::new(&env);
    amounts.set(agent1.clone(), 600);
    amounts.set(agent2.clone(), 400);

    env.ledger().with_mut(|li| {
        li.timestamp = 1000;
    });

    router_client.create_task_escrow(
        &1,
        &coordinator,
        &token.address,
        &1000,
        &amounts,
        &2000,
    );

    assert_eq!(token.balance(&coordinator), 0);
    assert_eq!(token.balance(&router_id), 1000);

    let mut agents = Vec::new(&env);
    agents.push_back(agent1.clone());
    agents.push_back(agent2.clone());

    router_client.release_to_agent(&1, &agents);

    assert_eq!(token.balance(&agent1), 600);
    assert_eq!(token.balance(&agent2), 400);
    assert_eq!(token.balance(&router_id), 0);
}

#[test]
fn test_refund() {
    let env = Env::default();
    env.mock_all_auths();
    
    let router_id = env.register_contract(None, PaymentRouter);
    let router_client = PaymentRouterClient::new(&env, &router_id);

    let admin = Address::generate(&env);
    let token = create_token_contract(&env, &admin);
    let coordinator = Address::generate(&env);
    let agent = Address::generate(&env);

    token.mint(&coordinator, &1000);

    let mut amounts = Map::new(&env);
    amounts.set(agent.clone(), 1000);

    env.ledger().with_mut(|li| {
        li.timestamp = 1000;
    });

    router_client.create_task_escrow(
        &1,
        &coordinator,
        &token.address,
        &1000,
        &amounts,
        &2000,
    );

    env.ledger().with_mut(|li| {
        li.timestamp = 2001;
    });

    router_client.refund_coordinator(&1);

    assert_eq!(token.balance(&coordinator), 1000);
    assert_eq!(token.balance(&router_id), 0);
}
