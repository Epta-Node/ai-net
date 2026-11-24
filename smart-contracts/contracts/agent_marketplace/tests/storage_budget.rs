//! Storage-budget assertions for the marketplace hot paths (Issue #771).

use agent_marketplace::{
    AdminAction, AgentMarketplaceContract, AgentMarketplaceContractClient, TIMELOCK_DELAY,
};
use contract_test_utils::{assert_storage_within, StorageBudget};
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

fn configure_asset(
    env: &Env,
    client: &AgentMarketplaceContractClient<'_>,
    payer: &Address,
) -> Address {
    client.initialize(&Address::generate(env));
    let sac = env.register_stellar_asset_contract_v2(Address::generate(env));
    run_action(env, client, AdminAction::SetPaymentAsset(sac.address(), 7));
    soroban_sdk::token::StellarAssetClient::new(env, &sac.address()).mint(payer, &10_000_000);
    sac.address()
}

fn list(env: &Env, client: &AgentMarketplaceContractClient<'_>) {
    client.list_service(
        &Symbol::new(env, "svc_budget"),
        &Symbol::new(env, "agent_budget"),
        &Address::generate(env),
        &Symbol::new(env, "research"),
        &1_000_000,
        &200,
        &24,
    );
}

/// A listing writes the listing record and the capability index. Measured:
/// +2 entries / +464 bytes. Ceiling: 2 / 500.
#[test]
fn list_service_stays_within_storage_budget() {
    let (env, client) = setup();
    let owner = Address::generate(&env);

    assert_storage_within(
        &env,
        &client.address,
        "agent_marketplace::list_service",
        StorageBudget::new(2, 500),
        || {
            client.list_service(
                &Symbol::new(&env, "svc_budget"),
                &Symbol::new(&env, "agent_budget"),
                &owner,
                &Symbol::new(&env, "research"),
                &1_000_000,
                &200,
                &24,
            )
        },
    );
}

/// A booking writes the booking record and its id index. Measured: +2
/// entries / +556 bytes. Ceiling: 2 / 600.
#[test]
fn book_agent_stays_within_storage_budget() {
    let (env, client) = setup();
    list(&env, &client);
    let payer = Address::generate(&env);
    let asset = configure_asset(&env, &client, &payer);
    let booking_id = Symbol::new(&env, "bk_budget");

    assert_storage_within(
        &env,
        &client.address,
        "agent_marketplace::book_agent",
        StorageBudget::new(2, 600),
        || {
            client.book_agent(
                &Symbol::new(&env, "svc_budget"),
                &payer,
                &asset,
                &1_000_000,
                &booking_id,
            )
        },
    );
}

/// Completing a booking updates the record in place. Measured: +1 entry /
/// +168 bytes. Ceiling: 1 / 200.
#[test]
fn complete_booking_stays_within_storage_budget() {
    let (env, client) = setup();
    list(&env, &client);
    let payer = Address::generate(&env);
    let asset = configure_asset(&env, &client, &payer);
    let booking_id = Symbol::new(&env, "bk_done");
    client.book_agent(
        &Symbol::new(&env, "svc_budget"),
        &payer,
        &asset,
        &1_000_000,
        &booking_id,
    );

    assert_storage_within(
        &env,
        &client.address,
        "agent_marketplace::complete_booking",
        StorageBudget::new(1, 200),
        || client.complete_booking(&booking_id),
    );
}
