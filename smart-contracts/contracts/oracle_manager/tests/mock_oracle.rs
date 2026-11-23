//! Oracle Manager behaviour against an injected mock price feed (#762).
//!
//! The mock speaks the same wire protocol as `price_oracle`: `get_price(pair)`
//! returns a `{ price, timestamp }` map or fails with the oracle's error codes,
//! so every failure path can be driven deterministically.

use oracle_manager::{
    Error, OracleFailureEvent, OracleManagerContract, OracleManagerContractClient, PriceSource,
};
use soroban_sdk::{
    contract, contracterror, contractimpl, contracttype, symbol_short,
    testutils::{Address as _, Events as _, Ledger as _, MockAuth, MockAuthInvoke},
    Address, Env, IntoVal, InvokeError, Symbol, TryFromVal,
};

// ── mock oracle ─────────────────────────────────────────────────────────────

/// Error codes mirroring `price_oracle::Error`.
#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
#[repr(u32)]
pub enum MockOracleError {
    NotInitialized = 1,
    FeedNotFound = 4,
    PriceStale = 5,
    ContractPaused = 8,
    Unexpected = 99,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct MockPrice {
    pub price: i128,
    pub timestamp: u64,
}

/// What the mock returns for a pair.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum Feed {
    Price(i128),
    Fail(u32),
    /// A successful call returning a value that is not a price map.
    Garbage,
}

#[contract]
pub struct MockOracle;

#[contractimpl]
impl MockOracle {
    pub fn set_feed(env: Env, pair: Symbol, feed: Feed) {
        env.storage().instance().set(&pair, &feed);
    }

    pub fn get_price(env: Env, pair: Symbol) -> Result<soroban_sdk::Val, MockOracleError> {
        let feed: Option<Feed> = env.storage().instance().get(&pair);
        match feed {
            None => Err(MockOracleError::FeedNotFound),
            Some(Feed::Price(price)) => Ok(MockPrice {
                price,
                timestamp: env.ledger().timestamp(),
            }
            .into_val(&env)),
            Some(Feed::Garbage) => Ok(42u32.into_val(&env)),
            Some(Feed::Fail(code)) => Err(match code {
                1 => MockOracleError::NotInitialized,
                5 => MockOracleError::PriceStale,
                8 => MockOracleError::ContractPaused,
                _ => MockOracleError::Unexpected,
            }),
        }
    }
}

// ── fixture ─────────────────────────────────────────────────────────────────

struct Fx {
    env: Env,
    mgr: OracleManagerContractClient<'static>,
    feed: MockOracleClient<'static>,
    admin: Address,
    pair: Symbol,
}

/// Manager initialised with the mock feed injected at `initialize`.
fn setup() -> Fx {
    let env = Env::default();
    env.mock_all_auths();
    env.ledger().set_timestamp(1_700_000_000);
    let feed_id = env.register(MockOracle, ());
    let feed = MockOracleClient::new(&env, &feed_id);
    let mgr_id = env.register(OracleManagerContract, ());
    let mgr = OracleManagerContractClient::new(&env, &mgr_id);
    let admin = Address::generate(&env);
    mgr.initialize(&admin, &Some(feed_id));
    Fx {
        pair: Symbol::new(&env, "XLM_USD"),
        env,
        mgr,
        feed,
        admin,
    }
}

impl Fx {
    fn feed(&self, f: Feed) {
        self.feed.set_feed(&self.pair, &f);
    }

    /// Payloads of `(mgr, ora_fail)` events from the most recent invocation.
    fn failure_events(&self) -> std::vec::Vec<OracleFailureEvent> {
        let topic = (symbol_short!("mgr"), symbol_short!("ora_fail")).into_val(&self.env);
        self.env
            .events()
            .all()
            .iter()
            .filter(|(_, topics, _)| *topics == topic)
            .map(|(_, _, data)| OracleFailureEvent::try_from_val(&self.env, &data).unwrap())
            .collect()
    }
}

fn contract_err<T, I>(result: Result<T, Result<Error, I>>) -> Error {
    match result {
        Err(Ok(err)) => err,
        Err(Err(_)) => panic!("expected contract error, got host error"),
        Ok(_) => panic!("expected contract error, call succeeded"),
    }
}

fn is_auth_abort<T, E>(result: Result<T, Result<E, InvokeError>>) -> bool {
    matches!(result, Err(Err(InvokeError::Abort)))
}

// ── seam: feed configured at init ───────────────────────────────────────────

#[test]
fn feed_address_set_at_initialize_is_used() {
    let fx = setup();
    assert_eq!(fx.mgr.get_oracle(), Some(fx.feed.address.clone()));
    fx.feed(Feed::Price(12_345));
    let r = fx.mgr.resolve_price(&fx.pair);
    assert_eq!(
        (r.price, r.source, r.pair),
        (12_345, PriceSource::Oracle, fx.pair.clone())
    );
}

#[test]
fn initialize_without_feed_is_fallback_only() {
    let env = Env::default();
    env.mock_all_auths();
    let id = env.register(OracleManagerContract, ());
    let mgr = OracleManagerContractClient::new(&env, &id);
    mgr.initialize(&Address::generate(&env), &None);
    assert_eq!(mgr.get_oracle(), None);
    let pair = Symbol::new(&env, "XLM_USD");
    assert_eq!(
        contract_err(mgr.try_resolve_price(&pair)),
        Error::NoPriceAvailable
    );
    mgr.set_fallback_price(&pair, &7);
    assert_eq!(mgr.resolve_price(&pair).source, PriceSource::Fallback);
}

#[test]
fn feed_can_be_swapped_and_removed() {
    let fx = setup();
    fx.feed(Feed::Price(100));
    let other_id = fx.env.register(MockOracle, ());
    let other = MockOracleClient::new(&fx.env, &other_id);
    other.set_feed(&fx.pair, &Feed::Price(200));

    fx.mgr.set_oracle(&Some(other_id));
    assert_eq!(fx.mgr.resolve_price(&fx.pair).price, 200);

    fx.mgr.set_oracle(&None);
    assert_eq!(
        contract_err(fx.mgr.try_resolve_price(&fx.pair)),
        Error::NoPriceAvailable
    );
}

// ── feed set / read ─────────────────────────────────────────────────────────

#[test]
fn live_feed_wins_over_fallback() {
    let fx = setup();
    fx.mgr.set_fallback_price(&fx.pair, &1);
    fx.feed(Feed::Price(999));
    let r = fx.mgr.resolve_price(&fx.pair);
    assert_eq!((r.price, r.source), (999, PriceSource::Oracle));
    assert!(fx.failure_events().is_empty());
}

#[test]
fn feeds_are_per_pair() {
    let fx = setup();
    let btc = Symbol::new(&fx.env, "BTC_USD");
    fx.feed(Feed::Price(10));
    fx.feed.set_feed(&btc, &Feed::Price(60_000));
    assert_eq!(fx.mgr.resolve_price(&fx.pair).price, 10);
    assert_eq!(fx.mgr.resolve_price(&btc).price, 60_000);
}

#[test]
fn non_positive_feed_price_is_a_call_failure() {
    let fx = setup();
    for bad in [0i128, -5] {
        fx.feed(Feed::Price(bad));
        assert_eq!(
            contract_err(fx.mgr.try_resolve_price(&fx.pair)),
            Error::OracleCallFailed
        );
    }
}

// ── missing feed ────────────────────────────────────────────────────────────

#[test]
fn missing_feed_without_fallback_is_feed_not_found() {
    let fx = setup();
    assert_eq!(
        contract_err(fx.mgr.try_resolve_price(&fx.pair)),
        Error::FeedNotFound
    );
}

#[test]
fn missing_feed_uses_fallback_tagged_as_fallback() {
    let fx = setup();
    fx.mgr.set_fallback_price(&fx.pair, &4_200);
    let r = fx.mgr.resolve_price(&fx.pair);
    assert_eq!((r.price, r.source), (4_200, PriceSource::Fallback));
}

// ── stale & other typed failures ────────────────────────────────────────────

#[test]
fn every_oracle_failure_maps_to_a_typed_error_without_fallback() {
    let cases = [
        (Feed::Fail(5), Error::PriceStale, 5u32),
        (Feed::Fail(8), Error::OraclePaused, 8),
        (Feed::Fail(1), Error::OracleNotInitialized, 1),
        (Feed::Fail(99), Error::OracleCallFailed, 99),
        (Feed::Garbage, Error::OracleCallFailed, 0),
    ];
    for (feed, expected, code) in cases {
        let fx = setup();
        fx.feed(feed.clone());
        assert_eq!(
            contract_err(fx.mgr.try_resolve_price(&fx.pair)),
            expected,
            "{feed:?}"
        );
        let events = fx.failure_events();
        assert_eq!(events.len(), 1, "{feed:?}");
        assert_eq!(events[0].pair, fx.pair);
        assert_eq!(events[0].error_code, code);
    }
}

#[test]
fn stale_feed_is_never_returned_and_falls_back_loudly() {
    let fx = setup();
    fx.feed(Feed::Fail(5));
    fx.mgr.set_fallback_price(&fx.pair, &8_000);
    let r = fx.mgr.resolve_price(&fx.pair);
    assert_eq!((r.price, r.source), (8_000, PriceSource::Fallback));
    let events = fx.failure_events();
    assert_eq!(events.len(), 1);
    assert_eq!(events[0].error_code, 5);
}

#[test]
fn unreachable_feed_address_is_a_call_failure() {
    let fx = setup();
    // An address with no contract deployed behind it.
    fx.mgr.set_oracle(&Some(Address::generate(&fx.env)));
    assert_eq!(
        contract_err(fx.mgr.try_resolve_price(&fx.pair)),
        Error::OracleCallFailed
    );
}

#[test]
fn recovery_after_feed_heals() {
    let fx = setup();
    fx.feed(Feed::Fail(5));
    assert_eq!(
        contract_err(fx.mgr.try_resolve_price(&fx.pair)),
        Error::PriceStale
    );
    fx.feed(Feed::Price(55));
    assert_eq!(fx.mgr.resolve_price(&fx.pair).source, PriceSource::Oracle);
}

#[test]
fn real_price_oracle_speaks_the_same_protocol() {
    use price_oracle::{PriceOracleContract, PriceOracleContractClient};
    let fx = setup();
    let real_id = fx.env.register(PriceOracleContract, ());
    let real = PriceOracleContractClient::new(&fx.env, &real_id);
    real.initialize(&fx.admin, &3_600u64);
    fx.mgr.set_oracle(&Some(real_id));

    assert_eq!(
        contract_err(fx.mgr.try_resolve_price(&fx.pair)),
        Error::FeedNotFound
    );
    let now = fx.env.ledger().timestamp();
    real.submit_price(&fx.pair, &77, &now);
    assert_eq!(fx.mgr.resolve_price(&fx.pair).price, 77);

    fx.env.ledger().set_timestamp(now + 3_601);
    assert_eq!(
        contract_err(fx.mgr.try_resolve_price(&fx.pair)),
        Error::PriceStale
    );
}

// ── admin authorization ─────────────────────────────────────────────────────

#[test]
fn every_admin_fn_aborts_without_admin_signature() {
    let fx = setup();
    let other = Address::generate(&fx.env);
    fx.env.mock_auths(&[]);
    assert!(is_auth_abort(fx.mgr.try_set_admin(&other)));
    assert!(is_auth_abort(fx.mgr.try_pause()));
    assert!(is_auth_abort(fx.mgr.try_unpause()));
    assert!(is_auth_abort(fx.mgr.try_set_oracle(&None)));
    assert!(is_auth_abort(fx.mgr.try_set_fallback_price(&fx.pair, &1)));

    assert_eq!(fx.mgr.get_admin(), fx.admin);
    assert!(!fx.mgr.is_paused());
    assert_eq!(fx.mgr.get_oracle(), Some(fx.feed.address.clone()));
    assert_eq!(fx.mgr.get_fallback_price(&fx.pair), None);
}

#[test]
fn non_admin_signature_does_not_authorize_admin_fns() {
    let fx = setup();
    let intruder = Address::generate(&fx.env);
    let rogue_feed = Address::generate(&fx.env);
    fx.env.mock_auths(&[MockAuth {
        address: &intruder,
        invoke: &MockAuthInvoke {
            contract: &fx.mgr.address,
            fn_name: "set_oracle",
            args: (Some(rogue_feed.clone()),).into_val(&fx.env),
            sub_invokes: &[],
        },
    }]);
    assert!(is_auth_abort(fx.mgr.try_set_oracle(&Some(rogue_feed))));

    fx.env.mock_auths(&[MockAuth {
        address: &intruder,
        invoke: &MockAuthInvoke {
            contract: &fx.mgr.address,
            fn_name: "set_fallback_price",
            args: (fx.pair.clone(), 1i128).into_val(&fx.env),
            sub_invokes: &[],
        },
    }]);
    assert!(is_auth_abort(fx.mgr.try_set_fallback_price(&fx.pair, &1)));
    assert_eq!(fx.mgr.get_oracle(), Some(fx.feed.address.clone()));
}

#[test]
fn set_admin_requires_incoming_admin_signature() {
    let fx = setup();
    let next = Address::generate(&fx.env);
    fx.env.mock_auths(&[MockAuth {
        address: &fx.admin,
        invoke: &MockAuthInvoke {
            contract: &fx.mgr.address,
            fn_name: "set_admin",
            args: (next.clone(),).into_val(&fx.env),
            sub_invokes: &[],
        },
    }]);
    assert!(is_auth_abort(fx.mgr.try_set_admin(&next)));
    assert_eq!(fx.mgr.get_admin(), fx.admin);
}

#[test]
fn initialize_requires_admin_signature_and_is_one_shot() {
    let env = Env::default();
    let id = env.register(OracleManagerContract, ());
    let mgr = OracleManagerContractClient::new(&env, &id);
    let admin = Address::generate(&env);
    assert!(is_auth_abort(mgr.try_initialize(&admin, &None)));
    assert_eq!(contract_err(mgr.try_get_admin()), Error::NotInitialized);

    env.mock_all_auths();
    mgr.initialize(&admin, &None);
    assert_eq!(
        contract_err(mgr.try_initialize(&Address::generate(&env), &None)),
        Error::AlreadyInitialized
    );
}

#[test]
fn admin_fns_before_initialize_are_not_initialized() {
    let env = Env::default();
    env.mock_all_auths();
    let id = env.register(OracleManagerContract, ());
    let mgr = OracleManagerContractClient::new(&env, &id);
    let pair = Symbol::new(&env, "XLM_USD");
    assert_eq!(contract_err(mgr.try_pause()), Error::NotInitialized);
    assert_eq!(
        contract_err(mgr.try_set_oracle(&None)),
        Error::NotInitialized
    );
    assert_eq!(
        contract_err(mgr.try_set_fallback_price(&pair, &1)),
        Error::NotInitialized
    );
}

#[test]
fn paused_manager_rejects_resolution_even_with_live_feed() {
    let fx = setup();
    fx.feed(Feed::Price(10));
    fx.mgr.pause();
    assert_eq!(
        contract_err(fx.mgr.try_resolve_price(&fx.pair)),
        Error::ContractPaused
    );
    fx.mgr.unpause();
    assert_eq!(fx.mgr.resolve_price(&fx.pair).price, 10);
}

// ── integration tests (Issue #949) ──────────────────────────────────────────

#[test]
fn test_full_flow_register_oracle_update_price_read_price() {
    let env = Env::default();
    env.mock_all_auths();
    env.ledger().set_timestamp(1_700_000_000);

    // 1. Deploy contracts
    let mgr_id = env.register(OracleManagerContract, ());
    let mgr = OracleManagerContractClient::new(&env, &mgr_id);
    let admin = Address::generate(&env);
    mgr.initialize(&admin, &None);

    let pair = Symbol::new(&env, "XLM_USD");

    // Initially without oracle, resolve_price fails
    assert_eq!(contract_err(mgr.try_resolve_price(&pair)), Error::NoPriceAvailable);

    // 2. Register oracle
    let feed_id = env.register(MockOracle, ());
    let feed = MockOracleClient::new(&env, &feed_id);
    mgr.set_oracle(&Some(feed_id.clone()));
    assert_eq!(mgr.get_oracle(), Some(feed_id));

    // 3. Update price in oracle
    feed.set_feed(&pair, &Feed::Price(50_000_000));

    // 4. Read price from oracle manager
    let resolved = mgr.resolve_price(&pair);
    assert_eq!(resolved.price, 50_000_000);
    assert_eq!(resolved.source, PriceSource::Oracle);
    assert_eq!(resolved.pair, pair);

    // Update price again
    feed.set_feed(&pair, &Feed::Price(55_000_000));
    let resolved2 = mgr.resolve_price(&pair);
    assert_eq!(resolved2.price, 55_000_000);
    assert_eq!(resolved2.source, PriceSource::Oracle);
}

#[test]
fn test_stale_price_detection() {
    let fx = setup();
    fx.feed(Feed::Price(100));
    assert_eq!(fx.mgr.resolve_price(&fx.pair).price, 100);

    // Mock returns PriceStale error (code 5)
    fx.feed(Feed::Fail(5));

    // Without fallback, detects stale price and returns PriceStale error
    assert_eq!(
        contract_err(fx.mgr.try_resolve_price(&fx.pair)),
        Error::PriceStale
    );

    // Emits OracleFailureEvent with error code 5
    let failures = fx.failure_events();
    assert_eq!(failures.len(), 1);
    assert_eq!(failures[0].error_code, 5);
    assert_eq!(failures[0].pair, fx.pair);

    // With fallback, stale price is detected and fallback price is safely used
    fx.mgr.set_fallback_price(&fx.pair, &75);
    let resolved = fx.mgr.resolve_price(&fx.pair);
    assert_eq!(resolved.price, 75);
    assert_eq!(resolved.source, PriceSource::Fallback);
}

#[test]
fn test_oracle_removal() {
    let fx = setup();
    fx.feed(Feed::Price(100));
    assert_eq!(fx.mgr.get_oracle(), Some(fx.feed.address.clone()));
    assert_eq!(fx.mgr.resolve_price(&fx.pair).price, 100);

    // Remove oracle
    fx.mgr.set_oracle(&None);
    assert_eq!(fx.mgr.get_oracle(), None);

    // Resolution fails when no oracle and no fallback
    assert_eq!(
        contract_err(fx.mgr.try_resolve_price(&fx.pair)),
        Error::NoPriceAvailable
    );

    // Add fallback and resolve succeeds with fallback
    fx.mgr.set_fallback_price(&fx.pair, &42);
    let resolved = fx.mgr.resolve_price(&fx.pair);
    assert_eq!(resolved.price, 42);
    assert_eq!(resolved.source, PriceSource::Fallback);

    // Re-register oracle and live feed takes precedence again
    fx.mgr.set_oracle(&Some(fx.feed.address.clone()));
    assert_eq!(fx.mgr.resolve_price(&fx.pair).price, 100);
    assert_eq!(fx.mgr.resolve_price(&fx.pair).source, PriceSource::Oracle);
}

#[test]
fn test_multiple_oracles_providing_same_asset() {
    let env = Env::default();
    env.mock_all_auths();
    env.ledger().set_timestamp(1_700_000_000);

    let mgr_id = env.register(OracleManagerContract, ());
    let mgr = OracleManagerContractClient::new(&env, &mgr_id);
    let admin = Address::generate(&env);
    mgr.initialize(&admin, &None);

    let pair = Symbol::new(&env, "XLM_USD");

    // Deploy Oracle A providing XLM_USD = 100
    let oracle_a_id = env.register(MockOracle, ());
    let oracle_a = MockOracleClient::new(&env, &oracle_a_id);
    oracle_a.set_feed(&pair, &Feed::Price(100));

    // Deploy Oracle B providing XLM_USD = 105
    let oracle_b_id = env.register(MockOracle, ());
    let oracle_b = MockOracleClient::new(&env, &oracle_b_id);
    oracle_b.set_feed(&pair, &Feed::Price(105));

    // Switch to Oracle A
    mgr.set_oracle(&Some(oracle_a_id.clone()));
    assert_eq!(mgr.get_oracle(), Some(oracle_a_id));
    let res_a = mgr.resolve_price(&pair);
    assert_eq!(res_a.price, 100);
    assert_eq!(res_a.source, PriceSource::Oracle);

    // Switch to Oracle B
    mgr.set_oracle(&Some(oracle_b_id.clone()));
    assert_eq!(mgr.get_oracle(), Some(oracle_b_id));
    let res_b = mgr.resolve_price(&pair);
    assert_eq!(res_b.price, 105);
    assert_eq!(res_b.source, PriceSource::Oracle);
}
