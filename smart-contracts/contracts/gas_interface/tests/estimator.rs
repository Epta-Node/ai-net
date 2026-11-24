//! `gas_interface` exposes a single public item, the `GasEstimator` trait.
//! These tests pin down the contract an implementor must honour by driving a
//! reference implementation purely through the trait.

use gas_interface::GasEstimator;
use soroban_sdk::{symbol_short, Env, IntoVal, Map, Symbol, Val};

const BASE_COST: u64 = 1_000;
const PER_ITEM_COST: u64 = 250;

/// Reference estimator: a fixed base plus a per-item cost for known
/// operations and `0` for unknown ones.
struct ReferenceEstimator;

impl GasEstimator for ReferenceEstimator {
    fn estimate(operation: Symbol, params: Map<Symbol, Val>) -> u64 {
        let env = params.env();
        let known =
            operation == Symbol::new(env, "create") || operation == Symbol::new(env, "query");
        if !known {
            return 0;
        }
        BASE_COST.saturating_add(PER_ITEM_COST.saturating_mul(u64::from(params.len())))
    }
}

fn params_with(env: &Env, count: u32) -> Map<Symbol, Val> {
    let mut params: Map<Symbol, Val> = Map::new(env);
    for i in 0..count {
        let key = Symbol::new(env, &std::format!("k{i}"));
        params.set(key, i.into_val(env));
    }
    params
}

#[test]
fn known_operation_returns_base_cost_for_empty_params() {
    let env = Env::default();
    let params = params_with(&env, 0);
    assert_eq!(
        ReferenceEstimator::estimate(symbol_short!("create"), params),
        BASE_COST
    );
}

#[test]
fn estimate_scales_with_param_count() {
    let env = Env::default();
    let one = ReferenceEstimator::estimate(symbol_short!("query"), params_with(&env, 1));
    let ten = ReferenceEstimator::estimate(symbol_short!("query"), params_with(&env, 10));
    assert_eq!(one, BASE_COST + PER_ITEM_COST);
    assert_eq!(ten, BASE_COST + 10 * PER_ITEM_COST);
}

#[test]
fn unknown_operation_estimates_zero() {
    let env = Env::default();
    let params = params_with(&env, 5);
    assert_eq!(
        ReferenceEstimator::estimate(symbol_short!("nope"), params),
        0
    );
}

#[test]
fn estimate_is_deterministic() {
    let env = Env::default();
    let first = ReferenceEstimator::estimate(symbol_short!("create"), params_with(&env, 7));
    let second = ReferenceEstimator::estimate(symbol_short!("create"), params_with(&env, 7));
    assert_eq!(first, second);
}

#[test]
fn estimate_is_monotonic_in_payload_size() {
    let env = Env::default();
    let mut previous = 0u64;
    for count in 0..=64u32 {
        let current =
            ReferenceEstimator::estimate(symbol_short!("create"), params_with(&env, count));
        assert!(
            current >= previous,
            "estimate decreased from {previous} to {current} at {count} items"
        );
        previous = current;
    }
}
