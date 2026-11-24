//! Gas snapshots for the marketplace hot paths (Issue #773).

use agent_marketplace::{
    AdminAction, AgentMarketplaceContract, AgentMarketplaceContractClient, TIMELOCK_DELAY,
};
use contract_test_utils::gas::{assert_snapshot, reset};
use soroban_sdk::{
    testutils::{Address as _, Ledger as _},
    Address, Env, Symbol,
};

fn setup() -> (Env, AgentMarketplaceContractClient<'static>) {
    let env = Env::default();
    env.mock_all_auths();
    let id = env.register(AgentMarketplaceContract, ());
    let client = AgentMarketplaceContractClient::new(&env, &id);
    (env, client)
}

fn run_action(env: &Env, client: &AgentMarketplaceContractClient<'_>, action: AdminAction) {
    let id = client.queue_action(&action);
    env.ledger()
        .with_mut(|ledger| ledger.timestamp += TIMELOCK_DELAY);
    client.execute_action(&id);
}

fn list(env: &Env, client: &AgentMarketplaceContractClient<'_>) {
    client.list_service(
        &Symbol::new(env, "svc_gas"),
        &Symbol::new(env, "agent_gas"),
        &Address::generate(env),
        &Symbol::new(env, "research"),
        &1_000_000,
        &200,
        &24,
    );
}

#[test]
fn marketplace_gas_snapshots() {
    let (env, client) = setup();

    reset(&env);
    list(&env, &client);
    assert_snapshot(&env, "agent_marketplace", "list_service");

    client.initialize(&Address::generate(&env));
    let sac = env.register_stellar_asset_contract_v2(Address::generate(&env));
    run_action(
        &env,
        &client,
        AdminAction::SetPaymentAsset(sac.address(), 7),
    );
    let payer = Address::generate(&env);
    soroban_sdk::token::StellarAssetClient::new(&env, &sac.address()).mint(&payer, &10_000_000);
    let booking_id = Symbol::new(&env, "bk_gas");

    reset(&env);
    client.book_agent(
        &Symbol::new(&env, "svc_gas"),
        &payer,
        &sac.address(),
        &1_000_000,
        &booking_id,
    );
    assert_snapshot(&env, "agent_marketplace", "book_agent");

    reset(&env);
    client.complete_booking(&booking_id);
    assert_snapshot(&env, "agent_marketplace", "complete_booking");
}
