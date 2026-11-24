//! # Agent Marketplace Unit Tests

extern crate std;

use super::*;
use soroban_sdk::{
    testutils::{Address as _, Events as _, Ledger as _},
    Address, Env, IntoVal, Symbol, TryFromVal, TryIntoVal, Val,
};

fn setup() -> (Env, AgentMarketplaceContractClient<'static>) {
    let env = Env::default();
    env.mock_all_auths();
    let id = env.register(AgentMarketplaceContract, ());
    let client = AgentMarketplaceContractClient::new(&env, &id);
    (env, client)
}

fn setup_with_admin() -> (Env, AgentMarketplaceContractClient<'static>, Address) {
    let env = Env::default();
    env.mock_all_auths();
    let id = env.register(AgentMarketplaceContract, ());
    let client = AgentMarketplaceContractClient::new(&env, &id);
    let admin = Address::generate(&env);
    client.initialize(&admin);
    (env, client, admin)
}

/// Queue `action`, wait out the timelock and execute it.
fn run_action(env: &Env, client: &AgentMarketplaceContractClient<'_>, action: AdminAction) {
    let id = client.queue_action(&action);
    env.ledger().with_mut(|l| l.timestamp += TIMELOCK_DELAY);
    client.execute_action(&id);
}

/// Configure a test Stellar Asset Contract as the payment asset (initialising
/// the marketplace first if needed), fund `payer`, and return the asset.
fn pay_asset(env: &Env, client: &AgentMarketplaceContractClient<'_>, payer: &Address) -> Address {
    if client.get_admin().is_none() {
        client.initialize(&Address::generate(env));
    }
    let asset = match client.get_payment_asset() {
        Some(asset) => asset,
        None => {
            let sac = env.register_stellar_asset_contract_v2(Address::generate(env));
            run_action(env, client, AdminAction::SetPaymentAsset(sac.address(), 7));
            sac.address()
        }
    };
    soroban_sdk::token::StellarAssetClient::new(env, &asset).mint(payer, &10_000_000);
    asset
}

fn balance(env: &Env, client: &AgentMarketplaceContractClient<'_>, who: &Address) -> i128 {
    soroban_sdk::token::Client::new(env, &client.get_payment_asset().unwrap()).balance(who)
}

#[test]
fn initialize_sets_admin() {
    let (env, client) = setup();
    let admin = Address::generate(&env);
    client.initialize(&admin);
    env.as_contract(&client.address, || {
        assert!(env.storage().instance().has(&DataKey::Admin));
    });
}

#[test]
fn initialize_cannot_be_called_twice() {
    let (env, client) = setup();
    let admin = Address::generate(&env);
    client.initialize(&admin);
    assert_eq!(
        client.try_initialize(&Address::generate(&env)),
        Err(Ok(Error::AlreadyExists))
    );
}

#[test]
fn list_service_success() {
    let (env, client) = setup();
    let owner = Address::generate(&env);
    let result = client.try_list_service(
        &Symbol::new(&env, "svc1"),
        &Symbol::new(&env, "agent1"),
        &owner,
        &Symbol::new(&env, "research"),
        &1_000_000_i128,
        &200_u32,
        &24_u32,
    );
    assert!(result.is_ok());

    let listing = client.get_listing(&Symbol::new(&env, "svc1"));
    assert!(listing.is_some());
    let listing = listing.unwrap();
    assert_eq!(listing.price_stroops, 1_000_000);
    assert!(listing.active);
}

#[test]
fn list_service_invalid_price() {
    let (env, client) = setup();
    let owner = Address::generate(&env);

    assert_eq!(
        client.try_list_service(
            &Symbol::new(&env, "svc_bad"),
            &Symbol::new(&env, "agent1"),
            &owner,
            &Symbol::new(&env, "research"),
            &0_i128,
            &200_u32,
            &24_u32,
        ),
        Err(Ok(Error::InvalidPrice))
    );
}

#[test]
fn list_service_duplicate() {
    let (env, client) = setup();
    let owner = Address::generate(&env);

    client.list_service(
        &Symbol::new(&env, "svc1"),
        &Symbol::new(&env, "agent1"),
        &owner,
        &Symbol::new(&env, "research"),
        &1_000_000_i128,
        &200_u32,
        &24_u32,
    );

    assert_eq!(
        client.try_list_service(
            &Symbol::new(&env, "svc1"),
            &Symbol::new(&env, "agent2"),
            &owner,
            &Symbol::new(&env, "coding"),
            &2_000_000_i128,
            &100_u32,
            &12_u32,
        ),
        Err(Ok(Error::AlreadyExists))
    );
}

#[test]
fn search_services_filters_by_price() {
    let (env, client) = setup();
    let owner = Address::generate(&env);

    client.list_service(
        &Symbol::new(&env, "svc_cheap"),
        &Symbol::new(&env, "agent1"),
        &owner,
        &Symbol::new(&env, "research"),
        &500_000_i128,
        &200_u32,
        &24_u32,
    );
    client.list_service(
        &Symbol::new(&env, "svc_expensive"),
        &Symbol::new(&env, "agent2"),
        &owner,
        &Symbol::new(&env, "research"),
        &2_000_000_i128,
        &200_u32,
        &24_u32,
    );

    let results = client.search_services(&Symbol::new(&env, "research"), &1_000_000_i128, &0_u32);
    assert_eq!(results.len(), 1);
    assert_eq!(
        results.get(0).unwrap().listing_id,
        Symbol::new(&env, "svc_cheap")
    );
}

#[test]
fn book_agent_success() {
    let (env, client) = setup();
    let owner = Address::generate(&env);
    let client_addr = Address::generate(&env);

    client.list_service(
        &Symbol::new(&env, "svc1"),
        &Symbol::new(&env, "agent1"),
        &owner,
        &Symbol::new(&env, "research"),
        &1_000_000_i128,
        &200_u32,
        &24_u32,
    );

    let booking_id = Symbol::new(&env, "bk1");
    client.book_agent(
        &Symbol::new(&env, "svc1"),
        &client_addr,
        &pay_asset(&env, &client, &client_addr),
        &1_000_000_i128,
        &booking_id,
    );

    let booking = client.get_booking(&booking_id);
    assert!(booking.is_some());
    let booking = booking.unwrap();
    assert_eq!(booking.escrow_amount, 1_000_000);
    assert!(!booking.completed);
    assert!(!booking.cancelled);
}

/// The marketplace holds the exact configured asset amount in escrow and
/// releases it exactly once along each terminal lifecycle path.
#[test]
fn fee_accounting_and_booking_lifecycle_preserve_asset_balance() {
    let (env, client) = setup();
    let owner = Address::generate(&env);
    let payer = Address::generate(&env);
    client.list_service(
        &Symbol::new(&env, "svc_fee"),
        &Symbol::new(&env, "agent_fee"),
        &owner,
        &Symbol::new(&env, "research"),
        &1_000_000,
        &200,
        &24,
    );
    let asset = pay_asset(&env, &client, &payer);
    let before = soroban_sdk::token::Client::new(&env, &asset).balance(&payer);

    client.book_agent(
        &Symbol::new(&env, "svc_fee"),
        &payer,
        &asset,
        &1_000_000,
        &Symbol::new(&env, "booking_fee"),
    );
    assert_eq!(balance(&env, &client, &payer), before - 1_000_000);
    assert_eq!(balance(&env, &client, &client.address), 1_000_000);

    client.complete_booking(&Symbol::new(&env, "booking_fee"));
    assert_eq!(balance(&env, &client, &client.address), 0);
    assert_eq!(balance(&env, &client, &owner), 1_000_000);
    assert_eq!(
        client.try_complete_booking(&Symbol::new(&env, "booking_fee")),
        Err(Ok(Error::BookingAlreadyCompleted))
    );
}

#[test]
fn cancellation_refunds_full_escrow_and_cannot_be_replayed() {
    let (env, client) = setup();
    let owner = Address::generate(&env);
    let payer = Address::generate(&env);
    client.list_service(
        &Symbol::new(&env, "svc_refund"),
        &Symbol::new(&env, "agent_refund"),
        &owner,
        &Symbol::new(&env, "research"),
        &2_000_000,
        &200,
        &24,
    );
    let asset = pay_asset(&env, &client, &payer);
    let before = balance(&env, &client, &payer);
    let booking = Symbol::new(&env, "booking_refund");
    client.book_agent(
        &Symbol::new(&env, "svc_refund"),
        &payer,
        &asset,
        &2_000_000,
        &booking,
    );
    client.cancel_booking(&booking);
    assert_eq!(balance(&env, &client, &payer), before);
    assert_eq!(balance(&env, &client, &client.address), 0);
    assert_eq!(
        client.try_cancel_booking(&booking),
        Err(Ok(Error::BookingAlreadyCancelled))
    );
}

#[test]
fn book_agent_insufficient_payment() {
    let (env, client) = setup();
    let owner = Address::generate(&env);
    let client_addr = Address::generate(&env);

    client.list_service(
        &Symbol::new(&env, "svc1"),
        &Symbol::new(&env, "agent1"),
        &owner,
        &Symbol::new(&env, "research"),
        &1_000_000_i128,
        &200_u32,
        &24_u32,
    );

    assert_eq!(
        client.try_book_agent(
            &Symbol::new(&env, "svc1"),
            &client_addr,
            &pay_asset(&env, &client, &client_addr),
            &500_000_i128,
            &Symbol::new(&env, "bk_bad"),
        ),
        Err(Ok(Error::InsufficientPayment))
    );
}

#[test]
fn complete_booking_releases_escrow() {
    let (env, client) = setup();
    let owner = Address::generate(&env);
    let client_addr = Address::generate(&env);

    client.list_service(
        &Symbol::new(&env, "svc1"),
        &Symbol::new(&env, "agent1"),
        &owner,
        &Symbol::new(&env, "research"),
        &1_000_000_i128,
        &200_u32,
        &24_u32,
    );

    let booking_id = Symbol::new(&env, "bk1");
    client.book_agent(
        &Symbol::new(&env, "svc1"),
        &client_addr,
        &pay_asset(&env, &client, &client_addr),
        &1_000_000_i128,
        &booking_id,
    );

    client.complete_booking(&booking_id);

    let booking = client.get_booking(&booking_id).unwrap();
    assert!(booking.completed);
}

#[test]
fn cancel_booking_refunds_client() {
    let (env, client) = setup();
    let owner = Address::generate(&env);
    let client_addr = Address::generate(&env);

    client.list_service(
        &Symbol::new(&env, "svc1"),
        &Symbol::new(&env, "agent1"),
        &owner,
        &Symbol::new(&env, "research"),
        &1_000_000_i128,
        &200_u32,
        &24_u32,
    );

    let booking_id = Symbol::new(&env, "bk1");
    client.book_agent(
        &Symbol::new(&env, "svc1"),
        &client_addr,
        &pay_asset(&env, &client, &client_addr),
        &1_000_000_i128,
        &booking_id,
    );

    client.cancel_booking(&booking_id);

    let booking = client.get_booking(&booking_id).unwrap();
    assert!(booking.cancelled);
}

#[test]
fn rate_booking_updates_agent_rating() {
    let (env, client) = setup();
    let owner = Address::generate(&env);
    let client_addr = Address::generate(&env);

    client.list_service(
        &Symbol::new(&env, "svc1"),
        &Symbol::new(&env, "agent1"),
        &owner,
        &Symbol::new(&env, "research"),
        &1_000_000_i128,
        &200_u32,
        &24_u32,
    );

    let booking_id = Symbol::new(&env, "bk1");
    client.book_agent(
        &Symbol::new(&env, "svc1"),
        &client_addr,
        &pay_asset(&env, &client, &client_addr),
        &1_000_000_i128,
        &booking_id,
    );
    client.complete_booking(&booking_id);
    client.rate_booking(&booking_id, &5);

    let rating = client.get_agent_rating(&Symbol::new(&env, "agent1"));
    assert_eq!(rating.total_ratings, 1);
    assert_eq!(rating.rating_sum, 5);
}

#[test]
fn rate_invalid_score() {
    let (env, client) = setup();
    let owner = Address::generate(&env);
    let client_addr = Address::generate(&env);

    client.list_service(
        &Symbol::new(&env, "svc1"),
        &Symbol::new(&env, "agent1"),
        &owner,
        &Symbol::new(&env, "research"),
        &1_000_000_i128,
        &200_u32,
        &24_u32,
    );

    let booking_id = Symbol::new(&env, "bk1");
    client.book_agent(
        &Symbol::new(&env, "svc1"),
        &client_addr,
        &pay_asset(&env, &client, &client_addr),
        &1_000_000_i128,
        &booking_id,
    );
    client.complete_booking(&booking_id);

    assert_eq!(
        client.try_rate_booking(&booking_id, &0),
        Err(Ok(Error::InvalidPrice))
    );
    assert_eq!(
        client.try_rate_booking(&booking_id, &6),
        Err(Ok(Error::InvalidPrice))
    );
}

#[test]
fn pause_blocks_listing() {
    let (env, client, _admin) = setup_with_admin();
    client.pause();

    let owner = Address::generate(&env);
    assert_eq!(
        client.try_list_service(
            &Symbol::new(&env, "svc1"),
            &Symbol::new(&env, "agent1"),
            &owner,
            &Symbol::new(&env, "research"),
            &1_000_000_i128,
            &200_u32,
            &24_u32,
        ),
        Err(Ok(Error::ContractPaused))
    );
}

#[test]
fn unpause_allows_listing() {
    let (env, client, _admin) = setup_with_admin();
    client.pause();
    run_action(&env, &client, AdminAction::Unpause);

    let owner = Address::generate(&env);
    client.list_service(
        &Symbol::new(&env, "svc1"),
        &Symbol::new(&env, "agent1"),
        &owner,
        &Symbol::new(&env, "research"),
        &1_000_000_i128,
        &200_u32,
        &24_u32,
    );
    assert!(client.get_listing(&Symbol::new(&env, "svc1")).is_some());
}

#[test]
fn is_paused_reflects_state() {
    let (env, client, _admin) = setup_with_admin();
    assert!(!client.is_paused());
    client.pause();
    assert!(client.is_paused());
    run_action(&env, &client, AdminAction::Unpause);
    assert!(!client.is_paused());
}

#[test]
fn pause_blocks_complete_booking() {
    let (env, client, _admin) = setup_with_admin();
    let owner = Address::generate(&env);
    let client_addr = Address::generate(&env);

    client.list_service(
        &Symbol::new(&env, "svc1"),
        &Symbol::new(&env, "agent1"),
        &owner,
        &Symbol::new(&env, "research"),
        &1_000_000_i128,
        &200_u32,
        &24_u32,
    );

    let booking_id = Symbol::new(&env, "bk1");
    client.book_agent(
        &Symbol::new(&env, "svc1"),
        &client_addr,
        &pay_asset(&env, &client, &client_addr),
        &1_000_000_i128,
        &booking_id,
    );

    client.pause();

    assert_eq!(
        client.try_complete_booking(&booking_id),
        Err(Ok(Error::ContractPaused))
    );
}

#[test]
fn search_services_still_works_when_paused() {
    let (env, client, _admin) = setup_with_admin();
    let owner = Address::generate(&env);

    client.list_service(
        &Symbol::new(&env, "svc1"),
        &Symbol::new(&env, "agent1"),
        &owner,
        &Symbol::new(&env, "research"),
        &1_000_000_i128,
        &200_u32,
        &24_u32,
    );

    client.pause();

    // Reads should still work when paused.
    let results = client.search_services(&Symbol::new(&env, "research"), &0, &0);
    assert_eq!(results.len(), 1);
}

// ========================================================================
// Negative Authorization Tests (Issue #549)
// ========================================================================

#[test]
fn negative_auth_initialize() {
    let env = Env::default();
    env.mock_auths(&[]);
    let id = env.register(AgentMarketplaceContract, ());
    let client = AgentMarketplaceContractClient::new(&env, &id);
    let admin = Address::generate(&env);
    assert!(client.try_initialize(&admin).is_err());
}

#[test]
fn search_services_filters_by_max_response_time() {
    let (env, client) = setup();
    let owner = Address::generate(&env);

    client.list_service(
        &Symbol::new(&env, "svc_fast"),
        &Symbol::new(&env, "agent1"),
        &owner,
        &Symbol::new(&env, "coding"),
        &1_000_000_i128,
        &100_u32,
        &24_u32,
    );
    client.list_service(
        &Symbol::new(&env, "svc_slow"),
        &Symbol::new(&env, "agent2"),
        &owner,
        &Symbol::new(&env, "coding"),
        &1_000_000_i128,
        &500_u32,
        &24_u32,
    );

    let results = client.search_services(&Symbol::new(&env, "coding"), &0_i128, &200_u32);
    assert_eq!(results.len(), 1);
    assert_eq!(
        results.get(0).unwrap().listing_id,
        Symbol::new(&env, "svc_fast")
    );
}

#[test]
fn complete_booking_errors() {
    let (env, client) = setup();
    let owner = Address::generate(&env);
    let client_addr = Address::generate(&env);

    // Non-existent booking
    assert_eq!(
        client.try_complete_booking(&Symbol::new(&env, "non_existent")),
        Err(Ok(Error::BookingNotFound))
    );

    client.list_service(
        &Symbol::new(&env, "svc1"),
        &Symbol::new(&env, "agent1"),
        &owner,
        &Symbol::new(&env, "research"),
        &1_000_000_i128,
        &200_u32,
        &24_u32,
    );

    let bk_id = Symbol::new(&env, "bk_comp");
    client.book_agent(
        &Symbol::new(&env, "svc1"),
        &client_addr,
        &1_000_000_i128,
        &bk_id,
    );

    client.complete_booking(&bk_id);

    // Already completed
    assert_eq!(
        client.try_complete_booking(&bk_id),
        Err(Ok(Error::BookingAlreadyCompleted))
    );
}

#[test]
fn cancel_booking_errors() {
    let (env, client) = setup();
    let owner = Address::generate(&env);
    let client_addr = Address::generate(&env);

    // Non-existent booking
    assert_eq!(
        client.try_cancel_booking(&Symbol::new(&env, "non_existent")),
        Err(Ok(Error::BookingNotFound))
    );

    client.list_service(
        &Symbol::new(&env, "svc1"),
        &Symbol::new(&env, "agent1"),
        &owner,
        &Symbol::new(&env, "research"),
        &1_000_000_i128,
        &200_u32,
        &24_u32,
    );

    let bk_id = Symbol::new(&env, "bk_canc");
    client.book_agent(
        &Symbol::new(&env, "svc1"),
        &client_addr,
        &1_000_000_i128,
        &bk_id,
    );

    client.cancel_booking(&bk_id);

    // Already cancelled
    assert_eq!(
        client.try_cancel_booking(&bk_id),
        Err(Ok(Error::BookingAlreadyCancelled))
    );
}

#[test]
fn rate_booking_errors() {
    let (env, client) = setup();
    let owner = Address::generate(&env);
    let client_addr = Address::generate(&env);

    client.list_service(
        &Symbol::new(&env, "svc1"),
        &Symbol::new(&env, "agent1"),
        &owner,
        &Symbol::new(&env, "research"),
        &1_000_000_i128,
        &200_u32,
        &24_u32,
    );

    let bk_id = Symbol::new(&env, "bk_rate");
    client.book_agent(
        &Symbol::new(&env, "svc1"),
        &client_addr,
        &1_000_000_i128,
        &bk_id,
    );

    // Cannot rate uncompleted booking
    assert_eq!(
        client.try_rate_booking(&bk_id, &5),
        Err(Ok(Error::BookingAlreadyCancelled))
    );

    client.complete_booking(&bk_id);
    client.rate_booking(&bk_id, &5);

    // Cannot rate twice
    assert_eq!(
        client.try_rate_booking(&bk_id, &4),
        Err(Ok(Error::AlreadyExists))
    );
}

#[test]
fn negative_auth_set_admin() {
    let (env, client, _admin) = setup_with_admin();
    let intruder = Address::generate(&env);
    env.mock_auths(&[]);
    assert_eq!(
        client.try_set_admin(&intruder),
        Err(Ok(Error::Unauthorized))
    );
}

#[test]
fn negative_auth_pause() {
    let (env, client, _admin) = setup_with_admin();
    env.mock_auths(&[]);
    assert_eq!(client.try_pause(), Err(Ok(Error::Unauthorized)));
}

#[test]
fn negative_auth_queue_action() {
    let (env, client, _admin) = setup_with_admin();
    client.pause();
    env.mock_auths(&[]);
    assert_eq!(
        client.try_queue_action(&AdminAction::Unpause),
        Err(Ok(Error::Unauthorized))
    );
}

#[test]
fn execute_before_delay_reverts_and_after_succeeds() {
    let (env, client, _admin) = setup_with_admin();
    client.pause();
    let id = client.queue_action(&AdminAction::Unpause);
    assert_eq!(
        client.try_execute_action(&id),
        Err(Ok(Error::TimelockNotElapsed))
    );
    assert!(client.is_paused());
    env.ledger().with_mut(|l| l.timestamp += TIMELOCK_DELAY);
    client.execute_action(&id);
    assert!(!client.is_paused());
    // An executed action cannot be replayed.
    assert_eq!(
        client.try_execute_action(&id),
        Err(Ok(Error::ActionNotQueued))
    );
}

#[test]
fn cancel_queued_action() {
    let (env, client, _admin) = setup_with_admin();
    client.pause();
    let id = client.queue_action(&AdminAction::Unpause);
    client.cancel_action(&id);
    env.ledger().with_mut(|l| l.timestamp += TIMELOCK_DELAY);
    assert_eq!(
        client.try_execute_action(&id),
        Err(Ok(Error::ActionNotQueued))
    );
    assert_eq!(
        client.try_cancel_action(&id),
        Err(Ok(Error::ActionNotQueued))
    );
    assert!(client.is_paused());
}

#[test]
fn queue_execute_cancel_emit_events() {
    let (env, client, _admin) = setup_with_admin();
    let eta = env.ledger().timestamp() + TIMELOCK_DELAY;
    let id = client.queue_action(&AdminAction::Unpause);
    let topics = |env: &Env, name: &str| -> soroban_sdk::Vec<Val> {
        (symbol_short!("market"), Symbol::new(env, name)).into_val(env)
    };
    let events = env.events().all();
    let (_, t, d) = events.last().unwrap();
    assert_eq!(t, topics(&env, "queued"));
    assert_eq!(<(u32, u64)>::try_from_val(&env, &d).unwrap(), (id, eta));

    client.cancel_action(&id);
    let events = env.events().all();
    let (_, t, d) = events.last().unwrap();
    assert_eq!(t, topics(&env, "cancelled"));
    assert_eq!(u32::try_from_val(&env, &d).unwrap(), id);

    let id = client.queue_action(&AdminAction::Unpause);
    env.ledger().with_mut(|l| l.timestamp += TIMELOCK_DELAY);
    client.execute_action(&id);
    let events = env.events().all();
    let (_, t, d) = events.last().unwrap();
    assert_eq!(t, topics(&env, "executed"));
    assert_eq!(u32::try_from_val(&env, &d).unwrap(), id);
}

/// Every mutating entrypoint must reject while paused. Add new mutating
/// functions here so a missing pause guard fails this test.
#[test]
fn paused_state_rejects_all_mutating_entrypoints() {
    let (env, client, _admin) = setup_with_admin();
    let a = Address::generate(&env);
    let sym = |s: &str| Symbol::new(&env, s);
    client.pause();

    let paused = Err(Ok(Error::ContractPaused));
    assert_eq!(client.try_set_admin(&a), paused);
    assert_eq!(
        client.try_list_service(&sym("s"), &sym("a"), &a, &sym("c"), &1, &1, &1),
        paused
    );
    assert_eq!(
        client.try_book_agent(&sym("s"), &a, &a, &1, &sym("b")),
        paused
    );
    assert_eq!(client.try_complete_booking(&sym("b")), paused);
    assert_eq!(client.try_cancel_booking(&sym("b")), paused);
    assert_eq!(client.try_rate_booking(&sym("b"), &5), paused);

    run_action(&env, &client, AdminAction::Unpause);
    assert_ne!(client.try_set_admin(&a), paused);
    assert_ne!(
        client.try_list_service(&sym("s"), &sym("a"), &a, &sym("c"), &1, &1, &1),
        paused
    );
    assert_ne!(client.try_complete_booking(&sym("b")), paused);
    assert_ne!(client.try_cancel_booking(&sym("b")), paused);
    assert_ne!(client.try_rate_booking(&sym("b"), &5), paused);
}

// ── Token escrow ─────────────────────────────────────────────────────────────

fn list(env: &Env, client: &AgentMarketplaceContractClient<'_>, owner: &Address) -> Symbol {
    let listing_id = Symbol::new(env, "svc_tok");
    client.list_service(
        &listing_id,
        &Symbol::new(env, "agent_tok"),
        owner,
        &Symbol::new(env, "research"),
        &1_000_000_i128,
        &200_u32,
        &24_u32,
    );
    listing_id
}

#[test]
fn escrow_then_release_pays_owner() {
    let (env, client, _) = setup_with_admin();
    let owner = Address::generate(&env);
    let payer = Address::generate(&env);
    let listing_id = list(&env, &client, &owner);
    let booking_id = Symbol::new(&env, "bk_rel");
    let asset = pay_asset(&env, &client, &payer);
    client.book_agent(&listing_id, &payer, &asset, &1_000_000_i128, &booking_id);

    assert_eq!(balance(&env, &client, &payer), 9_000_000);
    assert_eq!(balance(&env, &client, &client.address), 1_000_000);
    assert_eq!(client.get_booking(&booking_id).unwrap().escrow_amount, 1_000_000);

    client.complete_booking(&booking_id);
    assert_eq!(balance(&env, &client, &owner), 1_000_000);
    assert_eq!(balance(&env, &client, &client.address), 0);
}

#[test]
fn escrow_then_cancel_refunds_client() {
    let (env, client, _) = setup_with_admin();
    let owner = Address::generate(&env);
    let payer = Address::generate(&env);
    let listing_id = list(&env, &client, &owner);
    let booking_id = Symbol::new(&env, "bk_ref");
    let asset = pay_asset(&env, &client, &payer);
    client.book_agent(&listing_id, &payer, &asset, &1_000_000_i128, &booking_id);
    client.cancel_booking(&booking_id);
    assert_eq!(balance(&env, &client, &payer), 10_000_000);
    assert_eq!(balance(&env, &client, &client.address), 0);
}

#[test]
fn booking_fails_without_balance() {
    let (env, client, _) = setup_with_admin();
    let owner = Address::generate(&env);
    let listing_id = list(&env, &client, &owner);
    let asset = pay_asset(&env, &client, &Address::generate(&env));
    let broke = Address::generate(&env);
    let booking_id = Symbol::new(&env, "bk_poor");
    assert!(client
        .try_book_agent(&listing_id, &broke, &asset, &1_000_000_i128, &booking_id)
        .is_err());
    assert!(client.get_booking(&booking_id).is_none());
}

#[test]
fn booking_with_wrong_asset_is_rejected() {
    let (env, client, _) = setup_with_admin();
    let owner = Address::generate(&env);
    let payer = Address::generate(&env);
    let listing_id = list(&env, &client, &owner);
    pay_asset(&env, &client, &payer);
    let other = env.register_stellar_asset_contract_v2(Address::generate(&env));
    assert_eq!(
        client.try_book_agent(
            &listing_id,
            &payer,
            &other.address(),
            &1_000_000_i128,
            &Symbol::new(&env, "bk_wrong"),
        ),
        Err(Ok(Error::AssetMismatch))
    );
    assert_eq!(
        {
            let id = client.queue_action(&AdminAction::SetPaymentAsset(other.address(), 6));
            env.ledger().with_mut(|l| l.timestamp += TIMELOCK_DELAY);
            client.try_execute_action(&id)
        },
        Err(Ok(Error::AssetMismatch))
    );
}

#[test]
fn double_complete_is_rejected_and_pays_once() {
    let (env, client, _) = setup_with_admin();
    let owner = Address::generate(&env);
    let payer = Address::generate(&env);
    let listing_id = list(&env, &client, &owner);
    let booking_id = Symbol::new(&env, "bk_dbl");
    let asset = pay_asset(&env, &client, &payer);
    client.book_agent(&listing_id, &payer, &asset, &1_000_000_i128, &booking_id);
    client.complete_booking(&booking_id);
    assert_eq!(
        client.try_complete_booking(&booking_id),
        Err(Ok(Error::BookingAlreadyCompleted))
    );
    assert_eq!(balance(&env, &client, &owner), 1_000_000);
}

#[test]
fn stroop_conversion_respects_decimals() {
    assert_eq!(stroops_to_units(1_000_000, 7), Ok(1_000_000));
    assert_eq!(stroops_to_units(5, 9), Ok(500));
    assert_eq!(stroops_to_units(1_000, 4), Ok(1));
    assert_eq!(stroops_to_units(1_001, 4), Err(Error::InvalidAmount));
}

// ── Arithmetic fuzzing ───────────────────────────────────────────────────────

/// Deterministic LCG, as in `agent_bidding::property_tests`.
struct Rng(u64);

impl Rng {
    fn next_u64(&mut self) -> u64 {
        self.0 = self.0.wrapping_mul(6364136223846793005).wrapping_add(1);
        self.0
    }

    fn next_i128(&mut self) -> i128 {
        ((self.next_u64() as i128) << 64) | self.next_u64() as i128
    }
}

/// Smoke mode runs 1_000 iterations; set `FUZZ_ITERS` for a long local run.
fn fuzz_iters() -> u64 {
    std::env::var("FUZZ_ITERS")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(1_000)
}

/// Committed corpus of boundary inputs, always replayed before random ones.
const FUZZ_CORPUS: [i128; 8] = [
    i128::MIN,
    -1,
    0,
    1,
    10_000_000,
    i128::MAX - 1,
    i128::MAX,
    1 << 100,
];

fn check_stroops_to_units(amount: i128, decimals: u32) {
    match stroops_to_units(amount, decimals) {
        Ok(units) => {
            // Never negative, and converting back is exact: no value is created
            // or lost, and nothing is rounded.
            assert!(amount >= 0 && units >= 0);
            if decimals >= STROOP_DECIMALS {
                let f = 10i128.pow(decimals - STROOP_DECIMALS);
                assert_eq!(units / f, amount);
                assert_eq!(units % f, 0);
            } else {
                let f = 10i128.pow(STROOP_DECIMALS - decimals);
                assert_eq!(units * f, amount);
            }
        }
        Err(e) => {
            // Overflow, negative amounts and inexact amounts fail cleanly.
            assert_eq!(e, Error::InvalidAmount);
        }
    }
}

#[test]
fn fuzz_stroops_to_units_never_panics_or_leaks_value() {
    for &amount in FUZZ_CORPUS.iter() {
        for decimals in [0, 6, 7, 8, 18, 38, 39, u32::MAX] {
            check_stroops_to_units(amount, decimals);
        }
    }
    let mut rng = Rng(0x5eed);
    for _ in 0..fuzz_iters() {
        let decimals = (rng.next_u64() % 40) as u32;
        // Mix full-range values with small ones so the exact paths are hit too.
        let amount = match rng.next_u64() % 3 {
            0 => rng.next_i128(),
            1 => (rng.next_u64() % 1_000_000_000) as i128,
            _ => (rng.next_u64() % 1_000) as i128 * 10i128.pow((rng.next_u64() % 8) as u32),
        };
        check_stroops_to_units(amount, decimals);
    }
}

#[test]
fn fuzz_escrow_release_and_refund_conserve_funds() {
    let (env, client, _) = setup_with_admin();
    let owner = Address::generate(&env);
    let payer = Address::generate(&env);
    let listing_id = list(&env, &client, &owner);
    let asset = pay_asset(&env, &client, &payer);
    soroban_sdk::token::StellarAssetClient::new(&env, &asset).mint(&payer, &1_000_000_000);
    let total = balance(&env, &client, &payer);

    let mut rng = Rng(0xe5c0);
    for i in 0..fuzz_iters().min(100) {
        let amount = 1_000_000 + (rng.next_u64() % 1_000_000) as i128;
        let booking_id = Symbol::new(&env, &std::format!("bk_fz{i}"));
        client.book_agent(&listing_id, &payer, &asset, &amount, &booking_id);
        if rng.next_u64() % 2 == 0 {
            client.complete_booking(&booking_id);
        } else {
            client.cancel_booking(&booking_id);
        }
        // Escrow is always fully paid out and the total supply is unchanged.
        assert_eq!(balance(&env, &client, &client.address), 0);
        assert_eq!(
            balance(&env, &client, &payer) + balance(&env, &client, &owner),
            total
        );
    }
#[test]
fn gas_snapshots_cover_order_operations() {
    let env = Env::default();
    let cases = [
        (Symbol::new(&env, "listing"), 1u32, gas::GAS_LIST),
        (
            Symbol::new(&env, "search"),
            3u32,
            gas::GAS_SEARCH + gas::GAS_SEARCH_PER_LISTING * 3,
        ),
        (Symbol::new(&env, "purchase"), 2u32, gas::GAS_PURCHASE * 2),
    ];

    for (operation, count, expected) in cases {
        assert_eq!(gas::estimate(operation, count), expected);
    }
    assert_eq!(gas::estimate(Symbol::new(&env, "listing"), 0), 0);
}

}
