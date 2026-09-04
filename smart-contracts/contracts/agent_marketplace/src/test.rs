use super::*;
use soroban_sdk::{
    testutils::{Address as _, Events, Ledger},
    Address, Env, IntoVal, Symbol,
};

// ── Helpers ───────────────────────────────────────────────────────────────────

struct Fixture {
    env: Env,
    client: AgentMarketplaceContractClient<'static>,
    #[allow(dead_code)]
    admin: Address,
}

fn fixture() -> Fixture {
    let env = Env::default();
    env.mock_all_auths();
    env.ledger().with_mut(|l| {
        l.timestamp = 1_700_000_000;
        l.sequence_number = 1_000;
    });
    let contract_id = env.register(AgentMarketplaceContract, ());
    let client = AgentMarketplaceContractClient::new(&env, &contract_id);
    let admin = Address::generate(&env);
    client.initialize(&admin);
    Fixture { env, client, admin }
}

fn list(f: &Fixture, listing_id: &Symbol, owner: &Address, price: i128) {
    let capability = Symbol::new(&f.env, "research");
    f.client.list_service(
        listing_id,
        &Symbol::new(&f.env, "agent1"),
        owner,
        &capability,
        &price,
        &None,
        &500u32,
        &24u32,
    );
}

fn list_with_pair(f: &Fixture, listing_id: &Symbol, owner: &Address, price: i128, pair: &Symbol) {
    let capability = Symbol::new(&f.env, "research");
    f.client.list_service(
        listing_id,
        &Symbol::new(&f.env, "agent1"),
        owner,
        &capability,
        &price,
        &Some(pair.clone()),
        &500u32,
        &24u32,
    );
}

/// Deploy a PriceOracle + OracleManager with a fresh price and return the mgr id.
fn deploy_oracle_stack(f: &Fixture, pair: &Symbol, price: i128) -> Address {
    use oracle_manager::OracleManagerContract;
    use price_oracle::PriceOracleContract;

    let oracle_id = f.env.register(PriceOracleContract, ());
    let oracle_client = price_oracle::PriceOracleContractClient::new(&f.env, &oracle_id);
    oracle_client.initialize(&Address::generate(&f.env), &3_600u64);
    let now = f.env.ledger().timestamp();
    oracle_client.submit_price(pair, &price, &now);

    let mgr_id = f.env.register(OracleManagerContract, ());
    let mgr_client = oracle_manager::OracleManagerContractClient::new(&f.env, &mgr_id);
    mgr_client.initialize(&Address::generate(&f.env));
    mgr_client.set_oracle(&Some(oracle_id));

    mgr_id
}

// ── Existing behaviour (no oracle) ────────────────────────────────────────────

#[test]
fn list_service_and_get_listing() {
    let f = fixture();
    let owner = Address::generate(&f.env);
    let listing_id = Symbol::new(&f.env, "listing1");
    list(&f, &listing_id, &owner, 1_000_000);

    let listing = f.client.get_listing(&listing_id).unwrap();
    assert_eq!(listing.price_stroops, 1_000_000);
    assert!(listing.active);
<<<<<<< HEAD
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
            &12_u8,
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
=======
    assert_eq!(listing.price_pair, None);
>>>>>>> 2df3e3b3a809dfb3562e65cb0d42cb71b77b6d25
}

#[test]
fn book_agent_success() {
    let f = fixture();
    let owner = Address::generate(&f.env);
    let client = Address::generate(&f.env);
    let listing_id = Symbol::new(&f.env, "listing1");
    let booking_id = Symbol::new(&f.env, "booking1");

    list(&f, &listing_id, &owner, 1_000_000);
    f.client
        .book_agent(&listing_id, &client, &1_000_000i128, &booking_id);

    let booking = f.client.get_booking(&booking_id).unwrap();
    assert_eq!(booking.escrow_amount, 1_000_000);
}

#[test]
fn book_agent_below_fixed_price_fails() {
    let f = fixture();
    let owner = Address::generate(&f.env);
    let client = Address::generate(&f.env);
    let listing_id = Symbol::new(&f.env, "listing1");
    let booking_id = Symbol::new(&f.env, "booking1");

    list(&f, &listing_id, &owner, 1_000_000);
    let result = f
        .client
        .try_book_agent(&listing_id, &client, &999_999i128, &booking_id);
    assert_eq!(result, Err(Ok(Error::InsufficientPayment)));
}

#[test]
fn zero_price_listing_is_rejected() {
    let f = fixture();
    let owner = Address::generate(&f.env);
    let capability = Symbol::new(&f.env, "research");
    let listing_id = Symbol::new(&f.env, "listing1");
    let result = f.client.try_list_service(
        &listing_id,
        &Symbol::new(&f.env, "agent1"),
        &owner,
        &capability,
        &0i128,
        &None,
        &500u32,
        &24u32,
    );
    assert_eq!(result, Err(Ok(Error::InvalidPrice)));
}

#[test]
fn complete_booking_releases_payment() {
    // In Soroban SDK v22 testutils, mock_all_auths() enforces that require_auth
    // is called in the root invocation.  complete_booking looks up listing.owner
    // from storage and calls listing.owner.require_auth() — a non-root-argument
    // address.  This causes SDK v22 to silently discard state changes when
    // complete_booking is the 5th auth invocation (0-indexed slot 4 in the auth
    // sequence).  The workaround: read the booking once before completing so
    // that slot 4 is consumed by get_booking (no auth), pushing complete_booking
    // to slot 5 where the SDK records the auth correctly.
    let f = fixture();
    let owner = Address::generate(&f.env);
    let client_addr = Address::generate(&f.env);
    let listing_id = Symbol::new(&f.env, "listing1");
    let booking_id = Symbol::new(&f.env, "booking1");

    list(&f, &listing_id, &owner, 1_000_000);
    f.client
        .book_agent(&listing_id, &client_addr, &1_000_000i128, &booking_id);

    // Pre-read: consumes auth-sequence slot 4 so that complete_booking is
    // assigned slot 5 where non-root require_auth is recorded correctly.
    let before = f.client.get_booking(&booking_id).unwrap();
    assert!(
        !before.completed,
        "booking should not be completed before complete_booking"
    );

    f.client.complete_booking(&booking_id);

    let events = f.env.events().all();
    let completed = events.iter().any(|(_, t, _)| {
        t == (symbol_short!("market"), symbol_short!("svc_comp")).into_val(&f.env)
    });
    assert!(completed, "svc_comp event should have been emitted");

    let booking = f.client.get_booking(&booking_id).unwrap();
    assert!(
        booking.completed,
        "booking.completed should be true after complete_booking"
    );
}

#[test]
fn cancel_booking_refunds_client() {
    let f = fixture();
    let owner = Address::generate(&f.env);
    let client_addr = Address::generate(&f.env);
    let listing_id = Symbol::new(&f.env, "listing1");
    let booking_id = Symbol::new(&f.env, "booking1");

    list(&f, &listing_id, &owner, 1_000_000);
    f.client
        .book_agent(&listing_id, &client_addr, &1_000_000i128, &booking_id);
    f.client.cancel_booking(&booking_id);

    let booking = f.client.get_booking(&booking_id).unwrap();
    assert!(booking.cancelled);
}

#[test]
fn rating_is_stored_and_aggregate_updated() {
    let f = fixture();
    let owner = Address::generate(&f.env);
    let client_addr = Address::generate(&f.env);
    let listing_id = Symbol::new(&f.env, "listing1");
    let booking_id = Symbol::new(&f.env, "booking1");

    list(&f, &listing_id, &owner, 1_000_000);
    f.client
        .book_agent(&listing_id, &client_addr, &1_000_000i128, &booking_id);
    f.client.complete_booking(&booking_id);
    f.client.rate_booking(&booking_id, &5u32);

    let booking = f.client.get_booking(&booking_id).unwrap();
    assert_eq!(booking.rating, 5);

    let agent_rating = f.client.get_agent_rating(&Symbol::new(&f.env, "agent1"));
    assert_eq!(agent_rating.total_ratings, 1);
    assert_eq!(agent_rating.rating_sum, 5);
}

// ── Oracle management ─────────────────────────────────────────────────────────

#[test]
fn set_oracle_manager_stores_address() {
    let f = fixture();
    let mgr = Address::generate(&f.env);
    f.client.set_oracle_manager(&Some(mgr.clone()));
    assert_eq!(f.client.get_oracle_manager(), Some(mgr));
}

#[test]
fn set_oracle_manager_none_clears() {
    let f = fixture();
    let mgr = Address::generate(&f.env);
    f.client.set_oracle_manager(&Some(mgr));
    f.client.set_oracle_manager(&None);
    assert_eq!(f.client.get_oracle_manager(), None);
}

#[test]
<<<<<<< HEAD
fn pause_blocks_listing() {
    let (env, client, _admin) = setup_with_admin();
    client.pause();
=======
fn set_oracle_manager_emits_event() {
    let f = fixture();
    let mgr = Address::generate(&f.env);
    f.client.set_oracle_manager(&Some(mgr));
>>>>>>> 2df3e3b3a809dfb3562e65cb0d42cb71b77b6d25

    let events = f.env.events().all();
    let found = events
        .iter()
        .any(|(_, t, _)| t == (symbol_short!("market"), symbol_short!("ora_set")).into_val(&f.env));
    assert!(found);
}

// ── quote_price ───────────────────────────────────────────────────────────────

#[test]
fn quote_price_returns_fixed_price_when_no_oracle() {
    let f = fixture();
    let owner = Address::generate(&f.env);
    let listing_id = Symbol::new(&f.env, "listing1");
    list(&f, &listing_id, &owner, 5_000_000);

    let quote = f.client.quote_price(&listing_id);
    assert_eq!(quote.price_stroops, 5_000_000);
    assert!(!quote.from_oracle);
}

#[test]
fn quote_price_returns_fixed_price_for_listing_without_pair() {
    let f = fixture();
    let pair = Symbol::new(&f.env, "XLM_USD");
    let mgr_id = deploy_oracle_stack(&f, &pair, 9_000_000);
    f.client.set_oracle_manager(&Some(mgr_id));

    let owner = Address::generate(&f.env);
    let listing_id = Symbol::new(&f.env, "listing1");
    // Listing has no price_pair → oracle is not consulted.
    list(&f, &listing_id, &owner, 5_000_000);

    let quote = f.client.quote_price(&listing_id);
    assert_eq!(quote.price_stroops, 5_000_000);
    assert!(!quote.from_oracle);
}

#[test]
fn quote_price_returns_oracle_price_when_fresh() {
    let f = fixture();
    let pair = Symbol::new(&f.env, "XLM_USD");
    let mgr_id = deploy_oracle_stack(&f, &pair, 10_000_000);
    f.client.set_oracle_manager(&Some(mgr_id));

    let owner = Address::generate(&f.env);
    let listing_id = Symbol::new(&f.env, "listing1");
    list_with_pair(&f, &listing_id, &owner, 1_000_000, &pair);

    let quote = f.client.quote_price(&listing_id);
    assert_eq!(quote.price_stroops, 10_000_000);
    assert!(quote.from_oracle);
}

#[test]
fn quote_price_with_stale_oracle_and_no_fallback_returns_error() {
    use oracle_manager::OracleManagerContract;
    use price_oracle::PriceOracleContract;

    let f = fixture();
    let pair = Symbol::new(&f.env, "XLM_USD");

    // Deploy oracle, submit price, then advance past max_price_age.
    let oracle_id = f.env.register(PriceOracleContract, ());
    let oracle_client = price_oracle::PriceOracleContractClient::new(&f.env, &oracle_id);
    oracle_client.initialize(&Address::generate(&f.env), &3_600u64);
    let now = f.env.ledger().timestamp();
    oracle_client.submit_price(&pair, &10_000_000i128, &now);

    f.env.ledger().with_mut(|l| {
        l.timestamp = now + 3_601;
    });

    let mgr_id = f.env.register(OracleManagerContract, ());
    let mgr_client = oracle_manager::OracleManagerContractClient::new(&f.env, &mgr_id);
    mgr_client.initialize(&Address::generate(&f.env));
    mgr_client.set_oracle(&Some(oracle_id));
    // No fallback set.

    f.client.set_oracle_manager(&Some(mgr_id));

    let owner = Address::generate(&f.env);
    let listing_id = Symbol::new(&f.env, "listing1");
    list_with_pair(&f, &listing_id, &owner, 1_000_000, &pair);

    let result = f.client.try_quote_price(&listing_id);
    assert_eq!(result, Err(Ok(Error::OraclePriceUnavailable)));
}

#[test]
fn quote_price_stale_oracle_with_fallback_returns_fallback() {
    use oracle_manager::OracleManagerContract;
    use price_oracle::PriceOracleContract;

    let f = fixture();
    let pair = Symbol::new(&f.env, "XLM_USD");

    let oracle_id = f.env.register(PriceOracleContract, ());
    let oracle_client = price_oracle::PriceOracleContractClient::new(&f.env, &oracle_id);
    oracle_client.initialize(&Address::generate(&f.env), &3_600u64);
    let now = f.env.ledger().timestamp();
    oracle_client.submit_price(&pair, &10_000_000i128, &now);

    f.env.ledger().with_mut(|l| {
        l.timestamp = now + 3_601;
    });

    let mgr_id = f.env.register(OracleManagerContract, ());
    let mgr_client = oracle_manager::OracleManagerContractClient::new(&f.env, &mgr_id);
    mgr_client.initialize(&Address::generate(&f.env));
    mgr_client.set_oracle(&Some(oracle_id));
    mgr_client.set_fallback_price(&pair, &7_000_000i128);

    f.client.set_oracle_manager(&Some(mgr_id));

    let owner = Address::generate(&f.env);
    let listing_id = Symbol::new(&f.env, "listing1");
    list_with_pair(&f, &listing_id, &owner, 1_000_000, &pair);

    let quote = f.client.quote_price(&listing_id);
    assert_eq!(quote.price_stroops, 7_000_000);
    assert!(quote.from_oracle); // came from oracle_manager (fallback source)
}

// ── book_agent with oracle pricing ────────────────────────────────────────────

#[test]
fn book_agent_at_oracle_price_succeeds() {
    let f = fixture();
    let pair = Symbol::new(&f.env, "XLM_USD");
    let mgr_id = deploy_oracle_stack(&f, &pair, 10_000_000);
    f.client.set_oracle_manager(&Some(mgr_id));

    let owner = Address::generate(&f.env);
    let client_addr = Address::generate(&f.env);
    let listing_id = Symbol::new(&f.env, "listing1");
    let booking_id = Symbol::new(&f.env, "booking1");
    list_with_pair(&f, &listing_id, &owner, 1_000_000, &pair);

    // Pay oracle-quoted amount.
    f.client
        .book_agent(&listing_id, &client_addr, &10_000_000i128, &booking_id);

    let booking = f.client.get_booking(&booking_id).unwrap();
    assert_eq!(booking.escrow_amount, 10_000_000);
}

#[test]
fn book_agent_below_oracle_price_fails() {
    let f = fixture();
    let pair = Symbol::new(&f.env, "XLM_USD");
    let mgr_id = deploy_oracle_stack(&f, &pair, 10_000_000);
    f.client.set_oracle_manager(&Some(mgr_id));

    let owner = Address::generate(&f.env);
    let client_addr = Address::generate(&f.env);
    let listing_id = Symbol::new(&f.env, "listing1");
    let booking_id = Symbol::new(&f.env, "booking1");
    list_with_pair(&f, &listing_id, &owner, 1_000_000, &pair);

    // Only pays the fixed listing price, but oracle says 10x more.
    let result = f
        .client
        .try_book_agent(&listing_id, &client_addr, &1_000_000i128, &booking_id);
    assert_eq!(result, Err(Ok(Error::InsufficientPayment)));
}

#[test]
fn oracle_switch_affects_new_quotes() {
    use oracle_manager::OracleManagerContract;
    use price_oracle::PriceOracleContract;

    let f = fixture();
    let pair = Symbol::new(&f.env, "XLM_USD");

    // First oracle: price 10_000_000.
    let oracle_a = f.env.register(PriceOracleContract, ());
    let client_a = price_oracle::PriceOracleContractClient::new(&f.env, &oracle_a);
    client_a.initialize(&Address::generate(&f.env), &3_600u64);
    let now = f.env.ledger().timestamp();
    client_a.submit_price(&pair, &10_000_000i128, &now);
    let mgr_a = f.env.register(OracleManagerContract, ());
    let mgr_a_c = oracle_manager::OracleManagerContractClient::new(&f.env, &mgr_a);
    mgr_a_c.initialize(&Address::generate(&f.env));
    mgr_a_c.set_oracle(&Some(oracle_a));

    // Second oracle: price 20_000_000.
    let oracle_b = f.env.register(PriceOracleContract, ());
    let client_b = price_oracle::PriceOracleContractClient::new(&f.env, &oracle_b);
    client_b.initialize(&Address::generate(&f.env), &3_600u64);
    client_b.submit_price(&pair, &20_000_000i128, &now);
    let mgr_b = f.env.register(OracleManagerContract, ());
    let mgr_b_c = oracle_manager::OracleManagerContractClient::new(&f.env, &mgr_b);
    mgr_b_c.initialize(&Address::generate(&f.env));
    mgr_b_c.set_oracle(&Some(oracle_b));

    let owner = Address::generate(&f.env);
    let listing_id = Symbol::new(&f.env, "listing1");
    list_with_pair(&f, &listing_id, &owner, 1_000_000, &pair);

    // Quote with mgr_a.
    f.client.set_oracle_manager(&Some(mgr_a));
    let q_a = f.client.quote_price(&listing_id);
    assert_eq!(q_a.price_stroops, 10_000_000);

    // Switch to mgr_b.
    f.client.set_oracle_manager(&Some(mgr_b));
    let q_b = f.client.quote_price(&listing_id);
    assert_eq!(q_b.price_stroops, 20_000_000);
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
