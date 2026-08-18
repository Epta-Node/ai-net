#![cfg(test)]

use super::*;
use soroban_sdk::{testutils::Ledger as _, BytesN, Env, Symbol};

/// Build a contract client with the ledger clock pinned to `start_ts`.
fn setup(start_ts: u64) -> (Env, ErrorRegistryContractClient<'static>) {
    let env = Env::default();
    env.ledger().set_timestamp(start_ts);
    let id = env.register(ErrorRegistryContract, ());
    let client = ErrorRegistryContractClient::new(&env, &id);
    (env, client)
}

/// Deterministic 32-byte id from a single seed byte.
fn id(env: &Env, seed: u8) -> BytesN<32> {
    BytesN::from_array(env, &[seed; 32])
}

fn sym(env: &Env, s: &str) -> Symbol {
    Symbol::new(env, s)
}

fn submit(
    client: &ErrorRegistryContractClient,
    env: &Env,
    seed: u8,
    code: u32,
    ttl: u64,
) -> BytesN<32> {
    let error_id = id(env, seed);
    client.submit_error(
        &error_id,
        &code,
        &sym(env, "boom"),
        &sym(env, "agent1"),
        &ttl,
    );
    error_id
}

// ---------------------------------------------------------------------------
// submit_error stores expires_at
// ---------------------------------------------------------------------------

#[test]
fn submit_error_stores_expires_at() {
    let (env, client) = setup(1_000);
    let error_id = submit(&client, &env, 1, 42, 3_600);

    let record = client.get_error(&error_id).unwrap();
    assert_eq!(record.error_code, 42);
    assert_eq!(record.created_at, 1_000);
    assert_eq!(record.expires_at, 1_000 + 3_600);
    assert_eq!(record.message, sym(&env, "boom"));
    assert_eq!(record.agent_id, sym(&env, "agent1"));
}

#[test]
fn submit_error_at_max_ttl_is_accepted() {
    let (env, client) = setup(500);
    let error_id = submit(&client, &env, 2, 7, MAX_TTL_SECONDS);

    let record = client.get_error(&error_id).unwrap();
    assert_eq!(record.expires_at, 500 + MAX_TTL_SECONDS);
}

#[test]
fn duplicate_submit_returns_already_exists() {
    let (env, client) = setup(0);
    let error_id = id(&env, 3);
    client.submit_error(&error_id, &1, &sym(&env, "m"), &sym(&env, "a"), &100);

    let res = client.try_submit_error(&error_id, &1, &sym(&env, "m"), &sym(&env, "a"), &100);
    assert_eq!(res, Err(Ok(Error::AlreadyExists)));
}

// ---------------------------------------------------------------------------
// TTL validation
// ---------------------------------------------------------------------------

#[test]
fn ttl_zero_is_rejected() {
    let (env, client) = setup(0);
    let error_id = id(&env, 4);
    let res = client.try_submit_error(&error_id, &1, &sym(&env, "m"), &sym(&env, "a"), &0);
    assert_eq!(res, Err(Ok(Error::InvalidTtl)));
    // Nothing should have been stored.
    assert!(client.get_error(&error_id).is_none());
}

#[test]
fn ttl_above_max_is_rejected() {
    let (env, client) = setup(0);
    let error_id = id(&env, 5);
    let res = client.try_submit_error(
        &error_id,
        &1,
        &sym(&env, "m"),
        &sym(&env, "a"),
        &(MAX_TTL_SECONDS + 1),
    );
    assert_eq!(res, Err(Ok(Error::InvalidTtl)));
    assert!(client.get_error(&error_id).is_none());
}

#[test]
fn ttl_overflow_is_rejected() {
    // created_at close to u64::MAX so that created_at + ttl overflows, while
    // ttl itself is still within the allowed range.
    let (env, client) = setup(u64::MAX - 10);
    let error_id = id(&env, 6);
    let res = client.try_submit_error(
        &error_id,
        &1,
        &sym(&env, "m"),
        &sym(&env, "a"),
        &100, // > 10, so (u64::MAX - 10) + 100 overflows
    );
    assert_eq!(res, Err(Ok(Error::TtlOverflow)));
    assert!(client.get_error(&error_id).is_none());
}

// ---------------------------------------------------------------------------
// Queries ignore expired records (without cleanup being called)
// ---------------------------------------------------------------------------

#[test]
fn get_error_hides_expired_record() {
    let (env, client) = setup(1_000);
    let error_id = submit(&client, &env, 7, 9, 100); // expires at 1_100

    // Still active before and at the boundary.
    assert!(client.get_error(&error_id).is_some());

    // Move past expiry — the record must read as absent.
    env.ledger().set_timestamp(1_101);
    assert!(client.get_error(&error_id).is_none());
}

#[test]
fn get_errors_by_code_skips_expired() {
    let (env, client) = setup(1_000);
    submit(&client, &env, 10, 55, 100); // expires 1_100
    submit(&client, &env, 11, 55, 10_000); // expires 11_000

    // Both active now.
    assert_eq!(client.get_errors_by_code(&55).len(), 2);

    // After first expires, only the long-lived one remains visible.
    env.ledger().set_timestamp(2_000);
    let active = client.get_errors_by_code(&55);
    assert_eq!(active.len(), 1);
    assert_eq!(active.get(0).unwrap().expires_at, 11_000);

    // count helper agrees with the filtered query.
    assert_eq!(client.count_active_by_code(&55), 1);
}

// ---------------------------------------------------------------------------
// Boundary condition: now == expires_at is active; now > expires_at expired
// ---------------------------------------------------------------------------

#[test]
fn boundary_timestamp_equals_expires_at_is_active() {
    let (env, client) = setup(1_000);
    let error_id = submit(&client, &env, 12, 1, 500); // expires_at == 1_500

    // Exactly at expiry: still active.
    env.ledger().set_timestamp(1_500);
    assert!(
        client.get_error(&error_id).is_some(),
        "record must be active when now == expires_at"
    );

    // One second later: expired.
    env.ledger().set_timestamp(1_501);
    assert!(
        client.get_error(&error_id).is_none(),
        "record must be expired when now > expires_at"
    );
}

#[test]
fn cleanup_respects_boundary() {
    let (env, client) = setup(1_000);
    submit(&client, &env, 13, 2, 500); // expires_at == 1_500

    // At exactly expires_at nothing is removed.
    env.ledger().set_timestamp(1_500);
    let stats = client.cleanup_expired_errors(&0);
    assert_eq!(stats.removed, 0);
    assert_eq!(stats.remaining, 1);

    // One tick past expiry it is removed.
    env.ledger().set_timestamp(1_501);
    let stats = client.cleanup_expired_errors(&0);
    assert_eq!(stats.removed, 1);
    assert_eq!(stats.remaining, 0);
}

// ---------------------------------------------------------------------------
// cleanup removes expired, keeps active
// ---------------------------------------------------------------------------

#[test]
fn cleanup_removes_expired_and_keeps_active() {
    let (env, client) = setup(1_000);
    let short_lived = submit(&client, &env, 20, 100, 100); // expires 1_100
    let long_lived = submit(&client, &env, 21, 100, 10_000); // expires 11_000

    env.ledger().set_timestamp(5_000);
    let stats = client.cleanup_expired_errors(&0);

    assert_eq!(stats.removed, 1);
    assert_eq!(stats.remaining, 1);
    // Expired one is gone from primary storage.
    assert!(client.get_error(&short_lived).is_none());
    // Active one is untouched.
    assert!(client.get_error(&long_lived).is_some());
}

#[test]
fn cleanup_with_no_expired_records_is_noop() {
    let (env, client) = setup(1_000);
    submit(&client, &env, 30, 1, 10_000);
    submit(&client, &env, 31, 1, 10_000);

    env.ledger().set_timestamp(2_000);
    let stats = client.cleanup_expired_errors(&0);
    assert_eq!(stats.removed, 0);
    assert_eq!(stats.remaining, 2);
}

// ---------------------------------------------------------------------------
// cleanup removes indexes (no dangling references)
// ---------------------------------------------------------------------------

#[test]
fn cleanup_removes_code_index_entry_when_emptied() {
    let (env, client) = setup(1_000);
    submit(&client, &env, 40, 777, 100); // only record for code 777

    env.ledger().set_timestamp(2_000);
    client.cleanup_expired_errors(&0);

    // The per-code index entry must be gone entirely, not left as an empty vec
    // pointing at a deleted record.
    env.as_contract(&client.address, || {
        assert!(!env.storage().persistent().has(&DataKey::CodeIndex(777)));
        // Enumeration index also emptied and removed.
        assert!(!env.storage().persistent().has(&DataKey::AllErrorIds));
    });

    // And querying by code returns nothing.
    assert_eq!(client.get_errors_by_code(&777).len(), 0);
}

#[test]
fn cleanup_keeps_code_index_for_surviving_records() {
    let (env, client) = setup(1_000);
    submit(&client, &env, 50, 900, 100); // expires 1_100
    let survivor = submit(&client, &env, 51, 900, 10_000); // expires 11_000

    env.ledger().set_timestamp(2_000);
    client.cleanup_expired_errors(&0);

    // Index for code 900 still present with exactly the survivor.
    let remaining = client.get_errors_by_code(&900);
    assert_eq!(remaining.len(), 1);
    assert_eq!(remaining.get(0).unwrap().expires_at, 11_000);
    assert!(client.get_error(&survivor).is_some());
}

// ---------------------------------------------------------------------------
// multiple expired + active records interleaved
// ---------------------------------------------------------------------------

#[test]
fn cleanup_multiple_mixed_records() {
    let (env, client) = setup(1_000);
    // Interleave codes and lifetimes.
    submit(&client, &env, 60, 1, 100); // expired
    submit(&client, &env, 61, 2, 50_000); // active
    submit(&client, &env, 62, 1, 100); // expired
    submit(&client, &env, 63, 2, 50_000); // active
    submit(&client, &env, 64, 3, 100); // expired

    env.ledger().set_timestamp(10_000);
    let stats = client.cleanup_expired_errors(&0);

    assert_eq!(stats.removed, 3);
    assert_eq!(stats.remaining, 2);

    // Code 1 fully drained, code 2 intact, code 3 fully drained.
    assert_eq!(client.count_active_by_code(&1), 0);
    assert_eq!(client.count_active_by_code(&2), 2);
    assert_eq!(client.count_active_by_code(&3), 0);
}

// ---------------------------------------------------------------------------
// Bounded cleanup / batching
// ---------------------------------------------------------------------------

#[test]
fn cleanup_is_bounded_by_max_batch() {
    let (env, client) = setup(1_000);
    // Five expired records under the same code.
    for seed in 70..75 {
        submit(&client, &env, seed, 5, 100);
    }
    env.ledger().set_timestamp(5_000);

    // Only remove two per call.
    let first = client.cleanup_expired_errors(&2);
    assert_eq!(first.removed, 2);
    assert_eq!(first.remaining, 3);

    let second = client.cleanup_expired_errors(&2);
    assert_eq!(second.removed, 2);
    assert_eq!(second.remaining, 1);

    let third = client.cleanup_expired_errors(&2);
    assert_eq!(third.removed, 1);
    assert_eq!(third.remaining, 0);

    // Index fully cleaned after draining.
    assert_eq!(client.count_active_by_code(&5), 0);
}

#[test]
fn cleanup_batch_is_capped_at_max() {
    let (env, client) = setup(1_000);
    submit(&client, &env, 80, 1, 100);
    env.ledger().set_timestamp(5_000);

    // Requesting a huge batch is clamped but still works correctly.
    let stats = client.cleanup_expired_errors(&u32::MAX);
    assert_eq!(stats.removed, 1);
    assert_eq!(stats.remaining, 0);
}

#[test]
fn active_records_do_not_consume_batch_budget() {
    let (env, client) = setup(1_000);
    // Active record first, then an expired one behind it.
    submit(&client, &env, 90, 1, 50_000); // active
    let expired = submit(&client, &env, 91, 1, 100); // expired

    env.ledger().set_timestamp(5_000);
    // Batch of 1: the active record must not consume the budget, so the expired
    // one behind it is still removed in this single pass.
    let stats = client.cleanup_expired_errors(&1);
    assert_eq!(stats.removed, 1);
    assert!(client.get_error(&expired).is_none());
    assert_eq!(client.count_active_by_code(&1), 1);
}

#[test]
fn cleanup_on_empty_registry_is_safe() {
    let (_env, client) = setup(1_000);
    let stats = client.cleanup_expired_errors(&0);
    assert_eq!(stats.scanned, 0);
    assert_eq!(stats.removed, 0);
    assert_eq!(stats.remaining, 0);
}
