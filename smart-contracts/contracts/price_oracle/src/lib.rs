#![no_std]

//! # Price Oracle Contract
//!
//! A standalone Soroban contract that acts as the canonical on-chain price
//! feed for ai-net task pricing.  It exposes the `IPriceOracle` interface
//! that any consumer (e.g. the OracleManager) can call via cross-contract
//! invocation.
//!
//! ## Interface (`IPriceOracle`)
//!
//! ```text
//! fn get_price(env, pair) -> Result<PriceResult, Error>
//! fn get_max_age(env)     -> u64
//! ```
//!
//! ## Roles
//!
//! * **Admin** – the address supplied at `initialize`.  Only the admin may:
//!   - push new prices via `submit_price`
//!   - update the `max_price_age` tolerance
//!
//! ## Stale-price policy
//!
//! A price is accepted (returned without error) only when:
//!
//! ```text
//! ledger.timestamp() - price.timestamp <= max_price_age
//! ```
//!
//! Any consumer that receives `Error::PriceStale` **must not** fall through
//! silently; it is expected to either use the admin-configured fallback or
//! abort the operation.
//!
//! ## Storage layout
//!
//! | Key                  | Scope      | Description                        |
//! |----------------------|------------|------------------------------------|
//! | `DataKey::Admin`     | Instance   | Admin address                      |
//! | `DataKey::MaxPriceAge` | Instance | Staleness tolerance (seconds)      |
//! | `DataKey::Price(sym)`| Persistent | Latest `PriceEntry` per pair       |

mod errors;
mod types;

pub use errors::Error;
pub use types::{DataKey, MaxAgeUpdatedEvent, PriceEntry, PriceResult, PriceUpdatedEvent};

use soroban_sdk::{contract, contractimpl, symbol_short, Address, Env, Symbol};

/// Default maximum price age: 3 600 seconds (1 hour).
pub const DEFAULT_MAX_PRICE_AGE: u64 = 3_600;

/// Persistent-storage TTL to use for price entries: ~7 days at 5 s/ledger
/// (17_280 ledgers/day × 7 days).
const PRICE_TTL_LEDGERS: u32 = 17_280 * 7;

// ─── Internal helpers ─────────────────────────────────────────────────────────

fn read_admin(env: &Env) -> Result<Address, Error> {
    env.storage()
        .instance()
        .get(&DataKey::Admin)
        .ok_or(Error::NotInitialized)
}

fn require_admin(env: &Env) -> Result<(), Error> {
    let admin = read_admin(env)?;
    admin.require_auth();
    Ok(())
}

fn read_max_age(env: &Env) -> u64 {
    env.storage()
        .instance()
        .get(&DataKey::MaxPriceAge)
        .unwrap_or(DEFAULT_MAX_PRICE_AGE)
}

// ─── Contract ─────────────────────────────────────────────────────────────────

#[contract]
pub struct PriceOracleContract;

#[contractimpl]
impl PriceOracleContract {
    // ── Lifecycle ─────────────────────────────────────────────────────────────

    /// Initialise the contract.  Must be called exactly once.
    ///
    /// # Arguments
    ///
    /// * `admin`         – Address that will own the feed.
    /// * `max_price_age` – Staleness tolerance in seconds.  Pass `0` to use
    ///                     the default of 3 600 s (1 hour).
    pub fn initialize(env: Env, admin: Address, max_price_age: u64) -> Result<(), Error> {
        if env.storage().instance().has(&DataKey::Admin) {
            return Err(Error::AlreadyInitialized);
        }
        admin.require_auth();
        let age = if max_price_age == 0 {
            DEFAULT_MAX_PRICE_AGE
        } else {
            max_price_age
        };
        env.storage().instance().set(&DataKey::Admin, &admin);
        env.storage().instance().set(&DataKey::MaxPriceAge, &age);
        Ok(())
    }

    // ── Admin operations ──────────────────────────────────────────────────────

    /// Push a new price observation for `pair`.
    ///
    /// The `timestamp` is the off-chain observation time.  It must not exceed
    /// the current ledger timestamp (no future-dated prices).
    ///
    /// # Arguments
    ///
    /// * `pair`      – Asset pair symbol (e.g. `XLM_USD`).
    /// * `price`     – Price in stroops (must be > 0).
    /// * `timestamp` – Off-chain observation time (Unix seconds, must be ≤
    ///                 `env.ledger().timestamp()`).
    pub fn submit_price(env: Env, pair: Symbol, price: i128, timestamp: u64) -> Result<(), Error> {
        require_admin(&env)?;

        if price <= 0 {
            return Err(Error::InvalidPrice);
        }
        let now = env.ledger().timestamp();
        if timestamp > now {
            return Err(Error::InvalidTimestamp);
        }

        let entry = PriceEntry { price, timestamp };
        let key = DataKey::Price(pair.clone());
        env.storage().persistent().set(&key, &entry);
        env.storage().persistent().extend_ttl(
            &key,
            PRICE_TTL_LEDGERS.saturating_sub(1),
            PRICE_TTL_LEDGERS,
        );

        env.events().publish(
            (symbol_short!("oracle"), symbol_short!("updated")),
            PriceUpdatedEvent {
                pair,
                price,
                timestamp,
            },
        );

        Ok(())
    }

    /// Update the staleness tolerance.
    ///
    /// * `new_max_age` – New tolerance in seconds (must be > 0).
    pub fn set_max_price_age(env: Env, new_max_age: u64) -> Result<(), Error> {
        require_admin(&env)?;
        if new_max_age == 0 {
            return Err(Error::InvalidTimestamp); // reuse; a zero age is nonsensical
        }
        let old_max_age = read_max_age(&env);
        env.storage()
            .instance()
            .set(&DataKey::MaxPriceAge, &new_max_age);

        env.events().publish(
            (symbol_short!("oracle"), symbol_short!("age_set")),
            MaxAgeUpdatedEvent {
                old_max_age,
                new_max_age,
            },
        );

        Ok(())
    }

    // ── IPriceOracle interface ─────────────────────────────────────────────────

    /// Return the latest price for `pair`.
    ///
    /// Returns `Error::FeedNotFound` if no price has ever been submitted for
    /// this pair, and `Error::PriceStale` if the most-recent price is older
    /// than the configured `max_price_age`.
    ///
    /// Callers **must not** silently ignore `Error::PriceStale`.
    pub fn get_price(env: Env, pair: Symbol) -> Result<PriceResult, Error> {
        let key = DataKey::Price(pair.clone());
        let entry: PriceEntry = env
            .storage()
            .persistent()
            .get(&key)
            .ok_or(Error::FeedNotFound)?;

        let now = env.ledger().timestamp();
        let max_age = read_max_age(&env);
        if now.saturating_sub(entry.timestamp) > max_age {
            return Err(Error::PriceStale);
        }

        Ok(PriceResult {
            pair,
            price: entry.price,
            timestamp: entry.timestamp,
        })
    }

    /// Return the currently configured staleness tolerance in seconds.
    pub fn get_max_age(env: Env) -> u64 {
        read_max_age(&env)
    }

    /// Return the admin address.  Useful for on-chain permission checks.
    pub fn get_admin(env: Env) -> Result<Address, Error> {
        read_admin(&env)
    }
}

// ─── Tests ───────────────────────────────────────────────────────────────────

#[cfg(test)]
mod test {
    use super::*;
    use soroban_sdk::{
        testutils::{Address as _, Events, Ledger},
        Env, IntoVal,
    };

    // ── Helpers ───────────────────────────────────────────────────────────────

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
            l.timestamp = 1_700_000_000;
            l.sequence_number = 1_000;
        });
        let contract_id = env.register(PriceOracleContract, ());
        let client = PriceOracleContractClient::new(&env, &contract_id);
        let admin = Address::generate(&env);
        let pair = Symbol::new(&env, "XLM_USD");

        Fixture {
            env,
            client,
            admin,
            pair,
        }
    }

    fn init(f: &Fixture) {
        f.client.initialize(&f.admin, &3_600u64);
    }

    fn submit(f: &Fixture, price: i128, ts: u64) {
        f.client.submit_price(&f.pair, &price, &ts);
    }

    // ── Initialisation ────────────────────────────────────────────────────────

    #[test]
    fn initialize_stores_admin_and_max_age() {
        let f = fixture();
        init(&f);
        assert_eq!(f.client.get_admin(), f.admin);
        assert_eq!(f.client.get_max_age(), 3_600u64);
    }

    #[test]
    fn initialize_uses_default_age_when_zero_passed() {
        let f = fixture();
        f.client.initialize(&f.admin, &0u64);
        assert_eq!(f.client.get_max_age(), DEFAULT_MAX_PRICE_AGE);
    }

    #[test]
    fn double_initialize_is_rejected() {
        let f = fixture();
        init(&f);
        assert_eq!(
            f.client.try_initialize(&f.admin, &3_600u64),
            Err(Ok(Error::AlreadyInitialized))
        );
    }

    // ── submit_price ──────────────────────────────────────────────────────────

    #[test]
    fn fresh_price_is_stored_and_returned() {
        let f = fixture();
        init(&f);
        let now = f.env.ledger().timestamp();
        submit(&f, 10_000_000, now);

        let result = f.client.get_price(&f.pair);
        assert_eq!(result.price, 10_000_000);
        assert_eq!(result.timestamp, now);
        assert_eq!(result.pair, f.pair);
    }

    #[test]
    fn submit_price_emits_updated_event() {
        let f = fixture();
        init(&f);
        let now = f.env.ledger().timestamp();
        submit(&f, 10_000_000, now);

        let events = f.env.events().all();
        // 1 event from submit_price (initialize emits nothing)
        assert_eq!(events.len(), 1);
        assert_eq!(
            events.get(0).unwrap().1,
            (symbol_short!("oracle"), symbol_short!("updated")).into_val(&f.env)
        );
    }

    #[test]
    fn zero_price_is_rejected() {
        let f = fixture();
        init(&f);
        let now = f.env.ledger().timestamp();
        assert_eq!(
            f.client.try_submit_price(&f.pair, &0i128, &now),
            Err(Ok(Error::InvalidPrice))
        );
    }

    #[test]
    fn negative_price_is_rejected() {
        let f = fixture();
        init(&f);
        let now = f.env.ledger().timestamp();
        assert_eq!(
            f.client.try_submit_price(&f.pair, &(-1i128), &now),
            Err(Ok(Error::InvalidPrice))
        );
    }

    #[test]
    fn future_timestamp_is_rejected() {
        let f = fixture();
        init(&f);
        let now = f.env.ledger().timestamp();
        assert_eq!(
            f.client
                .try_submit_price(&f.pair, &10_000_000i128, &(now + 1)),
            Err(Ok(Error::InvalidTimestamp))
        );
    }

    // ── get_price ─────────────────────────────────────────────────────────────

    #[test]
    fn unknown_pair_returns_feed_not_found() {
        let f = fixture();
        init(&f);
        let unknown = Symbol::new(&f.env, "BTC_USD");
        assert_eq!(
            f.client.try_get_price(&unknown),
            Err(Ok(Error::FeedNotFound))
        );
    }

    #[test]
    fn stale_price_is_rejected() {
        let f = fixture();
        init(&f);
        let now = f.env.ledger().timestamp();
        // Submit price at `now`, then advance ledger past max_age (3 600 s).
        submit(&f, 10_000_000, now);

        f.env.ledger().with_mut(|l| {
            l.timestamp = now + 3_601; // 1 second beyond tolerance
        });

        assert_eq!(f.client.try_get_price(&f.pair), Err(Ok(Error::PriceStale)));
    }

    #[test]
    fn price_at_exact_max_age_boundary_is_accepted() {
        let f = fixture();
        init(&f);
        let now = f.env.ledger().timestamp();
        submit(&f, 10_000_000, now);

        // Advance exactly to the age boundary (should still be accepted).
        f.env.ledger().with_mut(|l| {
            l.timestamp = now + 3_600;
        });

        let result = f.client.get_price(&f.pair);
        assert_eq!(result.price, 10_000_000);
    }

    #[test]
    fn newer_submission_overwrites_older_price() {
        let f = fixture();
        init(&f);
        let now = f.env.ledger().timestamp();
        submit(&f, 10_000_000, now);
        submit(&f, 12_000_000, now);

        let result = f.client.get_price(&f.pair);
        assert_eq!(result.price, 12_000_000);
    }

    // ── set_max_price_age ────────────────────────────────────────────────────

    #[test]
    fn admin_can_update_max_price_age() {
        let f = fixture();
        init(&f);
        f.client.set_max_price_age(&7_200u64);
        assert_eq!(f.client.get_max_age(), 7_200u64);
    }

    #[test]
    fn set_max_price_age_emits_event() {
        let f = fixture();
        init(&f);
        f.client.set_max_price_age(&7_200u64);

        let events = f.env.events().all();
        assert_eq!(events.len(), 1);
        assert_eq!(
            events.get(0).unwrap().1,
            (symbol_short!("oracle"), symbol_short!("age_set")).into_val(&f.env)
        );
    }

    #[test]
    fn zero_max_age_is_rejected() {
        let f = fixture();
        init(&f);
        assert_eq!(
            f.client.try_set_max_price_age(&0u64),
            Err(Ok(Error::InvalidTimestamp))
        );
    }

    // ── Price feeds for multiple pairs are independent ────────────────────────

    #[test]
    fn multiple_pairs_are_stored_independently() {
        let f = fixture();
        init(&f);
        let now = f.env.ledger().timestamp();
        let pair_b = Symbol::new(&f.env, "XLM_EUR");

        submit(&f, 10_000_000, now);
        f.client.submit_price(&pair_b, &9_000_000i128, &now);

        assert_eq!(f.client.get_price(&f.pair).price, 10_000_000);
        assert_eq!(f.client.get_price(&pair_b).price, 9_000_000);
    }
}
