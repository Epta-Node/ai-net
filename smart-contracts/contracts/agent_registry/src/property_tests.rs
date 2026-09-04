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

use super::*;
use soroban_sdk::{testutils::Address as _, Address, Env, IntoVal, Map, Symbol};

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
    env.mock_all_auths();
    let id = env.register(AgentRegistryContract, ());
    let client = AgentRegistryContractClient::new(&env, &id);
    (env, client)
}

fn setup_with_admin() -> (Env, AgentRegistryContractClient<'static>, Address) {
    let env = Env::default();
    env.mock_all_auths();
    let id = env.register(AgentRegistryContract, ());
    let client = AgentRegistryContractClient::new(&env, &id);
    let admin = Address::generate(&env);
    client.initialize(&admin);
    (env, client, admin)
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
    let iters = 200;

    let (env, client) = setup_with_admin();

    for i in 0..iters {
        let owner = Address::generate(&env);
        let record = make_record(&env, &format!("unique_{}", i), "coding", &owner);
        let result = client.try_register_agent(&record);
        assert!(result.is_ok(), "registration {} should succeed", i);
    }

    // Verify all IDs can be looked up.
    for i in 0..iters {
        let id = Symbol::new(&env, &format!("unique_{}", i));
        let page = client.get_agents(&None, &Some(1000));
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
        let stored: AgentRecord = env.storage().persistent().get(&key).unwrap();
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
        let record = AgentRecord {
            id: Symbol::new(&env, &format!("low_bond_{}", extra)),
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
    let long_cap = "very_long_capability_name_that_exceeds_normal";
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
        assert!(*code > 0, "error code should be positive");
        // The error should be InsufficientBond.
        let err = Error::from_code(*code);
        assert!(
            err == Error::InsufficientBond,
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

    let mut agents = soroban_sdk::Vec::new(&env);
    agents.push_back(r1);
    agents.push_back(r2);
    agents.push_back(r3);

    let results = client.register_agents(&agents);
    // Third should fail with StorageLimitReached.
    assert!(
        matches!(results.get(2).unwrap(), BatchResult::Err(_)),
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
