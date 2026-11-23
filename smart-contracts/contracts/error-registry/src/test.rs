#![cfg(test)]

use super::*;
use soroban_sdk::{testutils::Address as _, testutils::Ledger as _, BytesN, Env, Symbol};

/// Build a contract client with the ledger clock pinned to `start_ts`.
fn setup(start_ts: u64) -> (Env, ErrorRegistryContractClient<'static>) {
    let env = Env::default();
    env.mock_all_auths();
    env.ledger().set_timestamp(start_ts);
    let id = env.register(ErrorRegistryContract, ());
    let client = ErrorRegistryContractClient::new(&env, &id);
    let admin = Address::generate(&env);
    client.initialize(&admin);
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

// ---------------------------------------------------------------------------
// Pause / unpause
// ---------------------------------------------------------------------------

#[test]
fn initialize_sets_admin_and_unpaused() {
    let (_env, client) = setup(1_000);
    assert!(client.get_admin().is_some());
    assert!(!client.is_paused());
}

#[test]
fn pause_blocks_submit_error() {
    let (env, client) = setup(1_000);
    client.pause();

    let error_id = id(&env, 100);
    let res = client.try_submit_error(&error_id, &1, &sym(&env, "m"), &sym(&env, "a"), &1_000);
    assert_eq!(res, Err(Ok(Error::ContractPaused)));
}

#[test]
fn unpause_allows_submit_error() {
    let (env, client) = setup(1_000);
    client.pause();
    client.unpause();

    let error_id = submit(&client, &env, 101, 42, 1_000);
    assert!(client.get_error(&error_id).is_some());
}

#[test]
fn get_error_still_works_when_paused() {
    let (env, client) = setup(1_000);
    let error_id = submit(&client, &env, 102, 42, 1_000);
    client.pause();

    // Reads should still work when paused.
    assert!(client.get_error(&error_id).is_some());
}

#[test]
fn cleanup_still_works_when_paused() {
    let (env, client) = setup(1_000);
    submit(&client, &env, 103, 1, 100); // expires 1_100

    client.pause();
    env.ledger().set_timestamp(2_000);

    // Cleanup is permissionless and should still work when paused.
    let stats = client.cleanup_expired_errors(&0);
    assert_eq!(stats.removed, 1);
}

#[test]
fn uninitialized_contract_returns_not_initialized() {
    let env = Env::default();
    env.mock_all_auths();
    let id = env.register(ErrorRegistryContract, ());
    let client = ErrorRegistryContractClient::new(&env, &id);

    let res = client.try_pause();
    assert_eq!(res, Err(Ok(Error::NotInitialized)));
}

#[test]
fn double_initialize_returns_already_initialized() {
    let (_, client) = setup(1_000);
    let admin = Address::generate(&client.env);
    let res = client.try_initialize(&admin);
    assert_eq!(res, Err(Ok(Error::AlreadyInitialized)));
}

// ---------------------------------------------------------------------------
// Error logging and retrieval unit tests (Issue #941)
// ---------------------------------------------------------------------------

#[test]
fn test_log_new_error() {
    let (env, client) = setup(1_000);
    let error_id = id(&env, 1);
    let error_code = 404;
    let message = sym(&env, "NotFound");
    let agent_id = sym(&env, "agent_alpha");
    let ttl = 3_600;

    // Log a new error
    client.submit_error(&error_id, &error_code, &message, &agent_id, &ttl);

    // Verify error retrieval by ID
    let record = client.get_error(&error_id).expect("error record should exist");
    assert_eq!(record.error_code, 404);
    assert_eq!(record.message, message);
    assert_eq!(record.agent_id, agent_id);
    assert_eq!(record.created_at, 1_000);
    assert_eq!(record.expires_at, 1_000 + 3_600);

    // Verify count is 1
    assert_eq!(client.count_active_by_code(&404), 1);
    let stats = client.get_error_stats();
    assert_eq!(stats.get(404).unwrap(), 1);
}

#[test]
fn test_log_duplicate_error_increment_count() {
    let (env, client) = setup(1_000);
    let code = 500;
    let agent = sym(&env, "worker_1");

    // Initial count is 0
    assert_eq!(client.count_active_by_code(&code), 0);

    // Log first error under code 500
    let id1 = id(&env, 10);
    client.submit_error(&id1, &code, &sym(&env, "ServerErr1"), &agent, &3_600);
    assert_eq!(client.count_active_by_code(&code), 1);
    assert_eq!(client.get_error_stats().get(code).unwrap(), 1);

    // Log second duplicate error under same code 500 (increments count)
    let id2 = id(&env, 11);
    client.submit_error(&id2, &code, &sym(&env, "ServerErr2"), &agent, &3_600);
    assert_eq!(client.count_active_by_code(&code), 2);
    assert_eq!(client.get_error_stats().get(code).unwrap(), 2);

    // Submitting with duplicate error ID fails with AlreadyExists
    let res = client.try_submit_error(&id1, &code, &sym(&env, "ServerErrDup"), &agent, &3_600);
    assert_eq!(res, Err(Ok(Error::AlreadyExists)));
    // Count remains unchanged after rejected duplicate ID
    assert_eq!(client.count_active_by_code(&code), 2);
}

#[test]
fn test_error_retrieval_by_code() {
    let (env, client) = setup(1_000);
    let code_a = 100;
    let code_b = 200;

    submit(&client, &env, 21, code_a, 5_000);
    submit(&client, &env, 22, code_a, 5_000);
    submit(&client, &env, 23, code_b, 5_000);

    let errors_a = client.get_errors_by_code(&code_a);
    assert_eq!(errors_a.len(), 2);
    for err in errors_a.iter() {
        assert_eq!(err.error_code, code_a);
    }

    let errors_b = client.get_errors_by_code(&code_b);
    assert_eq!(errors_b.len(), 1);
    assert_eq!(errors_b.get(0).unwrap().error_code, code_b);

    let errors_c = client.get_errors_by_code(&999);
    assert_eq!(errors_c.len(), 0);
}

#[test]
fn test_error_retrieval_by_agent() {
    let (env, client) = setup(1_000);
    let agent1 = sym(&env, "agent_1");
    let agent2 = sym(&env, "agent_2");

    let id1 = id(&env, 31);
    let id2 = id(&env, 32);
    let id3 = id(&env, 33);

    client.submit_error(&id1, &10, &sym(&env, "err1"), &agent1, &5_000);
    client.submit_error(&id2, &20, &sym(&env, "err2"), &agent1, &5_000);
    client.submit_error(&id3, &30, &sym(&env, "err3"), &agent2, &5_000);

    let list1 = client.get_errors_by_agent(&agent1);
    assert_eq!(list1.len(), 2);
    for e in list1.iter() {
        assert_eq!(e.agent_id, agent1);
    }

    let list2 = client.get_errors_by_agent(&agent2);
    assert_eq!(list2.len(), 1);
    assert_eq!(list2.get(0).unwrap().agent_id, agent2);

    let list_none = client.get_errors_by_agent(&sym(&env, "unknown_agent"));
    assert_eq!(list_none.len(), 0);
}

#[test]
fn get_errors_by_agent_filters_correctly() {
    let (env, client) = setup(1_000);

    let id1 = id(&env, 1);
    client.submit_error(&id1, &42, &sym(&env, "msg1"), &sym(&env, "agent_A"), &10_000);

    let id2 = id(&env, 2);
    client.submit_error(&id2, &42, &sym(&env, "msg2"), &sym(&env, "agent_B"), &10_000);

    let id3 = id(&env, 3);
    client.submit_error(&id3, &43, &sym(&env, "msg3"), &sym(&env, "agent_A"), &10_000);

    let agent_a_errors = client.get_errors_by_agent(&sym(&env, "agent_A"));
    assert_eq!(agent_a_errors.len(), 2);
    assert_eq!(agent_a_errors.get(0).unwrap().agent_id, sym(&env, "agent_A"));

    let agent_b_errors = client.get_errors_by_agent(&sym(&env, "agent_B"));
    assert_eq!(agent_b_errors.len(), 1);
    assert_eq!(agent_b_errors.get(0).unwrap().agent_id, sym(&env, "agent_B"));

    let empty_errors = client.get_errors_by_agent(&sym(&env, "agent_C"));
    assert_eq!(empty_errors.len(), 0);
}

#[test]
fn get_errors_by_agent_skips_expired() {
    let (env, client) = setup(1_000);

    let id1 = id(&env, 1);
    client.submit_error(&id1, &42, &sym(&env, "msg1"), &sym(&env, "agent_A"), &100);

    let id2 = id(&env, 2);
    client.submit_error(&id2, &42, &sym(&env, "msg2"), &sym(&env, "agent_A"), &10_000);

    env.ledger().set_timestamp(2_000);

    let errors = client.get_errors_by_agent(&sym(&env, "agent_A"));
    assert_eq!(errors.len(), 1);
    assert_eq!(errors.get(0).unwrap().expires_at, 11_000);
}

#[test]
fn get_error_stats_counts_active_correctly() {
    let (env, client) = setup(1_000);

    submit(&client, &env, 1, 100, 10_000);
    submit(&client, &env, 2, 100, 100);
    submit(&client, &env, 3, 200, 10_000);
    submit(&client, &env, 4, 300, 10_000);

    let stats = client.get_error_stats();
    assert_eq!(stats.get(100).unwrap(), 2);
    assert_eq!(stats.get(200).unwrap(), 1);
    assert_eq!(stats.get(300).unwrap(), 1);

    env.ledger().set_timestamp(2_000);

    let stats_after = client.get_error_stats();
    assert_eq!(stats_after.get(100).unwrap(), 1);
    assert_eq!(stats_after.get(200).unwrap(), 1);
    assert_eq!(stats_after.get(300).unwrap(), 1);
}
