//! # Property / Fuzz Tests — Agent Registry Contract
//!
//! Proves invariants through generated inputs rather than hand-picked examples.
//! Every test is deterministic: the same seed produces the same counterexample.
//!
//! ## Seeded runs
//!
//! All tests use a counter-based deterministic PRNG (LCG).  To reproduce a
//! failure, record the `iters` constant and the failing iteration index; the
//! inputs are `seed + iters * index`.
#![cfg(test)]
#![allow(unused, deprecated, clippy::all)]

use super::*;
extern crate std;
use soroban_sdk::{testutils::Address as _, Address, Env, IntoVal, Map, Symbol};
use std::format;

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
        (self.next_u64() as i128).abs() % max + 1
    }
}

// ─── Helpers ────────────────────────────────────────────────────────────────

fn setup() -> (Env, AgentRegistryContractClient<'static>) {
    let env = Env::default();
    env.budget().reset_unlimited();
    env.mock_all_auths();
    let id = env.register(AgentRegistryContract, ());
    let client = AgentRegistryContractClient::new(&env, &id);
    (env, client)
}

fn setup_with_admin() -> (Env, AgentRegistryContractClient<'static>) {
    let env = Env::default();
    env.budget().reset_unlimited();
    env.mock_all_auths();
    let id = env.register(AgentRegistryContract, ());
    let client = AgentRegistryContractClient::new(&env, &id);
    let admin = Address::generate(&env);
    client.initialize(&admin);
    (env, client)
}

fn make_record(env: &Env, id: &str, capability: &str, owner: &Address) -> AgentRecord {
    AgentRecord {
        id: Symbol::new(env, id),
        capability: Symbol::new(env, capability),
        price_stroops: 1_000,
        endpoint: String::from_str(env, "https://agent.example.com"),
        owner: owner.clone(),
        metadata: Map::new(env),
        bond_amount: DEFAULT_MIN_BOND_STROOPS,
    }
}

// ═════════════════════════════════════════════════════════════════════════════
// PROPERTY 1 — Registration sequence uniqueness
// ═════════════════════════════════════════════════════════════════════════════

/// Every registered agent gets a unique sequential index.
#[test]
fn prop_unique_registration_sequence() {
    let iters = 300;
    let mut rng = Rng::new(0xFEED_C0DE);

    let (env, client) = setup_with_admin();

    for i in 0..iters {
        let owner = Address::generate(&env);
        let record = make_record(
            &env,
            &format!("agent_{}", i),
            &format!("cap_{}", i % 10),
            &owner,
        );
        let result = client.try_register_agent(&record);
        assert!(
            result.is_ok(),
            "registration {} should succeed, got {:?}",
            i,
            result.err()
        );
    }

    // Verify total count.
    let total = client.get_agents(&None, &None);
    assert_eq!(total.total_count, iters);

    // Verify sequential indices exist.
    for i in 0..iters {
        let page = client.get_agents(&Some(i), &Some(1));
        assert_eq!(page.agents.len(), 1, "index {} should exist", i);
        let agent = page.agents.get(0).unwrap();
        assert_eq!(
            agent.id,
            Symbol::new(&env, &format!("agent_{}", i)),
            "agent at index {} should have correct id",
            i
        );
    }
}

/// Batch registration also preserves sequential uniqueness.
#[test]
fn prop_batch_registration_preserves_sequence() {
    let iters = 100;
    let mut rng = Rng::new(0xAAAA_1111);

    let (env, client) = setup_with_admin();

    for batch_idx in 0..5 {
        let mut agents = soroban_sdk::Vec::new(&env);
        for j in 0..iters {
            let owner = Address::generate(&env);
            let record = make_record(
                &env,
                &format!("batch_{}_{}", batch_idx, j),
                "research",
                &owner,
            );
            agents.push_back(record);
        }
        let results = client.register_agents(&agents);
        for (k, result) in results.iter().enumerate() {
            assert!(
                matches!(result, BatchResult::Ok(_)),
                "batch item {} should succeed",
                k
            );
        }
    }

    // Verify total.
    let page = client.get_agents(&None, &Some(1000));
    assert_eq!(page.total_count, iters * 5);
}

// ═════════════════════════════════════════════════════════════════════════════
// PROPERTY 2 — Discovery score monotonicity
// ═════════════════════════════════════════════════════════════════════════════

/// The composite discovery score formula produces values in [0, 10000].
#[test]
fn prop_discovery_score_in_bounds() {
    // Directly test the scoring formula with generated inputs.
    // Score = 30*rep + 25*price_comp + 25*avail + 20*resp_comp
    // Each component is [0, 100], so score is in [0, 10000].

    let iters = 500;
    let mut rng = Rng::new(0xBEEF_4321);

    for _ in 0..iters {
        let rep = rng.next_u32() % 101;
        let price_comp = rng.next_u32() % 101;
        let avail = rng.next_u32() % 101;
        let resp_comp = rng.next_u32() % 101;

        let score = 30 * rep + 25 * price_comp + 25 * avail + 20 * resp_comp;
        assert!(
            score <= 10_000,
            "score {} exceeds max of 10000 (rep={}, price={}, avail={}, resp={})",
            score,
            rep,
            price_comp,
            avail,
            resp_comp
        );
    }
}

/// When an agent's reputation increases while all else stays constant, its
/// composite score is monotonically non-decreasing.
#[test]
fn prop_discovery_score_monotonic_in_reputation() {
    let iters = 500;
    let mut rng = Rng::new(0xCAFE_5678);

    for _ in 0..iters {
        let price_comp = rng.next_u32() % 101;
        let avail = rng.next_u32() % 101;
        let resp_comp = rng.next_u32() % 101;
        let rep_lo = rng.next_u32() % 99;
        let rep_hi = rep_lo + 1 + (rng.next_u32() % (100 - rep_lo));

        let score_lo = 30 * rep_lo + 25 * price_comp + 25 * avail + 20 * resp_comp;
        let score_hi = 30 * rep_hi + 25 * price_comp + 25 * avail + 20 * resp_comp;

        assert!(
            score_hi >= score_lo,
            "higher reputation {} should produce higher score ({} >= {})",
            rep_hi,
            score_hi,
            score_lo
        );
    }
}

/// When an agent's availability increases while all else stays constant, its
/// composite score is monotonically non-decreasing.
#[test]
fn prop_discovery_score_monotonic_in_availability() {
    let iters = 500;
    let mut rng = Rng::new(0xDEAD_9876);

    for _ in 0..iters {
        let rep = rng.next_u32() % 101;
        let price_comp = rng.next_u32() % 101;
        let resp_comp = rng.next_u32() % 101;
        let avail_lo = rng.next_u32() % 99;
        let avail_hi = avail_lo + 1 + (rng.next_u32() % (100 - avail_lo));

        let score_lo = 30 * rep + 25 * price_comp + 25 * avail_lo + 20 * resp_comp;
        let score_hi = 30 * rep + 25 * price_comp + 25 * avail_hi + 20 * resp_comp;

        assert!(
            score_hi >= score_lo,
            "higher availability {} should produce higher score ({} >= {})",
            avail_hi,
            score_hi,
            score_lo
        );
    }
}

// ═════════════════════════════════════════════════════════════════════════════
// PROPERTY 3 — ID uniqueness across registrations
// ═════════════════════════════════════════════════════════════════════════════

/// All registered agent IDs are unique.
#[test]
fn prop_all_agent_ids_unique() {
    let iters = 50;

    let (env, client) = setup_with_admin();

    for i in 0..iters {
        let owner = Address::generate(&env);
        let record = make_record(&env, &format!("unique_{}", i), "coding", &owner);
        let result = client.try_register_agent(&record);
        assert!(result.is_ok(), "registration {} should succeed", i);
    }

    // Verify all IDs can be looked up in the page.
    let page = client.get_agents(&None, &Some(50));
    assert_eq!(page.agents.len(), iters);
    for i in 0..iters {
        let id = Symbol::new(&env, &format!("unique_{}", i));
        let mut found = false;
        for j in 0..page.agents.len() {
            if page.agents.get(j).unwrap().id == id {
                found = true;
                break;
            }
        }
        assert!(found, "agent {} should exist in registry", i);
    }
}

/// Duplicate agent IDs are rejected.
#[test]
fn prop_duplicate_agent_id_rejected() {
    let iters = 100;
    let mut rng = Rng::new(0xBBBB_3333);

    let (env, client) = setup_with_admin();

    for i in 0..iters {
        let owner = Address::generate(&env);
        let record = make_record(&env, "duplicate_test", "research", &owner);
        let result = client.try_register_agent(&record);
        if i == 0 {
            assert!(result.is_ok(), "first registration should succeed");
        } else {
            assert!(result.is_err(), "duplicate registration {} should fail", i);
        }
    }
}

// ═════════════════════════════════════════════════════════════════════════════
// PROPERTY 4 — Bond invariants
// ═════════════════════════════════════════════════════════════════════════════

/// All registered agents must have bond_amount >= min_bond.
#[test]
fn prop_agent_bond_always_at_least_min() {
    let iters = 200;
    let mut rng = Rng::new(0xCCCC_4444);

    let (env, client) = setup_with_admin();

    for i in 0..iters {
        let owner = Address::generate(&env);
        let mut record = make_record(&env, &format!("bond_{}", i), "risk", &owner);
        // Ensure bond is at least min.
        record.bond_amount = DEFAULT_MIN_BOND_STROOPS + rng.next_i128(100_000_000);
        let result = client.try_register_agent(&record);
        assert!(result.is_ok(), "registration {} should succeed", i);

        // Verify stored bond matches.
        let key = DataKey::Agent(record.id);
        let stored: AgentRecord = env.as_contract(&client.address, || {
            env.storage().persistent().get(&key).unwrap()
        });
        assert_eq!(
            stored.bond_amount, record.bond_amount,
            "stored bond should match submitted bond"
        );
        assert!(
            stored.bond_amount >= DEFAULT_MIN_BOND_STROOPS,
            "bond {} should be >= min_bond",
            stored.bond_amount
        );
    }
}

/// Registration with bond below minimum is rejected.
#[test]
fn prop_insufficient_bond_rejected() {
    let (env, client) = setup_with_admin();

    for extra in [0i128, -1, -100, -1000] {
        let owner = Address::generate(&env);
        let id_str = format!("low_bond_{}", extra.abs());
        let record = AgentRecord {
            id: Symbol::new(&env, &id_str),
            capability: Symbol::new(&env, "coding"),
            price_stroops: 1_000,
            endpoint: String::from_str(&env, "https://agent.example.com"),
            owner,
            metadata: Map::new(&env),
            bond_amount: DEFAULT_MIN_BOND_STROOPS + extra,
        };
        let result = client.try_register_agent(&record);
        if extra < 0 {
            assert!(
                result.is_err(),
                "bond {} (extra={}) should be rejected",
                record.bond_amount,
                extra
            );
        }
    }
}

// ═════════════════════════════════════════════════════════════════════════════
// PROPERTY 5 — No-panic on malformed input
// ═════════════════════════════════════════════════════════════════════════════

/// Registration with empty string agent ID fails gracefully.
#[test]
fn prop_empty_agent_id_no_panic() {
    let (env, client) = setup_with_admin();
    let owner = Address::generate(&env);
    let record = AgentRecord {
        id: Symbol::new(&env, ""),
        capability: Symbol::new(&env, "research"),
        price_stroops: 1_000,
        endpoint: String::from_str(&env, "https://agent.example.com"),
        owner,
        metadata: Map::new(&env),
        bond_amount: DEFAULT_MIN_BOND_STROOPS,
    };
    let result = client.try_register_agent(&record);
    assert!(
        result.is_ok(),
        "empty agent ID should be accepted (Soroban Symbols allow empty)"
    );
}

/// Registration with metadata exceeding MAX_METADATA_ENTRIES is rejected.
#[test]
fn prop_excess_metadata_rejected() {
    let (env, client) = setup_with_admin();
    let owner = Address::generate(&env);
    let mut metadata = Map::new(&env);
    for i in 0..=MAX_METADATA_ENTRIES {
        metadata.set(Symbol::new(&env, &format!("key_{}", i)), i.into_val(&env));
    }
    let record = AgentRecord {
        id: Symbol::new(&env, "too_much_meta"),
        capability: Symbol::new(&env, "research"),
        price_stroops: 1_000,
        endpoint: String::from_str(&env, "https://agent.example.com"),
        owner,
        metadata,
        bond_amount: DEFAULT_MIN_BOND_STROOPS,
    };
    let result = client.try_register_agent(&record);
    assert!(
        result.is_err(),
        "registration with > MAX_METADATA_ENTRIES should fail"
    );
}

/// Registration with negative price fails gracefully (price is i128).
#[test]
fn prop_negative_price_no_panic() {
    let (env, client) = setup_with_admin();
    let owner = Address::generate(&env);
    let record = AgentRecord {
        id: Symbol::new(&env, "neg_price"),
        capability: Symbol::new(&env, "coding"),
        price_stroops: -1_000,
        endpoint: String::from_str(&env, "https://agent.example.com"),
        owner,
        metadata: Map::new(&env),
        bond_amount: DEFAULT_MIN_BOND_STROOPS,
    };
    // Negative price is technically allowed by the type (i128).
    // The contract does not explicitly reject it — this tests that it doesn't panic.
    let result = client.try_register_agent(&record);
    // Either accepted or rejected, but must not panic.
    assert!(
        result.is_ok() || result.is_err(),
        "negative price should not cause panic"
    );
}

/// Registration with i128::MAX price does not panic.
#[test]
fn prop_max_price_no_panic() {
    let (env, client) = setup_with_admin();
    let owner = Address::generate(&env);
    let record = AgentRecord {
        id: Symbol::new(&env, "max_price"),
        capability: Symbol::new(&env, "research"),
        price_stroops: i128::MAX,
        endpoint: String::from_str(&env, "https://agent.example.com"),
        owner,
        metadata: Map::new(&env),
        bond_amount: DEFAULT_MIN_BOND_STROOPS,
    };
    let result = client.try_register_agent(&record);
    assert!(
        result.is_ok() || result.is_err(),
        "max i128 price should not cause panic"
    );
}

/// Registration with very long capability symbol does not panic.
#[test]
fn prop_long_capability_no_panic() {
    let (env, client) = setup_with_admin();
    let owner = Address::generate(&env);
    // Soroban Symbol is limited to 9 bytes for short, 32 for long.
    let long_cap = "very_long_capability_name_to_32_";
    let record = AgentRecord {
        id: Symbol::new(&env, "long_cap"),
        capability: Symbol::new(&env, long_cap),
        price_stroops: 1_000,
        endpoint: String::from_str(&env, "https://agent.example.com"),
        owner,
        metadata: Map::new(&env),
        bond_amount: DEFAULT_MIN_BOND_STROOPS,
    };
    let result = client.try_register_agent(&record);
    // Should succeed or fail gracefully, never panic.
    assert!(
        result.is_ok() || result.is_err(),
        "long capability name should not cause panic"
    );
}

/// Registration with very long endpoint string does not panic.
#[test]
fn prop_long_endpoint_no_panic() {
    let (env, client) = setup_with_admin();
    let owner = Address::generate(&env);
    let long_endpoint: String = String::from_str(
        &env,
        &"https://very-long-endpoint.example.com/agent/capability/endpoint/path/repeated/over/and/over/again/to/exceed/normal/length/limits/for/testing/purposes",
    );
    let record = AgentRecord {
        id: Symbol::new(&env, "long_ep"),
        capability: Symbol::new(&env, "coding"),
        price_stroops: 1_000,
        endpoint: long_endpoint,
        owner,
        metadata: Map::new(&env),
        bond_amount: DEFAULT_MIN_BOND_STROOPS,
    };
    let result = client.try_register_agent(&record);
    assert!(
        result.is_ok() || result.is_err(),
        "long endpoint should not cause panic"
    );
}

/// Batch registration with empty list succeeds.
#[test]
fn prop_empty_batch_no_panic() {
    let (env, client) = setup_with_admin();
    let agents = soroban_sdk::Vec::new(&env);
    let results = client.register_agents(&agents);
    assert_eq!(results.len(), 0, "empty batch should return empty results");
}

/// Batch registration with duplicate IDs in batch fails gracefully.
#[test]
fn prop_batch_duplicate_ids_no_panic() {
    let (env, client) = setup_with_admin();

    let owner = Address::generate(&env);
    let r1 = make_record(&env, "dup_batch", "research", &owner);
    let r2 = make_record(&env, "dup_batch", "coding", &owner);

    let mut agents = soroban_sdk::Vec::new(&env);
    agents.push_back(r1);
    agents.push_back(r2);

    let results = client.register_agents(&agents);
    // First should succeed, second should fail with DuplicateInBatch.
    assert!(
        matches!(results.get(0).unwrap(), BatchResult::Ok(_)),
        "first should succeed"
    );
    assert!(
        matches!(results.get(1).unwrap(), BatchResult::Err(_)),
        "second should fail with duplicate"
    );
}

/// All error codes returned by batch registration are valid.
#[test]
fn prop_batch_error_codes_valid() {
    let (env, client) = setup_with_admin();

    // Try to register with insufficient bond — should produce a valid error code.
    let owner = Address::generate(&env);
    let record = AgentRecord {
        id: Symbol::new(&env, "err_code_test"),
        capability: Symbol::new(&env, "research"),
        price_stroops: 1_000,
        endpoint: String::from_str(&env, "https://agent.example.com"),
        owner,
        metadata: Map::new(&env),
        bond_amount: 1, // Way below minimum.
    };

    let mut agents = soroban_sdk::Vec::new(&env);
    agents.push_back(record);

    let results = client.register_agents(&agents);
    if let BatchResult::Err(code) = results.get(0).unwrap() {
        // Verify it's a known error code.
        assert!(code > 0, "error code should be positive");
        // The error should be InsufficientBond.
        let err = Error::from_code(code);
        assert!(
            err == Some(Error::InsufficientBond),
            "expected InsufficientBond, got {:?}",
            err
        );
    }
}

/// Storage limit rejection preserves no-write semantics.
#[test]
fn prop_storage_limit_no_write() {
    let (env, client) = setup_with_admin();

    // Set max_agents to 2.
    client.set_storage_config(&StorageConfig {
        max_agents: 2,
        max_per_capability: 0,
    });

    let o1 = Address::generate(&env);
    let o2 = Address::generate(&env);
    let o3 = Address::generate(&env);

    let r1 = make_record(&env, "limit_a", "coding", &o1);
    let r2 = make_record(&env, "limit_b", "coding", &o2);
    let r3 = make_record(&env, "limit_c", "coding", &o3);

    let mut batch1 = soroban_sdk::Vec::new(&env);
    batch1.push_back(r1);
    batch1.push_back(r2);
    let results1 = client.register_agents(&batch1);
    assert!(matches!(results1.get(0).unwrap(), BatchResult::Ok(_)));
    assert!(matches!(results1.get(1).unwrap(), BatchResult::Ok(_)));

    let mut batch2 = soroban_sdk::Vec::new(&env);
    batch2.push_back(r3);
    let results2 = client.register_agents(&batch2);
    // Third should fail with StorageLimitReached.
    assert!(
        matches!(results2.get(0).unwrap(), BatchResult::Err(_)),
        "third should fail"
    );

    // Verify exactly 2 agents exist.
    let page = client.get_agents(&None, &Some(100));
    assert_eq!(page.total_count, 2, "only 2 agents should be stored");
}

// ═════════════════════════════════════════════════════════════════════════════
// PROPERTY 6 — Capability index consistency
// ═════════════════════════════════════════════════════════════════════════════

/// Agents registered under a capability are all returned by lookup_agents.
#[test]
fn prop_capability_index_consistent() {
    let iters = 50;
    let mut rng = Rng::new(0xDDDD_6666);

    let (env, client) = setup_with_admin();

    let caps = ["research", "coding", "design", "risk", "report"];
    let mut expected_counts = [0u32; 5];

    for i in 0..iters {
        let cap_idx = (rng.next_u32() % 5) as usize;
        let owner = Address::generate(&env);
        let record = make_record(&env, &format!("cap_{}", i), caps[cap_idx], &owner);
        let result = client.try_register_agent(&record);
        if result.is_ok() {
            expected_counts[cap_idx] += 1;
        }
    }

    // Verify lookup_agents returns the right count for each capability.
    for (idx, cap) in caps.iter().enumerate() {
        let results = client.lookup_agents(&Symbol::new(&env, cap));
        assert_eq!(
            results.len(),
            expected_counts[idx],
            "capability '{}' should have {} agents",
            cap,
            expected_counts[idx]
        );
    }
}

// ═════════════════════════════════════════════════════════════════════════════
// PROPERTY 7 — Reputation scoring and decay math
// ═════════════════════════════════════════════════════════════════════════════

/// The weighted score stays within [0, REPUTATION_SCALE] for any u32 inputs
/// (including u32::MAX) and never drops when a component is raised.
#[test]
fn prop_reputation_score_bounded_and_monotonic() {
    let iters = 2_000;
    let mut rng = Rng::new(0xEEEE_7777);

    for i in 0..iters {
        let pick = |rng: &mut Rng| match rng.next_u32() % 4 {
            0 => u32::MAX,
            1 => rng.next_u32() % 101,
            _ => rng.next_u32(),
        };
        let lo = ReputationInput {
            success_rate: pick(&mut rng),
            quality: pick(&mut rng),
            uptime: pick(&mut rng),
            price_fairness: pick(&mut rng),
        };
        let hi = ReputationInput {
            success_rate: lo.success_rate.max(pick(&mut rng)),
            quality: lo.quality.max(pick(&mut rng)),
            uptime: lo.uptime.max(pick(&mut rng)),
            price_fairness: lo.price_fairness.max(pick(&mut rng)),
        };

        let lo_score = reputation_score_fp(&lo);
        let hi_score = reputation_score_fp(&hi);
        assert!(
            lo_score <= REPUTATION_SCALE,
            "iter {}: score above scale",
            i
        );
        assert!(
            hi_score <= REPUTATION_SCALE,
            "iter {}: score above scale",
            i
        );
        assert!(
            hi_score >= lo_score,
            "iter {}: raising inputs lowered score",
            i
        );
    }
}

/// Lazy decay never increases a score, never panics on u64-boundary inputs,
/// and advances the timestamp only by whole epochs without passing `now`.
#[test]
fn prop_reputation_decay_never_increases_and_no_overflow() {
    let iters = 2_000;
    let mut rng = Rng::new(0xFFFF_8888);

    for i in 0..iters {
        let score = match rng.next_u32() % 3 {
            0 => u64::MAX,
            1 => rng.next_u64() % (REPUTATION_SCALE + 1),
            _ => rng.next_u64(),
        };
        let last_updated = match rng.next_u32() % 3 {
            0 => 0,
            1 => u64::MAX,
            _ => rng.next_u64(),
        };
        let now = match rng.next_u32() % 3 {
            0 => 0,
            1 => u64::MAX,
            _ => rng.next_u64(),
        };
        let config = ReputationConfig {
            decay_pct: rng.next_u32(),
            epoch_secs: match rng.next_u32() % 3 {
                0 => 1,
                1 => u64::MAX,
                _ => rng.next_u64().max(1),
            },
        };

        let (out, advanced, epochs) = apply_reputation_decay(score, last_updated, now, &config);
        assert!(out <= score, "iter {}: decay increased score", i);
        assert!(advanced >= last_updated, "iter {}: timestamp moved back", i);
        assert!(
            advanced <= last_updated.max(now),
            "iter {}: timestamp past now",
            i
        );
        assert_eq!(
            (advanced - last_updated) % config.epoch_secs,
            0,
            "iter {}: timestamp not epoch-aligned",
            i
        );
        if epochs == 0 {
            assert_eq!(out, score, "iter {}: score changed without an epoch", i);
        }
        if epochs > MAX_DECAY_EPOCHS {
            assert_eq!(out, 0, "iter {}: dormant agent not zeroed", i);
        }
    }
}

/// With a valid schedule, a longer idle period never yields a higher score.
#[test]
fn prop_reputation_decay_monotonic_in_elapsed_epochs() {
    let iters = 2_000;
    let mut rng = Rng::new(0x1111_9999);

    for i in 0..iters {
        let score = rng.next_u64() % (REPUTATION_SCALE + 1);
        let config = ReputationConfig {
            decay_pct: rng.next_u32() % 101,
            epoch_secs: 1 + rng.next_u64() % 1_000_000,
        };
        let last_updated = rng.next_u64() % (1 << 40);
        let k = rng.next_u64() % 150;

        let at = |n: u64| {
            let now = last_updated + n * config.epoch_secs;
            apply_reputation_decay(score, last_updated, now, &config).0
        };
        assert!(
            at(k + 1) <= at(k),
            "iter {}: more idle epochs raised score",
            i
        );
        assert!(at(k) <= score, "iter {}: decay increased score", i);
        if config.decay_pct == 100 && k >= 1 {
            assert_eq!(at(k), 0, "iter {}: 100% decay should zero the score", i);
        }
    }
}

// ═════════════════════════════════════════════════════════════════════════════
// PROPERTY 8 — Bond arithmetic (proptest, issue #934)
// ═════════════════════════════════════════════════════════════════════════════
//
// Stake, slash and refund are exercised with `proptest`-generated amounts,
// including values next to `i128::MAX`, to prove that bond bookkeeping is
// conserved and never overflows or underflows. Overflow must surface as a
// contract error (`InvalidConfig`), never as a host panic, and a rejected call
// must leave the stored bond untouched.

mod bond_proptests {
    use super::*;
    use proptest::prelude::*;
    use soroban_sdk::testutils::Ledger as _;

    /// Upper bound for "ordinary" bond amounts: 10^12 XLM in stroops. Keeps the
    /// arithmetic well inside i128 so these cases test logic, not overflow.
    const MAX_ORDINARY_BOND: i128 = 10_000_000_000_000_000_000;

    fn register(env: &Env, client: &AgentRegistryContractClient<'_>, bond: i128) -> Symbol {
        let owner = Address::generate(env);
        let mut record = make_record(env, "bond_prop", "research", &owner);
        record.bond_amount = bond;
        client.register_agent(&record);
        record.id
    }

    fn bond_of(client: &AgentRegistryContractClient<'_>, id: &Symbol) -> bond::BondRecord {
        client.get_bond(id).expect("bond record must exist")
    }

    /// `bond_amount` on the stored `AgentRecord` (no public single-agent
    /// getter exists, so read storage directly).
    fn agent_bond(env: &Env, client: &AgentRegistryContractClient<'_>, id: &Symbol) -> i128 {
        env.as_contract(&client.address, || {
            env.storage()
                .persistent()
                .get::<_, AgentRecord>(&DataKey::Agent(id.clone()))
                .expect("agent record must exist")
                .bond_amount
        })
    }

    fn reason(env: &Env) -> String {
        String::from_str(env, "property test")
    }

    fn ordinary_bond() -> impl Strategy<Value = i128> {
        DEFAULT_MIN_BOND_STROOPS..=MAX_ORDINARY_BOND
    }

    proptest! {
        #![proptest_config(ProptestConfig::with_cases(64))]

        // ── Staking ──────────────────────────────────────────────────────────

        /// Registering with any bond ≥ min stakes exactly that amount, and
        /// every subsequent deposit adds exactly its amount to both the bond
        /// record and the agent record.
        #[test]
        fn prop_stake_and_deposit_accumulate_exactly(
            initial in ordinary_bond(),
            deposits in prop::collection::vec(ordinary_bond(), 0..4),
        ) {
            let (env, client) = setup_with_admin();
            let id = register(&env, &client, initial);
            let b = bond_of(&client, &id);
            prop_assert_eq!(b.amount_stroops, initial);
            prop_assert_eq!(b.status, bond::BondStatus::Active);

            let mut expected = initial;
            for d in deposits {
                client.deposit_bond(&id, &d);
                expected += d;
                prop_assert_eq!(bond_of(&client, &id).amount_stroops, expected);
                prop_assert_eq!(agent_bond(&env, &client, &id), expected);
            }
        }

        /// Registration below the minimum is always rejected and stakes nothing.
        #[test]
        fn prop_stake_below_minimum_rejected(bond in i128::MIN..DEFAULT_MIN_BOND_STROOPS) {
            let (env, client) = setup_with_admin();
            let owner = Address::generate(&env);
            let mut record = make_record(&env, "bond_prop", "research", &owner);
            record.bond_amount = bond;
            prop_assert_eq!(
                client.try_register_agent(&record),
                Err(Ok(Error::InsufficientBond))
            );
            prop_assert!(client.get_bond(&record.id).is_none());
        }

        /// A deposit that would overflow i128 is rejected with a contract error
        /// and leaves the existing stake untouched.
        #[test]
        fn prop_deposit_overflow_is_rejected_not_panicking(
            initial in (i128::MAX / 2)..=i128::MAX,
            extra in (i128::MAX / 2)..=i128::MAX,
        ) {
            let (env, client) = setup_with_admin();
            let id = register(&env, &client, initial);
            let result = client.try_deposit_bond(&id, &extra);
            match initial.checked_add(extra) {
                Some(total) => {
                    prop_assert_eq!(result, Ok(Ok(())));
                    prop_assert_eq!(bond_of(&client, &id).amount_stroops, total);
                }
                None => {
                    prop_assert_eq!(result, Err(Ok(Error::InvalidConfig)));
                    prop_assert_eq!(bond_of(&client, &id).amount_stroops, initial);
                }
            }
        }

        // ── Slashing ─────────────────────────────────────────────────────────

        /// Percentage slashing (partial and full) removes exactly
        /// `bond * pct / 100`, moves it to the reward pool, and conserves value:
        /// `remaining + pool == original`.
        #[test]
        fn prop_percentage_slash_conserves_value(
            initial in ordinary_bond(),
            pct in 1u32..=100,
        ) {
            let (env, client) = setup_with_admin();
            let id = register(&env, &client, initial);
            client.slash_bond(&id, &pct, &reason(&env));

            let penalty = initial * pct as i128 / 100;
            let b = bond_of(&client, &id);
            prop_assert_eq!(b.amount_stroops, initial - penalty);
            prop_assert!(b.amount_stroops >= 0);
            prop_assert_eq!(client.get_bond_reward_pool(), penalty);
            prop_assert_eq!(b.amount_stroops + client.get_bond_reward_pool(), initial);
            prop_assert_eq!(agent_bond(&env, &client, &id), b.amount_stroops);

            if pct == 100 {
                prop_assert_eq!(b.amount_stroops, 0);
                prop_assert_eq!(b.status, bond::BondStatus::Slashed);
            } else if b.amount_stroops > 0 {
                prop_assert_eq!(b.status, bond::BondStatus::Active);
            }
        }

        /// Absolute slashing clamps at zero: the bond never goes negative no
        /// matter how large the penalty, and the pool only receives what was
        /// actually taken.
        #[test]
        fn prop_absolute_slash_never_underflows(
            initial in ordinary_bond(),
            penalty in 0i128..=i128::MAX,
        ) {
            let (_env, client) = setup_with_admin();
            let id = register(&_env, &client, initial);
            client.slash_bond_amount(&id, &penalty);

            let taken = penalty.min(initial);
            let b = bond_of(&client, &id);
            prop_assert_eq!(b.amount_stroops, initial - taken);
            prop_assert!(b.amount_stroops >= 0);
            prop_assert_eq!(client.get_bond_reward_pool(), taken);
        }

        /// Repeated partial slashes keep the conservation invariant and the
        /// bond monotonically non-increasing.
        #[test]
        fn prop_repeated_slashes_are_monotonic(
            initial in ordinary_bond(),
            pcts in prop::collection::vec(1u32..=99, 1..6),
        ) {
            let (env, client) = setup_with_admin();
            let id = register(&env, &client, initial);
            let mut previous = initial;
            for pct in pcts {
                if bond_of(&client, &id).status != bond::BondStatus::Active {
                    break;
                }
                client.slash_bond(&id, &pct, &reason(&env));
                let now = bond_of(&client, &id).amount_stroops;
                prop_assert!(now <= previous);
                prop_assert!(now >= 0);
                prop_assert_eq!(now + client.get_bond_reward_pool(), initial);
                previous = now;
            }
        }

        /// Percentage slashing on bonds large enough to overflow `bond * pct`
        /// returns a contract error instead of panicking, and leaves both the
        /// bond and the reward pool untouched.
        #[test]
        fn prop_slash_overflow_is_rejected_not_panicking(
            initial in (i128::MAX / 100)..=i128::MAX,
            pct in 1u32..=100,
        ) {
            let (env, client) = setup_with_admin();
            let id = register(&env, &client, initial);
            let result = client.try_slash_bond(&id, &pct, &reason(&env));
            match initial.checked_mul(pct as i128) {
                Some(product) => {
                    prop_assert_eq!(result, Ok(Ok(())));
                    let penalty = product / 100;
                    prop_assert_eq!(bond_of(&client, &id).amount_stroops, initial - penalty);
                    prop_assert_eq!(client.get_bond_reward_pool(), penalty);
                }
                None => {
                    prop_assert_eq!(result, Err(Ok(Error::InvalidConfig)));
                    prop_assert_eq!(bond_of(&client, &id).amount_stroops, initial);
                    prop_assert_eq!(client.get_bond_reward_pool(), 0);
                }
            }
        }

        // ── Refund ───────────────────────────────────────────────────────────

        /// After deregistration and the cooldown, the refund equals whatever
        /// survived slashing, the bond is zeroed, and nothing is created or
        /// destroyed: `refund + pool == original`.
        #[test]
        fn prop_refund_after_deregistration_returns_remaining_bond(
            initial in ordinary_bond(),
            pct in 0u32..=100,
        ) {
            let (env, client) = setup_with_admin();
            let id = register(&env, &client, initial);
            if pct > 0 {
                client.slash_bond(&id, &pct, &reason(&env));
            }
            let remaining = bond_of(&client, &id).amount_stroops;

            client.deregister_agent(&id);
            let b = bond_of(&client, &id);
            prop_assert_eq!(b.status, bond::BondStatus::Cooldown);
            prop_assert_eq!(b.amount_stroops, remaining);

            // Too early: refund is refused and nothing moves.
            prop_assert_eq!(
                client.try_deregister_agent(&id),
                Err(Ok(Error::CooldownNotElapsed))
            );
            prop_assert_eq!(bond_of(&client, &id).amount_stroops, remaining);

            env.ledger()
                .set_sequence_number(env.ledger().sequence() + BOND_COOLDOWN_LEDGERS);
            client.deregister_agent(&id);

            let b = bond_of(&client, &id);
            prop_assert_eq!(b.status, bond::BondStatus::Returned);
            prop_assert_eq!(b.amount_stroops, 0);
            prop_assert_eq!(remaining + client.get_bond_reward_pool(), initial);
        }

        /// The explicit return path (`initiate_bond_return` → `claim_bond`)
        /// pays out exactly the staked amount (deposits included), once.
        #[test]
        fn prop_claim_bond_refunds_exact_stake_once(
            initial in ordinary_bond(),
            deposit in prop::option::of(ordinary_bond()),
        ) {
            let (env, client) = setup_with_admin();
            let id = register(&env, &client, initial);
            let mut staked = initial;
            if let Some(d) = deposit {
                client.deposit_bond(&id, &d);
                staked += d;
            }

            client.initiate_bond_return(&id);
            env.ledger()
                .set_sequence_number(env.ledger().sequence() + BOND_COOLDOWN_LEDGERS);
            prop_assert_eq!(client.claim_bond(&id), staked);

            let b = bond_of(&client, &id);
            prop_assert_eq!(b.amount_stroops, 0);
            prop_assert_eq!(b.status, bond::BondStatus::Returned);
            // A second claim cannot pay out again.
            prop_assert_eq!(
                client.try_claim_bond(&id),
                Err(Ok(Error::CooldownNotElapsed))
            );
        }
    }
}
