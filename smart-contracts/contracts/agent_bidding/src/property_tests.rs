//! # Property / Fuzz Tests — Agent Bidding Contract
//!
//! Proves mathematical and scoring invariants through generated inputs rather
//! than hand-picked examples.  Every test is deterministic: the same seed
//! produces the same counterexample.
//!
//! ## Seeded runs
//!
//! All tests use a counter-based deterministic PRNG (LCG).  To reproduce a
//! failure, record the `iters` constant and the failing iteration index; the
//! inputs are `seed + iters * index`.

extern crate alloc;
extern crate std;

use super::{
    AgentBiddingContract, AgentBiddingContractClient, MAX_REPUTATION, PRICE_WEIGHT,
    REPUTATION_WEIGHT, SCORE_SCALE,
};

/// Creates a fresh in-memory test environment with the contract registered.
fn setup() -> (Env, AgentBiddingContractClient<'static>) {
    let env = Env::default();
    env.mock_all_auths();
    let id = env.register(AgentBiddingContract, ());
    let client = AgentBiddingContractClient::new(&env, &id);
    (env, client)
}

/// Helper: create a test auction with default config.
fn create_test_auction(
    _env: &Env,
    client: &AgentBiddingContractClient<'_>,
    creator: &Address,
    task_id: &Symbol,
    duration_secs: u64,
) {
    client.create_auction(
        creator,
        task_id,
        &duration_secs,
        &1_000_000, // reserve price: 0.1 XLM in stroops
        &500_000,   // bond: 0.05 XLM
    );
}

/// Recompute the commitment hash from plaintext fields.
/// Mirrors `compute_commitment` in the contract and `test_commitment` in the
/// test module.
fn test_commitment(
    env: &Env,
    bidder: &Address,
    price: i128,
    terms: &String,
    salt: &BytesN<32>,
) -> BytesN<32> {
    use soroban_sdk::xdr::ToXdr;
    let mut preimage = soroban_sdk::Bytes::new(env);
    preimage.append(&bidder.to_xdr(env));
    preimage.append(&price.to_xdr(env));
    preimage.append(&terms.clone().to_xdr(env));
    preimage.append(&salt.to_xdr(env));
    env.crypto().sha256(&preimage).into()
}
use soroban_sdk::{
    testutils::{Address as _, Ledger as _},
    Address, BytesN, Env, String, Symbol,
};

// ─── Deterministic PRNG (LCG, multiplier 6364136223846793005, increment 1) ──

struct Rng {
    state: u64,
}

impl Rng {
    fn new(seed: u64) -> Self {
        Self { state: seed }
    }

    fn next_u64(&mut self) -> u64 {
        self.state = self.state.wrapping_mul(6364136223846793005).wrapping_add(1);
        self.state
    }

    fn next_u32(&mut self) -> u32 {
        (self.next_u64() >> 32) as u32
    }

    fn next_i128(&mut self, max: i128) -> i128 {
        (self.next_u64() as i128).abs() % max
    }
}

// ─── Pure scoring function (mirrors contract logic) ─────────────────────────

fn compute_score(price_a: i128, price_b: i128, rep_a: u32, rep_b: u32) -> (i128, i128) {
    let min_price = price_a.min(price_b);
    let max_price = price_a.max(price_b);
    let price_range = max_price - min_price;

    let min_rep = rep_a.min(rep_b);
    let max_rep = rep_a.max(rep_b);
    let rep_range = (max_rep - min_rep) as i128;

    let price_score_a = if price_range == 0 {
        SCORE_SCALE
    } else {
        SCORE_SCALE * (max_price - price_a) / price_range
    };
    let price_score_b = if price_range == 0 {
        SCORE_SCALE
    } else {
        SCORE_SCALE * (max_price - price_b) / price_range
    };

    let rep_score_a = if rep_range == 0 {
        SCORE_SCALE
    } else {
        SCORE_SCALE * (rep_a - min_rep) as i128 / rep_range
    };
    let rep_score_b = if rep_range == 0 {
        SCORE_SCALE
    } else {
        SCORE_SCALE * (rep_b - min_rep) as i128 / rep_range
    };

    let score_a = (PRICE_WEIGHT * price_score_a + REPUTATION_WEIGHT * rep_score_a) / 100;
    let score_b = (PRICE_WEIGHT * price_score_b + REPUTATION_WEIGHT * rep_score_b) / 100;
    (score_a, score_b)
}

// ─── Helper: build a bid (commitment + submit + reveal) ─────────────────────

fn setup_bid(
    env: &Env,
    client: &AgentBiddingContractClient<'_>,
    task_id: &Symbol,
    bidder: &Address,
    price: i128,
    reputation: u32,
    salt_byte: u8,
) {
    let salt = BytesN::<32>::from_array(env, &[salt_byte; 32]);
    let terms = String::from_str(env, "");
    let comm = test_commitment(env, bidder, price, &terms, &salt);
    client.submit_bid(task_id, bidder, &comm, &500_000, &(reputation as u32));
    env.ledger().set_timestamp(env.ledger().timestamp() + 3601);
    client.reveal_bid(task_id, bidder, &price, &terms, &salt);
}

// ═════════════════════════════════════════════════════════════════════════════
// PROPERTY 1 — Reputation bounds
// ═════════════════════════════════════════════════════════════════════════════

/// Reputation values are always in [0, MAX_REPUTATION] after any valid submission.
#[test]
fn prop_reputation_bounds_within_valid_range() {
    let iters = 500;
    let mut rng = Rng::new(0xDEAD_BEEF_42);

    for _ in 0..iters {
        let (env, client) = setup();
        let creator = Address::generate(&env);
        let bidder = Address::generate(&env);
        let task_id = Symbol::new(&env, "pb1");

        create_test_auction(&env, &client, &creator, &task_id, 3600);

        // Generate valid reputation [0, MAX_REPUTATION].
        let rep = (rng.next_u32() % (MAX_REPUTATION + 1)) as u32;

        let salt = BytesN::<32>::from_array(&env, &[rng.next_u32() as u8; 32]);
        let price: i128 = 2_000_000 + rng.next_i128(8_000_000);
        let terms = String::from_str(&env, "");
        let commitment = test_commitment(&env, &bidder, price, &terms, &salt);

        let result = client.try_submit_bid(&task_id, &bidder, &commitment, &500_000, &rep);
        assert!(
            result.is_ok(),
            "valid reputation {} should be accepted",
            rep
        );

        let bid = client.get_bid(&task_id, &bidder).unwrap();
        assert!(
            bid.reputation <= MAX_REPUTATION,
            "stored reputation {} exceeds MAX_REPUTATION {}",
            bid.reputation,
            MAX_REPUTATION
        );
    }
}

/// Reputation above MAX_REPUTATION is always rejected.
#[test]
fn prop_reputation_above_max_always_rejected() {
    let iters = 200;
    let mut rng = Rng::new(0xCAFE_1234);

    for _ in 0..iters {
        let (env, client) = setup();
        let creator = Address::generate(&env);
        let bidder = Address::generate(&env);
        let task_id = Symbol::new(&env, "pb2");

        create_test_auction(&env, &client, &creator, &task_id, 3600);

        let rep = MAX_REPUTATION + 1 + (rng.next_u32() % 1000);
        let salt = BytesN::<32>::from_array(&env, &[rng.next_u32() as u8; 32]);
        let price: i128 = 2_000_000;
        let terms = String::from_str(&env, "");
        let commitment = test_commitment(&env, &bidder, price, &terms, &salt);

        let result = client.try_submit_bid(&task_id, &bidder, &commitment, &500_000, &rep);
        assert!(result.is_err(), "reputation {} should be rejected", rep);
    }
}

// ═════════════════════════════════════════════════════════════════════════════
// PROPERTY 2 — Bid score monotonicity
// ═════════════════════════════════════════════════════════════════════════════

/// Composite score is in [0, 1000] for any valid pair of bids.
#[test]
fn prop_score_within_bounds() {
    let iters = 500;
    let mut rng = Rng::new(0xBEEF_C0DE);

    for _ in 0..iters {
        let p1 = 1 + rng.next_i128(9_999_999);
        let p2 = 1 + rng.next_i128(9_999_999);
        let r1 = (rng.next_u32() % (MAX_REPUTATION + 1)) as u32;
        let r2 = (rng.next_u32() % (MAX_REPUTATION + 1)) as u32;

        let (s1, s2) = compute_score(p1, p2, r1, r2);
        assert!(s1 >= 0, "score_a {} is negative", s1);
        assert!(s1 <= SCORE_SCALE, "score_a {} exceeds SCORE_SCALE", s1);
        assert!(s2 >= 0, "score_b {} is negative", s2);
        assert!(s2 <= SCORE_SCALE, "score_b {} exceeds SCORE_SCALE", s2);
    }
}

/// When reputation increases (all else equal), score is monotonically non-decreasing.
/// Also, the higher-reputation bidder always scores >= the lower-reputation bidder
/// (at equal price).
#[test]
fn prop_score_monotonic_in_reputation() {
    let iters = 500;
    let mut rng = Rng::new(0xFACE_1234);

    for _ in 0..iters {
        let price = 1 + rng.next_i128(9_999_999);
        let rep_lo = (rng.next_u32() % 99) as u32; // [0, 98]
        let rep_hi = rep_lo + 1 + (rng.next_u32() % (MAX_REPUTATION - rep_lo)) as u32;

        let (s_lo, s_hi) = compute_score(price, price, rep_lo, rep_hi);
        assert!(
            s_hi >= s_lo,
            "higher reputation {} should score >= lower {} (got {} vs {})",
            rep_hi,
            rep_lo,
            s_hi,
            s_lo
        );
    }
}

/// When price decreases (all else equal), score is monotonically non-decreasing.
/// Also, the lower-price bidder always scores >= the higher-price bidder
/// (at equal reputation).
#[test]
fn prop_score_monotonic_in_price() {
    let iters = 500;
    let mut rng = Rng::new(0xA110_9988);

    for _ in 0..iters {
        let price_lo = 1 + rng.next_i128(4_999_999);
        let price_hi = price_lo + 1 + rng.next_i128(5_000_000);
        let rep = (rng.next_u32() % (MAX_REPUTATION + 1)) as u32;

        let (s_hi_price, s_lo_price) = compute_score(price_hi, price_lo, rep, rep);
        assert!(
            s_lo_price >= s_hi_price,
            "lower price {} should score >= higher {} (got {} vs {})",
            price_lo,
            price_hi,
            s_lo_price,
            s_hi_price
        );
    }
}

// ═════════════════════════════════════════════════════════════════════════════
// PROPERTY 3 — Escrow balance conservation
// ═════════════════════════════════════════════════════════════════════════════

/// Helper: submit a bid without advancing time.
fn submit_only(
    env: &Env,
    client: &AgentBiddingContractClient<'_>,
    task_id: &Symbol,
    bidder: &Address,
    price: i128,
    reputation: u32,
    salt_byte: u8,
) {
    let salt = BytesN::<32>::from_array(env, &[salt_byte; 32]);
    let terms = String::from_str(env, "");
    let comm = test_commitment(env, bidder, price, &terms, &salt);
    client.submit_bid(task_id, bidder, &comm, &500_000, &(reputation as u32));
}

/// Helper: reveal a bid after the deadline.
fn reveal_only(
    env: &Env,
    client: &AgentBiddingContractClient<'_>,
    task_id: &Symbol,
    bidder: &Address,
    price: i128,
    salt_byte: u8,
) {
    let salt = BytesN::<32>::from_array(env, &[salt_byte; 32]);
    let terms = String::from_str(env, "");
    client.reveal_bid(task_id, bidder, &price, &terms, &salt);
}

/// Escrow amount always equals the winning bid's price_stroops.
/// All bidder bonds are refunded after award_contract.
#[test]
fn prop_escrow_amount_matches_winning_price() {
    let iters = 200;
    let mut rng = Rng::new(0xDEAD_BEEF_99);

    for _ in 0..iters {
        let (env, client) = setup();
        let creator = Address::generate(&env);
        let task_id = Symbol::new(&env, "pe1");

        create_test_auction(&env, &client, &creator, &task_id, 3600);

        // Two bidders with different prices and reputation.
        let price_a = 1_000_000 + rng.next_i128(4_000_000);
        let price_b = 1_000_000 + rng.next_i128(4_000_000);
        let rep_a = (rng.next_u32() % (MAX_REPUTATION + 1)) as u32;
        let rep_b = (rng.next_u32() % (MAX_REPUTATION + 1)) as u32;

        let a = Address::generate(&env);
        let b = Address::generate(&env);

        // Submit both bids before advancing time.
        submit_only(&env, &client, &task_id, &a, price_a, rep_a, 1);
        submit_only(&env, &client, &task_id, &b, price_b, rep_b, 2);

        // Advance past deadline, then reveal both.
        env.ledger().set_timestamp(env.ledger().timestamp() + 3601);
        reveal_only(&env, &client, &task_id, &a, price_a, 1);
        reveal_only(&env, &client, &task_id, &b, price_b, 2);

        client.reveal_bids(&task_id);

        // Score comparison mirrors contract logic.
        let (score_a, score_b) = compute_score(price_a, price_b, rep_a, rep_b);

        let winner;
        let winning_price;
        if score_a > score_b || (score_a == score_b && price_a < price_b) {
            winner = a.clone();
            winning_price = price_a;
        } else {
            winner = b.clone();
            winning_price = price_b;
        }

        client.award_contract(&task_id);

        let escrow = client.get_escrow(&task_id).unwrap();
        assert_eq!(
            escrow.amount, winning_price,
            "escrow amount {} should equal winning price {}",
            escrow.amount, winning_price
        );
        assert_eq!(escrow.agent, winner);

        // All bonds refunded.
        let bid_a = client.get_bid(&task_id, &a).unwrap();
        let bid_b = client.get_bid(&task_id, &b).unwrap();
        assert!(bid_a.refunded, "bidder A bond not refunded");
        assert!(bid_b.refunded, "bidder B bond not refunded");
    }
}

/// Escrow is not created until award_contract is called.
#[test]
fn prop_escrow_not_created_before_award() {
    let iters = 100;
    let mut rng = Rng::new(0x5678_9ABC);

    for _ in 0..iters {
        let (env, client) = setup();
        let creator = Address::generate(&env);
        let task_id = Symbol::new(&env, "pe2");

        create_test_auction(&env, &client, &creator, &task_id, 3600);

        let bidder = Address::generate(&env);
        let price = 2_000_000 + rng.next_i128(3_000_000);
        let rep = (rng.next_u32() % (MAX_REPUTATION + 1)) as u32;

        setup_bid(&env, &client, &task_id, &bidder, price, rep, 3);
        client.reveal_bids(&task_id);

        let escrow = client.get_escrow(&task_id);
        assert!(
            escrow.is_none(),
            "escrow should not exist before award_contract"
        );

        client.award_contract(&task_id);

        let escrow = client.get_escrow(&task_id).unwrap();
        assert_eq!(escrow.amount, price);
    }
}

// ═════════════════════════════════════════════════════════════════════════════
// PROPERTY 4 — ID uniqueness
// ═════════════════════════════════════════════════════════════════════════════

/// Multiple auctions with distinct task_ids never collide.
#[test]
fn prop_unique_auction_ids() {
    let iters = 200;
    let mut rng = Rng::new(0xAAAA_BBBB);

    let (env, client) = setup();
    let creator = Address::generate(&env);

    for i in 0..iters {
        // Use a format that produces unique symbols.
        let task_id_str = alloc::format!("auc_{}", i);
        let task_id = Symbol::new(&env, &task_id_str);

        let result = client.try_create_auction(&creator, &task_id, &3600, &1_000_000, &500_000);
        assert!(
            result.is_ok(),
            "auction {} should be created without collision",
            i
        );

        let auction = client.get_auction(&task_id).unwrap();
        assert_eq!(auction.task_id, task_id);
    }

    // Verify all auctions are retrievable and distinct.
    for i in 0..iters {
        let task_id_str = alloc::format!("auc_{}", i);
        let task_id = Symbol::new(&env, &task_id_str);
        let auction = client.get_auction(&task_id);
        assert!(auction.is_some(), "auction {} should exist", i);
    }
}

/// Bidders within the same auction are tracked as distinct entries.
#[test]
fn prop_unique_bidder_entries() {
    let iters = 100;
    let mut rng = Rng::new(0xCCCC_DDDD);

    let (env, client) = setup();
    let creator = Address::generate(&env);
    let task_id = Symbol::new(&env, "bid_uniq");

    create_test_auction(&env, &client, &creator, &task_id, 3600);

    for i in 0..iters {
        let bidder = Address::generate(&env);
        let price = 1_000_000 + rng.next_i128(5_000_000);
        let rep = (rng.next_u32() % (MAX_REPUTATION + 1)) as u32;
        let salt = BytesN::<32>::from_array(&env, &[(i % 256) as u8; 32]);
        let terms = String::from_str(&env, "");
        let comm = test_commitment(&env, &bidder, price, &terms, &salt);

        let result = client.try_submit_bid(&task_id, &bidder, &comm, &500_000, &rep);
        assert!(result.is_ok(), "bidder {} should be accepted", i);
    }

    assert_eq!(
        client.get_bidder_count(&task_id),
        iters,
        "bidder count should be {}",
        iters
    );
}

// ═════════════════════════════════════════════════════════════════════════════
// PROPERTY 5 — No-panic on malformed input
// ═════════════════════════════════════════════════════════════════════════════

/// Zero bond always fails gracefully.
#[test]
fn prop_zero_bond_no_panic() {
    let (env, client) = setup();
    let creator = Address::generate(&env);
    let task_id = Symbol::new(&env, "mp1");

    let result = client.try_create_auction(&creator, &task_id, &3600, &1_000_000, &0);
    assert!(result.is_err(), "zero bond should fail, not panic");
}

/// Zero reserve price always fails gracefully.
#[test]
fn prop_zero_reserve_price_no_panic() {
    let (env, client) = setup();
    let creator = Address::generate(&env);
    let task_id = Symbol::new(&env, "mp2");

    let result = client.try_create_auction(&creator, &task_id, &3600, &0, &500_000);
    assert!(result.is_err(), "zero reserve price should fail, not panic");
}

/// Negative bond always fails gracefully.
#[test]
fn prop_negative_bond_no_panic() {
    let (env, client) = setup();
    let creator = Address::generate(&env);
    let task_id = Symbol::new(&env, "mp3");

    let result = client.try_create_auction(&creator, &task_id, &3600, &1_000_000, &-1);
    assert!(result.is_err(), "negative bond should fail, not panic");
}

/// Reputation > MAX_REPUTATION always fails gracefully.
#[test]
fn prop_excess_reputation_no_panic() {
    let (env, client) = setup();
    let creator = Address::generate(&env);
    let bidder = Address::generate(&env);
    let task_id = Symbol::new(&env, "mp4");

    create_test_auction(&env, &client, &creator, &task_id, 3600);

    let salt = BytesN::<32>::from_array(&env, &[0xAA; 32]);
    let terms = String::from_str(&env, "");
    let comm = test_commitment(&env, &bidder, 2_000_000, &terms, &salt);

    for bad_rep in [101u32, 200, 1000, u32::MAX] {
        let result = client.try_submit_bid(&task_id, &bidder, &comm, &500_000, &bad_rep);
        assert!(
            result.is_err(),
            "reputation {} should fail, not panic",
            bad_rep
        );
    }
}

/// Zero commitment always fails gracefully.
#[test]
fn prop_zero_commitment_no_panic() {
    let (env, client) = setup();
    let creator = Address::generate(&env);
    let bidder = Address::generate(&env);
    let task_id = Symbol::new(&env, "mp5");

    create_test_auction(&env, &client, &creator, &task_id, 3600);

    let zero_comm = BytesN::<32>::from_array(&env, &[0u8; 32]);
    let result = client.try_submit_bid(&task_id, &bidder, &zero_comm, &500_000, &50);
    assert!(result.is_err(), "zero commitment should fail, not panic");
}

/// Wrong bond amount always fails gracefully.
#[test]
fn prop_wrong_bond_no_panic() {
    let (env, client) = setup();
    let creator = Address::generate(&env);
    let bidder = Address::generate(&env);
    let task_id = Symbol::new(&env, "mp6");

    create_test_auction(&env, &client, &creator, &task_id, 3600);

    let salt = BytesN::<32>::from_array(&env, &[0xBB; 32]);
    let terms = String::from_str(&env, "");
    let comm = test_commitment(&env, &bidder, 2_000_000, &terms, &salt);

    for wrong_bond in [0i128, 1, 499_999, 500_001, 1_000_000, i128::MAX] {
        let result = client.try_submit_bid(&task_id, &bidder, &comm, &wrong_bond, &50);
        assert!(
            result.is_err(),
            "wrong bond {} should fail, not panic",
            wrong_bond
        );
    }
}

/// Reveal with invalid price (below reserve) always fails gracefully.
#[test]
fn prop_invalid_reveal_price_no_panic() {
    let (env, client) = setup();
    let creator = Address::generate(&env);
    let bidder = Address::generate(&env);
    let task_id = Symbol::new(&env, "mp7");

    create_test_auction(&env, &client, &creator, &task_id, 3600);

    // Use a valid price for commitment, then try revealing with bad price.
    let salt = BytesN::<32>::from_array(&env, &[0xCC; 32]);
    let terms = String::from_str(&env, "");
    let real_price: i128 = 5_000_000;
    let comm = test_commitment(&env, &bidder, real_price, &terms, &salt);
    client.submit_bid(&task_id, &bidder, &comm, &500_000, &50);

    env.ledger().set_timestamp(env.ledger().timestamp() + 3601);

    // Try revealing with price below reserve (1_000_000).
    let result = client.try_reveal_bid(&task_id, &bidder, &999_999, &terms, &salt);
    assert!(
        result.is_err(),
        "reveal with price below reserve should fail, not panic"
    );

    // Try revealing with zero price.
    let result = client.try_reveal_bid(&task_id, &bidder, &0, &terms, &salt);
    assert!(
        result.is_err(),
        "reveal with zero price should fail, not panic"
    );
}

/// Reveal with wrong commitment always fails gracefully.
#[test]
fn prop_wrong_commitment_reveal_no_panic() {
    let (env, client) = setup();
    let creator = Address::generate(&env);
    let bidder = Address::generate(&env);
    let task_id = Symbol::new(&env, "mp8");

    create_test_auction(&env, &client, &creator, &task_id, 3600);

    let salt = BytesN::<32>::from_array(&env, &[0xDD; 32]);
    let terms = String::from_str(&env, "");
    let comm = test_commitment(&env, &bidder, 5_000_000, &terms, &salt);
    client.submit_bid(&task_id, &bidder, &comm, &500_000, &50);

    env.ledger().set_timestamp(env.ledger().timestamp() + 3601);

    // Reveal with wrong price (commitment won't match).
    let result = client.try_reveal_bid(&task_id, &bidder, &9_999_999, &terms, &salt);
    assert!(
        result.is_err(),
        "reveal with wrong commitment should fail, not panic"
    );
}

/// Submit bid with wrong bond always fails gracefully.
#[test]
fn prop_submit_wrong_bond_no_panic() {
    let (env, client) = setup();
    let creator = Address::generate(&env);
    let bidder = Address::generate(&env);
    let task_id = Symbol::new(&env, "mp9");

    create_test_auction(&env, &client, &creator, &task_id, 3600);

    let salt = BytesN::<32>::from_array(&env, &[0xEE; 32]);
    let terms = String::from_str(&env, "");
    let comm = test_commitment(&env, &bidder, 3_000_000, &terms, &salt);

    let result = client.try_submit_bid(&task_id, &bidder, &comm, &1, &50);
    assert!(
        result.is_err(),
        "submit with wrong bond should fail, not panic"
    );
}
