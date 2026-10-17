use price_oracle::{Error, PriceOracleContract, PriceOracleContractClient, DEFAULT_MAX_PRICE_AGE};
use soroban_sdk::{
    testutils::{Address as _, Ledger},
    Address, Env, Symbol,
};

const NOW: u64 = 1_700_000_000;
const MAX_AGE: u64 = 3_600;

struct Fixture {
    env: Env,
    client: PriceOracleContractClient<'static>,
    admin: Address,
    pair: Symbol,
}

fn fixture() -> Fixture {
    let env = Env::default();
    env.mock_all_auths();
    env.ledger().with_mut(|l| {
        l.timestamp = NOW;
        l.sequence_number = 1_000;
    });
    let id = env.register(PriceOracleContract, ());
    let client = PriceOracleContractClient::new(&env, &id);
    let admin = Address::generate(&env);
    let pair = Symbol::new(&env, "XLM_USD");
    Fixture {
        env,
        client,
        admin,
        pair,
    }
}

fn initialized() -> Fixture {
    let f = fixture();
    f.client.initialize(&f.admin, &MAX_AGE);
    f
}

fn set_time(f: &Fixture, timestamp: u64) {
    f.env.ledger().with_mut(|l| l.timestamp = timestamp);
}

// ── Initialization ───────────────────────────────────────────────────────────

#[test]
fn initialize_sets_admin_max_age_and_unpaused() {
    let f = initialized();
    assert_eq!(f.client.get_admin(), f.admin);
    assert_eq!(f.client.get_max_age(), MAX_AGE);
    assert!(!f.client.is_paused());
}

#[test]
fn initialize_with_zero_uses_default_max_age() {
    let f = fixture();
    f.client.initialize(&f.admin, &0u64);
    assert_eq!(f.client.get_max_age(), DEFAULT_MAX_PRICE_AGE);
}

#[test]
fn second_initialize_is_rejected_and_keeps_admin() {
    let f = initialized();
    let other = Address::generate(&f.env);
    assert_eq!(
        f.client.try_initialize(&other, &60u64),
        Err(Ok(Error::AlreadyInitialized))
    );
    assert_eq!(f.client.get_admin(), f.admin);
    assert_eq!(f.client.get_max_age(), MAX_AGE);
}

#[test]
fn calls_before_initialize_report_not_initialized() {
    let f = fixture();
    assert_eq!(f.client.try_get_admin(), Err(Ok(Error::NotInitialized)));
    assert_eq!(
        f.client.try_submit_price(&f.pair, &1i128, &NOW),
        Err(Ok(Error::NotInitialized))
    );
    assert_eq!(f.client.try_pause(), Err(Ok(Error::NotInitialized)));
}

// ── Price set / read ─────────────────────────────────────────────────────────

#[test]
fn submitted_price_can_be_read_back() {
    let f = initialized();
    f.client.submit_price(&f.pair, &10_000_000i128, &NOW);

    let result = f.client.get_price(&f.pair);
    assert_eq!(result.pair, f.pair);
    assert_eq!(result.price, 10_000_000);
    assert_eq!(result.timestamp, NOW);
}

#[test]
fn latest_submission_replaces_previous_price() {
    let f = initialized();
    f.client.submit_price(&f.pair, &10_000_000i128, &NOW);
    f.client.submit_price(&f.pair, &12_000_000i128, &NOW);
    assert_eq!(f.client.get_price(&f.pair).price, 12_000_000);
}

#[test]
fn pairs_are_independent() {
    let f = initialized();
    let eur = Symbol::new(&f.env, "XLM_EUR");
    f.client.submit_price(&f.pair, &10_000_000i128, &NOW);
    f.client.submit_price(&eur, &9_000_000i128, &NOW);
    assert_eq!(f.client.get_price(&f.pair).price, 10_000_000);
    assert_eq!(f.client.get_price(&eur).price, 9_000_000);
}

#[test]
fn unknown_pair_is_feed_not_found() {
    let f = initialized();
    let unknown = Symbol::new(&f.env, "BTC_USD");
    assert_eq!(
        f.client.try_get_price(&unknown),
        Err(Ok(Error::FeedNotFound))
    );
}

// ── Staleness ────────────────────────────────────────────────────────────────

#[test]
fn price_at_exact_max_age_is_still_fresh() {
    let f = initialized();
    f.client.submit_price(&f.pair, &10_000_000i128, &NOW);
    set_time(&f, NOW + MAX_AGE);
    assert_eq!(f.client.get_price(&f.pair).price, 10_000_000);
}

#[test]
fn price_one_second_past_max_age_is_stale() {
    let f = initialized();
    f.client.submit_price(&f.pair, &10_000_000i128, &NOW);
    set_time(&f, NOW + MAX_AGE + 1);
    assert_eq!(f.client.try_get_price(&f.pair), Err(Ok(Error::PriceStale)));
}

#[test]
fn already_old_observation_is_stale_on_read() {
    let f = initialized();
    f.client
        .submit_price(&f.pair, &10_000_000i128, &(NOW - MAX_AGE - 1));
    assert_eq!(f.client.try_get_price(&f.pair), Err(Ok(Error::PriceStale)));
}

#[test]
fn resubmitting_fresh_price_clears_staleness() {
    let f = initialized();
    f.client.submit_price(&f.pair, &10_000_000i128, &NOW);
    set_time(&f, NOW + MAX_AGE + 10);
    assert_eq!(f.client.try_get_price(&f.pair), Err(Ok(Error::PriceStale)));

    f.client
        .submit_price(&f.pair, &11_000_000i128, &(NOW + MAX_AGE + 10));
    assert_eq!(f.client.get_price(&f.pair).price, 11_000_000);
}

#[test]
fn raising_max_age_makes_older_price_fresh_again() {
    let f = initialized();
    f.client.submit_price(&f.pair, &10_000_000i128, &NOW);
    set_time(&f, NOW + MAX_AGE + 1);
    assert_eq!(f.client.try_get_price(&f.pair), Err(Ok(Error::PriceStale)));

    f.client.set_max_price_age(&(MAX_AGE * 2));
    assert_eq!(f.client.get_price(&f.pair).price, 10_000_000);
}

// ── Invalid feed inputs ──────────────────────────────────────────────────────

#[test]
fn zero_and_negative_prices_are_rejected_and_not_stored() {
    let f = initialized();
    assert_eq!(
        f.client.try_submit_price(&f.pair, &0i128, &NOW),
        Err(Ok(Error::InvalidPrice))
    );
    assert_eq!(
        f.client.try_submit_price(&f.pair, &-1i128, &NOW),
        Err(Ok(Error::InvalidPrice))
    );
    assert_eq!(
        f.client.try_submit_price(&f.pair, &i128::MIN, &NOW),
        Err(Ok(Error::InvalidPrice))
    );
    assert_eq!(
        f.client.try_get_price(&f.pair),
        Err(Ok(Error::FeedNotFound))
    );
}

#[test]
fn future_timestamp_is_rejected_and_not_stored() {
    let f = initialized();
    assert_eq!(
        f.client.try_submit_price(&f.pair, &10_000_000i128, &(NOW + 1)),
        Err(Ok(Error::InvalidTimestamp))
    );
    assert_eq!(
        f.client.try_get_price(&f.pair),
        Err(Ok(Error::FeedNotFound))
    );
}

#[test]
fn maximum_price_value_is_accepted() {
    let f = initialized();
    f.client.submit_price(&f.pair, &i128::MAX, &NOW);
    assert_eq!(f.client.get_price(&f.pair).price, i128::MAX);
}

#[test]
fn zero_max_price_age_is_rejected_and_keeps_previous_value() {
    let f = initialized();
    assert_eq!(
        f.client.try_set_max_price_age(&0u64),
        Err(Ok(Error::InvalidMaxPriceAge))
    );
    assert_eq!(f.client.get_max_age(), MAX_AGE);
}

// ── Admin authorization ──────────────────────────────────────────────────────

#[test]
fn admin_can_call_every_mutating_function() {
    let f = initialized();
    let new_admin = Address::generate(&f.env);

    f.client.submit_price(&f.pair, &10_000_000i128, &NOW);
    f.client.set_max_price_age(&7_200u64);
    f.client.pause();
    assert!(f.client.is_paused());
    f.client.unpause();
    assert!(!f.client.is_paused());
    f.client.set_admin(&new_admin);

    assert_eq!(f.client.get_admin(), new_admin);
    assert_eq!(f.client.get_max_age(), 7_200u64);
}

#[test]
fn non_admin_cannot_call_any_mutating_function() {
    let f = initialized();
    let intruder = Address::generate(&f.env);
    f.client.submit_price(&f.pair, &10_000_000i128, &NOW);

    // No authorization is mocked, so every admin-gated call must fail.
    f.env.mock_auths(&[]);
    assert!(f
        .client
        .try_submit_price(&f.pair, &99_000_000i128, &NOW)
        .is_err());
    assert!(f.client.try_set_max_price_age(&60u64).is_err());
    assert!(f.client.try_pause().is_err());
    assert!(f.client.try_unpause().is_err());
    assert!(f.client.try_set_admin(&intruder).is_err());

    // State is unchanged by the rejected calls.
    f.env.mock_all_auths();
    assert_eq!(f.client.get_admin(), f.admin);
    assert_eq!(f.client.get_max_age(), MAX_AGE);
    assert_eq!(f.client.get_price(&f.pair).price, 10_000_000);
    assert!(!f.client.is_paused());
}

#[test]
fn set_admin_hands_control_to_new_admin() {
    let f = initialized();
    let new_admin = Address::generate(&f.env);
    f.client.set_admin(&new_admin);

    assert_eq!(f.client.get_admin(), new_admin);
    f.client.set_max_price_age(&120u64);
    assert_eq!(f.client.get_max_age(), 120u64);
}

// ── Pause ────────────────────────────────────────────────────────────────────

#[test]
fn paused_contract_blocks_reads_and_writes_until_unpaused() {
    let f = initialized();
    f.client.submit_price(&f.pair, &10_000_000i128, &NOW);
    f.client.pause();

    assert_eq!(
        f.client.try_get_price(&f.pair),
        Err(Ok(Error::ContractPaused))
    );
    assert_eq!(f.client.try_get_max_age(), Err(Ok(Error::ContractPaused)));
    assert_eq!(
        f.client.try_submit_price(&f.pair, &1i128, &NOW),
        Err(Ok(Error::ContractPaused))
    );

    f.client.unpause();
    assert_eq!(f.client.get_price(&f.pair).price, 10_000_000);
}
