//! # Agent Marketplace Unit Tests

extern crate std;

use super::*;
use soroban_sdk::{
    testutils::{Address as _, Events as _},
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
            client.set_payment_asset(&sac.address(), &7);
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
    client.unpause();

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
    let (_env, client, _admin) = setup_with_admin();
    assert!(!client.is_paused());
    client.pause();
    assert!(client.is_paused());
    client.unpause();
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
fn negative_auth_unpause() {
    let (env, client, _admin) = setup_with_admin();
    client.pause();
    env.mock_auths(&[]);
    assert_eq!(client.try_unpause(), Err(Ok(Error::Unauthorized)));
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
        client.try_set_payment_asset(&other.address(), &6),
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
