//! Integration tests for oracle_manager with mock oracle (#949).

use oracle_manager::{
    Error, OracleManagerContract, OracleManagerContractClient, PriceSource,
};
use soroban_sdk::{
    contract, contracterror, contractimpl, contracttype,
    testutils::{Address as _, Ledger as _},
    Address, Env, IntoVal, Symbol,
};

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

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum Feed {
    Price(i128),
    Fail(u32),
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

fn contract_err<T, I>(result: Result<T, Result<Error, I>>) -> Error {
    match result {
        Err(Ok(err)) => err,
        Err(Err(_)) => panic!("expected contract error, got host error"),
        Ok(_) => panic!("expected contract error, call succeeded"),
    }
}

#[test]
fn test_integration_full_flow() {
    let env = Env::default();
    env.mock_all_auths();
    env.ledger().set_timestamp(1_700_000_000);

    let mgr_id = env.register(OracleManagerContract, ());
    let mgr = OracleManagerContractClient::new(&env, &mgr_id);
    let admin = Address::generate(&env);
    mgr.initialize(&admin, &None);

    let pair = Symbol::new(&env, "XLM_USD");

    // 1. Verify initially no price available
    assert_eq!(contract_err(mgr.try_resolve_price(&pair)), Error::NoPriceAvailable);

    // 2. Register oracle
    let feed_id = env.register(MockOracle, ());
    let feed = MockOracleClient::new(&env, &feed_id);
    mgr.set_oracle(&Some(feed_id.clone()));
    assert_eq!(mgr.get_oracle(), Some(feed_id));

    // 3. Update price
    feed.set_feed(&pair, &Feed::Price(123_456));

    // 4. Read price
    let resolved = mgr.resolve_price(&pair);
    assert_eq!(resolved.price, 123_456);
    assert_eq!(resolved.source, PriceSource::Oracle);
    assert_eq!(resolved.pair, pair);
}

#[test]
fn test_integration_stale_price_detection() {
    let env = Env::default();
    env.mock_all_auths();
    env.ledger().set_timestamp(1_700_000_000);

    let feed_id = env.register(MockOracle, ());
    let feed = MockOracleClient::new(&env, &feed_id);

    let mgr_id = env.register(OracleManagerContract, ());
    let mgr = OracleManagerContractClient::new(&env, &mgr_id);
    let admin = Address::generate(&env);
    mgr.initialize(&admin, &Some(feed_id));

    let pair = Symbol::new(&env, "XLM_USD");
    feed.set_feed(&pair, &Feed::Price(100));
    assert_eq!(mgr.resolve_price(&pair).price, 100);

    // Stale price error from oracle
    feed.set_feed(&pair, &Feed::Fail(5));

    // No fallback -> PriceStale error
    assert_eq!(contract_err(mgr.try_resolve_price(&pair)), Error::PriceStale);

    // With fallback -> safely fallback
    mgr.set_fallback_price(&pair, &80);
    let resolved = mgr.resolve_price(&pair);
    assert_eq!(resolved.price, 80);
    assert_eq!(resolved.source, PriceSource::Fallback);
}

#[test]
fn test_integration_oracle_removal() {
    let env = Env::default();
    env.mock_all_auths();
    env.ledger().set_timestamp(1_700_000_000);

    let feed_id = env.register(MockOracle, ());
    let feed = MockOracleClient::new(&env, &feed_id);

    let mgr_id = env.register(OracleManagerContract, ());
    let mgr = OracleManagerContractClient::new(&env, &mgr_id);
    let admin = Address::generate(&env);
    mgr.initialize(&admin, &Some(feed_id.clone()));

    let pair = Symbol::new(&env, "XLM_USD");
    feed.set_feed(&pair, &Feed::Price(200));
    assert_eq!(mgr.resolve_price(&pair).price, 200);

    // Remove oracle
    mgr.set_oracle(&None);
    assert_eq!(mgr.get_oracle(), None);
    assert_eq!(contract_err(mgr.try_resolve_price(&pair)), Error::NoPriceAvailable);

    // Set fallback
    mgr.set_fallback_price(&pair, &150);
    let fallback_res = mgr.resolve_price(&pair);
    assert_eq!(fallback_res.price, 150);
    assert_eq!(fallback_res.source, PriceSource::Fallback);

    // Re-register
    mgr.set_oracle(&Some(feed_id));
    assert_eq!(mgr.resolve_price(&pair).price, 200);
}

#[test]
fn test_integration_multiple_oracles_same_asset() {
    let env = Env::default();
    env.mock_all_auths();
    env.ledger().set_timestamp(1_700_000_000);

    let mgr_id = env.register(OracleManagerContract, ());
    let mgr = OracleManagerContractClient::new(&env, &mgr_id);
    let admin = Address::generate(&env);
    mgr.initialize(&admin, &None);

    let pair = Symbol::new(&env, "XLM_USD");

    let oracle_1_id = env.register(MockOracle, ());
    let oracle_1 = MockOracleClient::new(&env, &oracle_1_id);
    oracle_1.set_feed(&pair, &Feed::Price(300));

    let oracle_2_id = env.register(MockOracle, ());
    let oracle_2 = MockOracleClient::new(&env, &oracle_2_id);
    oracle_2.set_feed(&pair, &Feed::Price(350));

    // Connect Oracle 1
    mgr.set_oracle(&Some(oracle_1_id.clone()));
    assert_eq!(mgr.resolve_price(&pair).price, 300);

    // Connect Oracle 2
    mgr.set_oracle(&Some(oracle_2_id.clone()));
    assert_eq!(mgr.resolve_price(&pair).price, 350);
}
