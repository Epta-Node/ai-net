//! TTL extension and pagination-cursor tests for `task_store` (Issue #770).
//!
//! Every assertion uses controlled ledger time and asserts a page-size or
//! history bound, so an unbounded vector or a missing TTL bump fails the suite.

use soroban_sdk::{
    testutils::{storage::Persistent as _, Address as _, Ledger as _},
    Address, Bytes, BytesN, Env, Vec,
};
use task_store::{
    DataKey, TaskStatus, TaskStoreContract, TaskStoreContractClient, DEFAULT_TTL_DAYS,
    LEDGERS_PER_DAY, MAX_HISTORY_RECORDS, MAX_TASKS_PAGE_SIZE, MAX_TRACKED_TASKS_PER_CREATOR,
    MAX_TTL_DAYS,
};

const START_TIMESTAMP: u64 = 1_000_000;
const SECONDS_PER_DAY: u64 = 86_400;

struct Fixture {
    env: Env,
    client: TaskStoreContractClient<'static>,
    creator: Address,
}

fn setup() -> Fixture {
    let env = Env::default();
    env.mock_all_auths();
    env.ledger().set_timestamp(START_TIMESTAMP);
    env.ledger().set_sequence_number(100);
    let id = env.register(TaskStoreContract, ());
    let client = TaskStoreContractClient::new(&env, &id);
    client.initialize(&Address::generate(&env));
    let creator = Address::generate(&env);
    Fixture {
        env,
        client,
        creator,
    }
}

fn task_id(env: &Env, n: u32) -> BytesN<32> {
    let mut bytes = [0u8; 32];
    bytes[..4].copy_from_slice(&n.to_be_bytes());
    BytesN::from_array(env, &bytes)
}

fn store(f: &Fixture, n: u32, ttl_days: u32) -> BytesN<32> {
    let task = task_id(&f.env, n);
    let agents = Vec::from_array(&f.env, [Address::generate(&f.env)]);
    let dag = Bytes::from_slice(&f.env, &[1, 2, 3]);
    f.client.store_task_metadata(
        &f.creator,
        &task,
        &BytesN::from_array(&f.env, &[9; 32]),
        &agents,
        &dag,
        &ttl_days,
        &None,
    );
    task
}

fn ttl_of(f: &Fixture, key: DataKey) -> u32 {
    f.env.as_contract(&f.client.address, || {
        f.env.storage().persistent().get_ttl(&key)
    })
}

fn persistent_entries(f: &Fixture) -> u32 {
    f.env.as_contract(&f.client.address, || {
        f.env.storage().persistent().all().len()
    })
}

/// Keep the contract's own instance entry alive while a test advances the
/// ledger past a task's TTL. Without this the test contract itself is evicted
/// and every subsequent call fails with a host storage error.
fn extend_instance_ttl(f: &Fixture) {
    let max_ttl = f.env.storage().max_ttl();
    f.env.as_contract(&f.client.address, || {
        f.env.storage().instance().extend_ttl(max_ttl, max_ttl)
    });
}

// ─── TTL ─────────────────────────────────────────────────────────────────────

/// A one-day task is stored with exactly one day of rent and expires at the
/// matching timestamp. The auxiliary history/counter keys live at least as long
/// as the task record.
#[test]
fn create_task_with_explicit_ttl_bumps_rent_to_the_requested_window() {
    let f = setup();
    let task = store(&f, 1, 1);

    let metadata = f.client.get_task_metadata(&task);
    assert_eq!(metadata.created_at, START_TIMESTAMP);
    assert_eq!(metadata.expires_at, START_TIMESTAMP + SECONDS_PER_DAY);
    assert_eq!(ttl_of(&f, DataKey::Task(task.clone())), LEDGERS_PER_DAY);
    assert_eq!(
        ttl_of(&f, DataKey::TaskHistory(task.clone())),
        LEDGERS_PER_DAY
    );
}

/// `ttl_days = 0` uses the default; the maximum accepted value is clamped to
/// `MAX_TTL_DAYS`, and one day beyond it is rejected rather than silently
/// shortened.
#[test]
fn ttl_defaults_and_maximum_bound_are_enforced() {
    let f = setup();

    let defaulted = store(&f, 2, 0);
    let metadata = f.client.get_task_metadata(&defaulted);
    assert_eq!(
        metadata.expires_at,
        START_TIMESTAMP + u64::from(DEFAULT_TTL_DAYS) * SECONDS_PER_DAY
    );
    assert_eq!(
        ttl_of(&f, DataKey::Task(defaulted)),
        DEFAULT_TTL_DAYS * LEDGERS_PER_DAY
    );

    let maxed = store(&f, 3, MAX_TTL_DAYS);
    assert_eq!(
        ttl_of(&f, DataKey::Task(maxed)),
        MAX_TTL_DAYS * LEDGERS_PER_DAY
    );
    assert!(
        MAX_TTL_DAYS * LEDGERS_PER_DAY <= f.env.storage().max_ttl(),
        "MAX_TTL_DAYS must stay inside the host's maximum entry TTL"
    );

    let too_long = task_id(&f.env, 4);
    let agents = Vec::from_array(&f.env, [Address::generate(&f.env)]);
    let dag = Bytes::from_slice(&f.env, &[1, 2, 3]);
    let result = f.client.try_store_task_metadata(
        &f.creator,
        &too_long,
        &BytesN::from_array(&f.env, &[9; 32]),
        &agents,
        &dag,
        &(MAX_TTL_DAYS + 1),
        &None,
    );
    assert_eq!(result, Err(Ok(task_store::Error::InvalidTtl)));
    assert!(!f.env.as_contract(&f.client.address, || f
        .env
        .storage()
        .persistent()
        .has(&DataKey::Task(too_long))));
}

/// The timestamp gate and the ledger TTL gate both remove a task: a read past
/// `expires_at` returns `Expired`, and once the entry's ledger TTL lapses the
/// entry is gone.
#[test]
fn expired_tasks_are_rejected_and_pruned_after_their_ttl() {
    let f = setup();
    let task = store(&f, 5, 1);
    let expires_at = f.client.get_task_metadata(&task).expires_at;

    f.env.ledger().set_timestamp(expires_at - 1);
    assert!(f.client.try_get_task_metadata(&task).is_ok());

    f.env.ledger().set_timestamp(expires_at);
    assert_eq!(
        f.client.try_get_task_metadata(&task),
        Err(Ok(task_store::Error::Expired))
    );

    // Walk the ledger to the last live ledger and assert the rent is down to a
    // single ledger. The test host panics when contract code reads an archived
    // key (the network would not invoke a contract with archived entries), so
    // the boundary is asserted from the live side rather than by poking the
    // entry after it is archived.
    extend_instance_ttl(&f);
    let sequence = f.env.ledger().sequence();
    f.env
        .ledger()
        .set_sequence_number(sequence + LEDGERS_PER_DAY - 1);
    assert_eq!(ttl_of(&f, DataKey::Task(task.clone())), 1);
    assert_eq!(ttl_of(&f, DataKey::TaskHistory(task)), 1);
}

// ─── Pagination cursors ─────────────────────────────────────────────────────

fn create_lifecycle_tasks(f: &Fixture, count: u32) {
    for n in 0..count {
        f.client.create_task(
            &task_id(&f.env, 1_000 + n),
            &f.creator,
            &BytesN::from_array(&f.env, &[7; 32]),
            &1_000_000,
        );
    }
}

/// A page is bounded by `MAX_TASKS_PAGE_SIZE` even when the caller asks for
/// more, and the cursor advances by exactly the page size.
#[test]
fn oversized_limit_is_clamped_and_cursor_advances() {
    let f = setup();
    create_lifecycle_tasks(&f, MAX_TASKS_PAGE_SIZE + 5);

    let page = f
        .client
        .get_tasks_by_creator(&f.creator, &0, &(MAX_TASKS_PAGE_SIZE + 100));
    assert_eq!(page.task_ids.len(), MAX_TASKS_PAGE_SIZE);
    assert_eq!(page.total, MAX_TASKS_PAGE_SIZE + 5);
    assert_eq!(page.next_cursor, Some(MAX_TASKS_PAGE_SIZE));

    let rest = f
        .client
        .get_tasks_by_creator(&f.creator, &MAX_TASKS_PAGE_SIZE, &100);
    assert_eq!(rest.task_ids.len(), 5);
    assert_eq!(rest.next_cursor, None);
}

/// Walking the cursor returns every task exactly once, and no page exceeds the
/// requested limit.
#[test]
fn cursor_iteration_is_bounded_and_complete() {
    let f = setup();
    let total = MAX_TASKS_PAGE_SIZE * 2 + 3;
    create_lifecycle_tasks(&f, total);

    let mut seen = 0_u32;
    let mut cursor = 0_u32;
    loop {
        let page = f.client.get_tasks_by_creator(&f.creator, &cursor, &7);
        assert!(page.task_ids.len() <= 7, "page exceeded its limit");
        seen += page.task_ids.len();
        match page.next_cursor {
            Some(next) => {
                assert!(next > cursor, "cursor must advance");
                assert_eq!(next, cursor + page.task_ids.len());
                cursor = next;
            }
            None => break,
        }
    }
    assert_eq!(seen, total);
}

/// Out-of-range cursors return an empty terminal page instead of wrapping or
/// panicking, and `limit = 0` is a counting-only query.
#[test]
fn out_of_range_and_zero_limits_are_handled() {
    let f = setup();
    create_lifecycle_tasks(&f, 3);

    let past_end = f.client.get_tasks_by_creator(&f.creator, &99, &10);
    assert_eq!(past_end.task_ids.len(), 0);
    assert_eq!(past_end.total, 3);
    assert_eq!(past_end.next_cursor, None);

    let at_end = f.client.get_tasks_by_creator(&f.creator, &3, &10);
    assert_eq!(at_end.task_ids.len(), 0);
    assert_eq!(at_end.next_cursor, None);

    let counting = f.client.get_tasks_by_creator(&f.creator, &0, &0);
    assert_eq!(counting.task_ids.len(), 0);
    assert_eq!(counting.total, 3);
}

/// The creator index is capped with oldest-first eviction. A cursor beyond the
/// surviving window is empty, and the oldest ids are the ones that disappear.
#[test]
fn eviction_keeps_the_creator_index_bounded() {
    let f = setup();
    let overflow = 5;
    create_lifecycle_tasks(&f, MAX_TRACKED_TASKS_PER_CREATOR + overflow);

    let first = f
        .client
        .get_tasks_by_creator(&f.creator, &0, &MAX_TRACKED_TASKS_PER_CREATOR);
    assert_eq!(first.total, MAX_TRACKED_TASKS_PER_CREATOR);
    // A single page is still capped at MAX_TASKS_PAGE_SIZE.
    assert_eq!(first.task_ids.len(), MAX_TASKS_PAGE_SIZE);
    assert_eq!(first.next_cursor, Some(MAX_TASKS_PAGE_SIZE));

    // The first `overflow` created ids were evicted; the window starts at the
    // next one.
    assert_eq!(
        first.task_ids.get_unchecked(0),
        task_id(&f.env, 1_000 + overflow)
    );

    // Walk to the newest page and confirm the last surviving id.
    let mut cursor = 0_u32;
    loop {
        let page = f
            .client
            .get_tasks_by_creator(&f.creator, &cursor, &MAX_TASKS_PAGE_SIZE);
        assert!(page.task_ids.len() <= MAX_TASKS_PAGE_SIZE);
        match page.next_cursor {
            Some(next) => cursor = next,
            None => {
                assert_eq!(
                    page.task_ids.get_unchecked(page.task_ids.len() - 1),
                    task_id(&f.env, 1_000 + MAX_TRACKED_TASKS_PER_CREATOR + overflow - 1)
                );
                break;
            }
        }
    }

    let beyond_window =
        f.client
            .get_tasks_by_creator(&f.creator, &MAX_TRACKED_TASKS_PER_CREATOR, &10);
    assert_eq!(beyond_window.task_ids.len(), 0);
    assert_eq!(beyond_window.total, MAX_TRACKED_TASKS_PER_CREATOR);
}

/// The creator index carries the same retention as the task it points at, so a
/// cursor cannot outlive the records it addresses.
#[test]
fn index_ttl_matches_task_retention() {
    let f = setup();
    create_lifecycle_tasks(&f, 2);

    extend_instance_ttl(&f);
    let sequence = f.env.ledger().sequence();
    f.env
        .ledger()
        .set_sequence_number(sequence + DEFAULT_TTL_DAYS * LEDGERS_PER_DAY - 1);

    assert_eq!(ttl_of(&f, DataKey::CreatorTasks(f.creator.clone())), 1);
}

// ─── Bounded writes ─────────────────────────────────────────────────────────

/// Repeated status writes append to the history vector in place, but the state
/// machine plus `MAX_HISTORY_RECORDS` keep it bounded, and rejected updates do
/// not grow storage at all.
#[test]
fn repeated_writes_do_not_grow_storage_vectors() {
    let f = setup();
    let task = task_id(&f.env, 5_000);
    f.client.create_task(
        &task,
        &f.creator,
        &BytesN::from_array(&f.env, &[7; 32]),
        &1_000_000,
    );

    f.client
        .update_status(&task, &TaskStatus::Queued, &f.creator);
    f.client
        .update_status(&task, &TaskStatus::Assigned, &f.creator);
    f.client
        .update_status(&task, &TaskStatus::Running, &f.creator);
    f.client
        .update_status(&task, &TaskStatus::Completed, &f.creator);

    let history = f.client.get_history(&task);
    assert!(history.len() <= MAX_HISTORY_RECORDS);
    assert_eq!(history.len(), 5);
    assert_eq!(history.get_unchecked(4).status, TaskStatus::Completed);

    let entries_before = persistent_entries(&f);
    for _ in 0..20 {
        assert_eq!(
            f.client
                .try_update_status(&task, &TaskStatus::Running, &f.creator),
            Err(Ok(task_store::Error::InvalidStatusTransition))
        );
    }
    assert_eq!(persistent_entries(&f), entries_before);
    assert_eq!(f.client.get_history(&task).len(), 5);
}
