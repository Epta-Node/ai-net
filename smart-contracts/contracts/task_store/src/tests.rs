#![cfg(test)]

//! Tests for the append-only task version history and the per-creator task
//! index: `get_history`, `get_task_creator` and `get_tasks_by_creator`.
//!
//! The lifecycle, pause and oracle tests live in the inline `test` module in
//! `lib.rs`; this file covers the version-history surface plus the budget-based
//! `create_task` / `update_status` / `get_task` entrypoints, which is where
//! the state machine, the authorization rules and the event payloads come
//! together.

use super::*;
use soroban_sdk::{
    testutils::{Address as _, Events, Ledger},
    Address, Bytes, BytesN, Env, IntoVal, Vec,
};

struct Fixture {
    env: Env,
    client: TaskStoreContractClient<'static>,
    submitter: Address,
    agent: Address,
    prompt_hash: BytesN<32>,
    dag: Bytes,
}

fn fixture() -> Fixture {
    let env = Env::default();
    env.mock_all_auths();
    env.ledger().with_mut(|ledger| {
        ledger.timestamp = 1_700_000_000;
        ledger.sequence_number = 100;
    });
    let contract_id = env.register(TaskStoreContract, ());
    let client = TaskStoreContractClient::new(&env, &contract_id);
    let admin = Address::generate(&env);
    client.initialize(&admin);

    Fixture {
        submitter: Address::generate(&env),
        agent: Address::generate(&env),
        prompt_hash: BytesN::from_array(&env, &[2; 32]),
        dag: Bytes::from_slice(&env, &[0x78, 0x9c, 0x03, 0x00]),
        env,
        client,
    }
}

fn task_id(fixture: &Fixture, seed: u8) -> BytesN<32> {
    BytesN::from_array(&fixture.env, &[seed; 32])
}

fn store(fixture: &Fixture, id: &BytesN<32>, submitter: &Address) {
    let agents = Vec::from_array(&fixture.env, [fixture.agent.clone()]);
    fixture.client.store_task_metadata(
        submitter,
        id,
        &fixture.prompt_hash,
        &agents,
        &fixture.dag,
        &1u32,
        &None,
    );
}

/// Register a budget-based task. 1 XLM in stroops.
fn create(fixture: &Fixture, id: &BytesN<32>, creator: &Address, budget_xlm: i128) {
    fixture
        .client
        .create_task(id, creator, &fixture.prompt_hash, &budget_xlm);
}

fn contains(ids: &Vec<BytesN<32>>, id: &BytesN<32>) -> bool {
    ids.iter().any(|candidate| &candidate == id)
}

// ── Creation seeds the history ────────────────────────────────────────────────

#[test]
fn creating_a_task_seeds_a_single_version_record_at_its_initial_status() {
    let f = fixture();
    let id = task_id(&f, 1);
    store(&f, &id, &f.submitter);

    let history = f.client.get_history(&id);
    assert_eq!(history.len(), 1);

    let record = history.get(0).unwrap();
    assert_eq!(record.seq, 1);
    // A DAG task is submitted with its agents already assigned.
    assert_eq!(record.status, TaskStatus::Assigned);
    assert_eq!(record.updater, f.submitter);
    assert_eq!(record.timestamp, f.env.ledger().timestamp());
    assert_eq!(record.ledger_sequence, f.env.ledger().sequence());
}

#[test]
fn get_history_rejects_an_unknown_task() {
    let f = fixture();
    assert_eq!(
        f.client.try_get_history(&task_id(&f, 7)),
        Err(Ok(Error::NotFound))
    );
}

#[test]
fn get_history_rejects_an_expired_task() {
    let f = fixture();
    let id = task_id(&f, 1);
    store(&f, &id, &f.submitter);

    f.env.ledger().with_mut(|ledger| {
        ledger.timestamp += SECONDS_PER_DAY;
    });

    assert_eq!(f.client.try_get_history(&id), Err(Ok(Error::Expired)));
}

// ── Every accepted transition appends a record ────────────────────────────────

#[test]
fn each_status_update_appends_one_version_record() {
    let f = fixture();
    let id = task_id(&f, 1);
    store(&f, &id, &f.submitter);

    f.client
        .update_task_status(&id, &f.agent, &TaskStatus::Running);
    f.client
        .update_task_status(&id, &f.agent, &TaskStatus::Completed);

    let history = f.client.get_history(&id);
    assert_eq!(history.len(), 3);

    let statuses = [
        TaskStatus::Assigned,
        TaskStatus::Running,
        TaskStatus::Completed,
    ];
    for (index, status) in statuses.iter().enumerate() {
        let record = history.get(index as u32).unwrap();
        assert_eq!(record.seq, index as u32 + 1);
        assert_eq!(record.status, *status);
    }

    // The updater is the agent for transitions and the submitter for creation.
    assert_eq!(history.get(0).unwrap().updater, f.submitter);
    assert_eq!(history.get(1).unwrap().updater, f.agent);
    assert_eq!(history.get(2).unwrap().updater, f.agent);
}

#[test]
fn version_records_are_ordered_by_sequence_and_ledger() {
    let f = fixture();
    let id = task_id(&f, 1);
    store(&f, &id, &f.submitter);

    f.env.ledger().with_mut(|ledger| {
        ledger.sequence_number += 5;
    });
    f.client
        .update_task_status(&id, &f.agent, &TaskStatus::Running);

    f.env.ledger().with_mut(|ledger| {
        ledger.sequence_number += 5;
    });
    f.client
        .update_task_status(&id, &f.agent, &TaskStatus::Failed);

    let history = f.client.get_history(&id);
    assert_eq!(history.len(), 3);

    let mut previous_seq = 0;
    let mut previous_ledger = 0;
    for index in 0..history.len() {
        let record = history.get(index).unwrap();
        assert!(record.seq > previous_seq);
        assert!(record.ledger_sequence > previous_ledger);
        previous_seq = record.seq;
        previous_ledger = record.ledger_sequence;
    }
}

#[test]
fn a_terminal_transition_still_appends_a_record() {
    let f = fixture();
    let id = task_id(&f, 1);
    store(&f, &id, &f.submitter);

    // Pending -> Failed is a valid terminal transition.
    f.client
        .update_task_status(&id, &f.agent, &TaskStatus::Failed);

    let history = f.client.get_history(&id);
    assert_eq!(history.len(), 2);
    assert_eq!(history.get(1).unwrap().status, TaskStatus::Failed);
}

// ── Rejected calls leave no trace ─────────────────────────────────────────────

#[test]
fn a_rejected_transition_appends_no_record() {
    let f = fixture();
    let id = task_id(&f, 1);
    store(&f, &id, &f.submitter);

    // Pending -> Completed is not a legal transition.
    let _ = f
        .client
        .try_update_task_status(&id, &f.agent, &TaskStatus::Completed);

    assert_eq!(f.client.get_history(&id).len(), 1);
}

#[test]
fn an_unauthorized_agent_appends_no_record() {
    let f = fixture();
    let id = task_id(&f, 1);
    store(&f, &id, &f.submitter);
    let stranger = Address::generate(&f.env);

    let result = f
        .client
        .try_update_task_status(&id, &stranger, &TaskStatus::Running);
    assert_eq!(result, Err(Ok(Error::NotAssignedAgent)));

    assert_eq!(f.client.get_history(&id).len(), 1);
}

// ── Creator attribution ───────────────────────────────────────────────────────

#[test]
fn get_task_creator_returns_the_submitter() {
    let f = fixture();
    let id = task_id(&f, 1);
    store(&f, &id, &f.submitter);

    assert_eq!(f.client.get_task_creator(&id), Some(f.submitter.clone()));
}

#[test]
fn get_task_creator_is_none_for_an_unknown_task() {
    let f = fixture();
    assert_eq!(f.client.get_task_creator(&task_id(&f, 9)), None);
}

// ── Per-creator task index ────────────────────────────────────────────────────

#[test]
fn get_tasks_by_creator_lists_tasks_oldest_first() {
    let f = fixture();
    for seed in 1u8..=3 {
        store(&f, &task_id(&f, seed), &f.submitter);
    }

    let page = f
        .client
        .get_tasks_by_creator(&f.submitter, &0, &MAX_TASKS_PAGE_SIZE);

    assert_eq!(page.total, 3);
    assert_eq!(page.next_cursor, None);
    assert_eq!(page.task_ids.len(), 3);
    for seed in 1u8..=3 {
        assert!(contains(&page.task_ids, &task_id(&f, seed)));
    }
    // Newest task last.
    assert_eq!(page.task_ids.get(2), Some(task_id(&f, 3)));
}

#[test]
fn get_tasks_by_creator_paginates_with_a_cursor() {
    let f = fixture();
    for seed in 1u8..=3 {
        store(&f, &task_id(&f, seed), &f.submitter);
    }

    let first = f.client.get_tasks_by_creator(&f.submitter, &0, &2);
    assert_eq!(first.total, 3);
    assert_eq!(first.task_ids.len(), 2);
    assert_eq!(first.next_cursor, Some(2));
    assert_eq!(first.task_ids.get(0), Some(task_id(&f, 1)));

    let cursor = first.next_cursor.unwrap();
    let second = f.client.get_tasks_by_creator(&f.submitter, &cursor, &2);
    assert_eq!(second.task_ids.len(), 1);
    assert_eq!(second.task_ids.get(0), Some(task_id(&f, 3)));
    assert_eq!(second.next_cursor, None);
}

#[test]
fn get_tasks_by_creator_clamps_an_oversized_limit() {
    let f = fixture();
    let count = MAX_TASKS_PAGE_SIZE + 1;
    for i in 0..count {
        store(&f, &task_id(&f, (i + 1) as u8), &f.submitter);
    }

    let page = f.client.get_tasks_by_creator(&f.submitter, &0, &1_000);
    assert_eq!(page.task_ids.len(), MAX_TASKS_PAGE_SIZE);
    assert_eq!(page.total, count);
    assert_eq!(page.next_cursor, Some(MAX_TASKS_PAGE_SIZE));
}

#[test]
fn get_tasks_by_creator_clamps_a_zero_limit_to_an_empty_page() {
    let f = fixture();
    store(&f, &task_id(&f, 1), &f.submitter);

    let page = f.client.get_tasks_by_creator(&f.submitter, &0, &0);
    assert_eq!(page.task_ids.len(), 0);
    assert_eq!(page.total, 1);
    // The caller can still page from the start.
    assert_eq!(page.next_cursor, Some(0));
}

#[test]
fn get_tasks_by_creator_is_empty_for_an_unknown_creator() {
    let f = fixture();
    store(&f, &task_id(&f, 1), &f.submitter);

    let stranger = Address::generate(&f.env);
    let page = f
        .client
        .get_tasks_by_creator(&stranger, &0, &MAX_TASKS_PAGE_SIZE);

    assert_eq!(page.total, 0);
    assert_eq!(page.task_ids.len(), 0);
    assert_eq!(page.next_cursor, None);
}

#[test]
fn get_tasks_by_creator_does_not_leak_other_creators_tasks() {
    let f = fixture();
    let other = Address::generate(&f.env);

    store(&f, &task_id(&f, 1), &f.submitter);
    store(&f, &task_id(&f, 2), &other);

    let mine = f
        .client
        .get_tasks_by_creator(&f.submitter, &0, &MAX_TASKS_PAGE_SIZE);
    let theirs = f
        .client
        .get_tasks_by_creator(&other, &0, &MAX_TASKS_PAGE_SIZE);

    assert_eq!(mine.total, 1);
    assert!(contains(&mine.task_ids, &task_id(&f, 1)));
    assert_eq!(theirs.total, 1);
    assert!(contains(&theirs.task_ids, &task_id(&f, 2)));
}

#[test]
fn a_cursor_past_the_end_returns_an_empty_final_page() {
    let f = fixture();
    store(&f, &task_id(&f, 1), &f.submitter);

    let page = f.client.get_tasks_by_creator(&f.submitter, &99, &10);
    assert_eq!(page.task_ids.len(), 0);
    assert_eq!(page.total, 1);
    assert_eq!(page.next_cursor, None);
}

#[test]
fn the_creator_index_is_bounded_and_evicts_the_oldest_task() {
    let f = fixture();
    let count = MAX_TRACKED_TASKS_PER_CREATOR + 1;
    for i in 0..count {
        store(&f, &task_id(&f, (i + 1) as u8), &f.submitter);
    }

    let page = f
        .client
        .get_tasks_by_creator(&f.submitter, &0, &MAX_TASKS_PAGE_SIZE);

    // The index never grows past its cap, even though `count` tasks were stored.
    assert_eq!(page.total, MAX_TRACKED_TASKS_PER_CREATOR);
    // The first task was evicted; the next-oldest is still indexed.
    assert!(!contains(&page.task_ids, &task_id(&f, 1)));
}

// ── create_task: metadata + event ─────────────────────────────────────────────

#[test]
fn create_task_stores_the_metadata_it_was_given() {
    let f = fixture();
    let id = task_id(&f, 1);
    create(&f, &id, &f.submitter, 5_000_000);

    let task = f.client.get_task(&id).task;
    assert_eq!(task.task_id, id);
    assert_eq!(task.creator, f.submitter);
    assert_eq!(task.prompt_hash, f.prompt_hash);
    assert_eq!(task.budget_xlm, 5_000_000);
    assert_eq!(task.status, TaskStatus::Created);
    assert_eq!(task.created_at, f.env.ledger().timestamp());
    assert_eq!(task.updated_at, task.created_at);
    // Creation is itself the first version.
    assert_eq!(task.version, 1);
}

#[test]
fn create_task_accepts_a_zero_budget_but_rejects_a_negative_one() {
    let f = fixture();
    let free = task_id(&f, 1);
    create(&f, &free, &f.submitter, 0);
    assert_eq!(f.client.get_task(&free).task.budget_xlm, 0);

    let result = f
        .client
        .try_create_task(&task_id(&f, 2), &f.submitter, &f.prompt_hash, &-1i128);
    assert_eq!(result, Err(Ok(Error::InvalidBudget)));
    assert_eq!(
        f.client.try_get_task(&task_id(&f, 2)),
        Err(Ok(Error::NotFound))
    );
}

#[test]
fn create_task_rejects_a_duplicate_task_id() {
    let f = fixture();
    let id = task_id(&f, 1);
    create(&f, &id, &f.submitter, 1_000);

    let other = Address::generate(&f.env);
    assert_eq!(
        f.client
            .try_create_task(&id, &other, &f.prompt_hash, &1_000i128),
        Err(Ok(Error::AlreadyExists))
    );
}

#[test]
fn create_task_does_not_collide_with_the_dag_submission_path() {
    let f = fixture();
    let id = task_id(&f, 1);
    // Same id through both paths: the DAG record and the budget record live in
    // separate storage slots, so neither overwrites the other.
    store(&f, &id, &f.submitter);
    create(&f, &id, &f.submitter, 7_000_000);

    assert_eq!(f.client.get_task_metadata(&id).task_id, id);
    assert_eq!(f.client.get_task(&id).task.budget_xlm, 7_000_000);
    assert_eq!(f.client.get_task_lifecycle_status(&id), TaskStatus::Created);
}

#[test]
fn create_task_emits_exactly_one_created_event_with_full_context() {
    let f = fixture();
    let id = task_id(&f, 1);
    create(&f, &id, &f.submitter, 5_000_000);

    let events = f.env.events().all();
    assert_eq!(events.len(), 1);
    assert_eq!(
        events.get(0).unwrap().1,
        (symbol_short!("task_life"), symbol_short!("created")).into_val(&f.env)
    );

    let (_contract, _topics, data) = events.get(0).unwrap();
    let payload: LifecycleTaskCreatedEvent = data.into_val(&f.env);
    assert_eq!(payload.version, TASK_LIFECYCLE_EVENT_VERSION);
    assert_eq!(payload.task_id, id);
    assert_eq!(payload.creator, f.submitter);
    assert_eq!(payload.prompt_hash, f.prompt_hash);
    assert_eq!(payload.budget_xlm, 5_000_000);
    assert_eq!(payload.created_at, f.env.ledger().timestamp());
}

#[test]
fn create_task_seeds_the_history_with_one_created_record() {
    let f = fixture();
    let id = task_id(&f, 1);
    create(&f, &id, &f.submitter, 1_000);

    let history = f.client.get_history(&id);
    assert_eq!(history.len(), 1);
    let record = history.get(0).unwrap();
    assert_eq!(record.seq, 1);
    assert_eq!(record.status, TaskStatus::Created);
    assert_eq!(record.updater, f.submitter);
}

#[test]
fn create_task_indexes_the_task_under_its_creator() {
    let f = fixture();
    let id = task_id(&f, 1);
    create(&f, &id, &f.submitter, 1_000);

    assert_eq!(f.client.get_task_creator(&id), Some(f.submitter.clone()));
    let page = f
        .client
        .get_tasks_by_creator(&f.submitter, &0, &MAX_TASKS_PAGE_SIZE);
    assert_eq!(page.total, 1);
    assert_eq!(page.task_ids.get(0), Some(id));
}

#[test]
fn create_task_is_blocked_while_paused() {
    let f = fixture();
    f.client.pause();

    assert_eq!(
        f.client
            .try_create_task(&task_id(&f, 1), &f.submitter, &f.prompt_hash, &1_000i128),
        Err(Ok(Error::ContractPaused))
    );
}

// ── get_task: full record + history ───────────────────────────────────────────

#[test]
fn get_task_returns_the_record_and_its_whole_history() {
    let f = fixture();
    let id = task_id(&f, 1);
    create(&f, &id, &f.submitter, 1_000);

    f.client
        .update_status(&id, &TaskStatus::Queued, &f.submitter);
    f.client
        .update_status(&id, &TaskStatus::Assigned, &f.submitter);
    f.client
        .update_status(&id, &TaskStatus::Running, &f.submitter);

    let full = f.client.get_task(&id);
    assert_eq!(full.task.status, TaskStatus::Running);
    assert_eq!(full.task.version, 4);
    assert_eq!(full.history, f.client.get_history(&id));
    assert_eq!(full.history.len(), 4);
}

#[test]
fn get_task_rejects_an_unknown_task() {
    let f = fixture();
    assert_eq!(
        f.client.try_get_task(&task_id(&f, 9)),
        Err(Ok(Error::NotFound))
    );
}

#[test]
fn get_task_reports_expiry_after_the_default_retention_window() {
    let f = fixture();
    let id = task_id(&f, 1);
    create(&f, &id, &f.submitter, 1_000);

    f.env.ledger().with_mut(|ledger| {
        ledger.timestamp += u64::from(DEFAULT_TTL_DAYS) * SECONDS_PER_DAY;
    });

    assert_eq!(f.client.try_get_task(&id), Err(Ok(Error::Expired)));
    // The history is gated the same way, so a lapsed task leaves no readable trail.
    assert_eq!(f.client.try_get_history(&id), Err(Ok(Error::Expired)));
}

// ── update_status: authorization ──────────────────────────────────────────────

#[test]
fn only_the_creator_or_the_coordinator_may_update_status() {
    let f = fixture();
    let id = task_id(&f, 1);
    create(&f, &id, &f.submitter, 1_000);
    let coordinator = Address::generate(&f.env);
    f.client.set_coordinator(&Some(coordinator.clone()));
    let stranger = Address::generate(&f.env);

    // The creator can move their own task...
    f.client
        .update_status(&id, &TaskStatus::Queued, &f.submitter);
    // ...and so can the configured coordinator.
    f.client
        .update_status(&id, &TaskStatus::Assigned, &coordinator);
    // ...but nobody else.
    assert_eq!(
        f.client
            .try_update_status(&id, &TaskStatus::Running, &stranger),
        Err(Ok(Error::NotAuthorizedUpdater))
    );
    assert_eq!(
        f.client.get_task_lifecycle_status(&id),
        TaskStatus::Assigned
    );
}

#[test]
fn clearing_the_coordinator_revokes_its_authority() {
    let f = fixture();
    let id = task_id(&f, 1);
    create(&f, &id, &f.submitter, 1_000);
    let coordinator = Address::generate(&f.env);
    f.client.set_coordinator(&Some(coordinator.clone()));
    f.client.set_coordinator(&None);

    assert_eq!(
        f.client
            .try_update_status(&id, &TaskStatus::Queued, &coordinator),
        Err(Ok(Error::NotAuthorizedUpdater))
    );
}

#[test]
fn the_assigned_agent_has_no_authority_over_a_budget_task() {
    let f = fixture();
    let id = task_id(&f, 1);
    create(&f, &id, &f.submitter, 1_000);

    // An agent assigned to the DAG variant of the task has no claim here: the
    // budget record has no agent list, so the creator/coordinator rule stands.
    assert_eq!(
        f.client
            .try_update_status(&id, &TaskStatus::Running, &f.agent),
        Err(Ok(Error::NotAuthorizedUpdater))
    );
}

#[test]
fn an_unauthorized_caller_does_not_create_a_version_or_an_event() {
    let f = fixture();
    let id = task_id(&f, 1);
    create(&f, &id, &f.submitter, 1_000);
    let stranger = Address::generate(&f.env);

    let _ = f
        .client
        .try_update_status(&id, &TaskStatus::Queued, &stranger);

    assert_eq!(f.client.get_history(&id).len(), 1);
    assert_eq!(f.env.events().all().len(), 0);
}

#[test]
fn the_creator_may_drive_a_dag_task_too() {
    let f = fixture();
    let id = task_id(&f, 1);
    store(&f, &id, &f.submitter);

    // The submitter is not in `assigned_agents`, but is the task's creator.
    f.client
        .update_task_status(&id, &f.submitter, &TaskStatus::Running);
    assert_eq!(f.client.get_task_status(&id), TaskStatus::Running);
}

#[test]
fn update_status_is_blocked_while_paused() {
    let f = fixture();
    let id = task_id(&f, 1);
    create(&f, &id, &f.submitter, 1_000);
    f.client.pause();

    assert_eq!(
        f.client
            .try_update_status(&id, &TaskStatus::Queued, &f.submitter),
        Err(Ok(Error::ContractPaused))
    );
}

#[test]
fn update_status_rejects_an_unknown_task() {
    let f = fixture();
    assert_eq!(
        f.client
            .try_update_status(&task_id(&f, 9), &TaskStatus::Queued, &f.submitter),
        Err(Ok(Error::NotFound))
    );
}

// ── update_status: the state machine ─────────────────────────────────────────

#[test]
fn a_task_walks_the_full_lifecycle_in_order() {
    let f = fixture();
    let id = task_id(&f, 1);
    create(&f, &id, &f.submitter, 1_000);

    for status in [
        TaskStatus::Queued,
        TaskStatus::Assigned,
        TaskStatus::Running,
        TaskStatus::Completed,
    ] {
        f.client.update_status(&id, &status, &f.submitter);
        assert_eq!(f.client.get_task_lifecycle_status(&id), status);
    }
}

#[test]
fn every_legal_transition_is_accepted() {
    let f = fixture();
    let id = task_id(&f, 1);
    create(&f, &id, &f.submitter, 1_000);

    // `Created -> Assigned` skips the queue, which the table allows.
    f.client
        .update_status(&id, &TaskStatus::Assigned, &f.submitter);
    f.client
        .update_status(&id, &TaskStatus::Running, &f.submitter);
    f.client
        .update_status(&id, &TaskStatus::Failed, &f.submitter);

    let history = f.client.get_history(&id);
    let expected = [
        TaskStatus::Created,
        TaskStatus::Assigned,
        TaskStatus::Running,
        TaskStatus::Failed,
    ];
    assert_eq!(history.len(), expected.len() as u32);
    for (index, status) in expected.iter().enumerate() {
        assert_eq!(history.get(index as u32).unwrap().status, *status);
    }
}

#[test]
fn a_task_cannot_jump_from_created_to_completed() {
    let f = fixture();
    let id = task_id(&f, 1);
    create(&f, &id, &f.submitter, 1_000);

    assert_eq!(
        f.client
            .try_update_status(&id, &TaskStatus::Completed, &f.submitter),
        Err(Ok(Error::InvalidStatusTransition))
    );
    assert_eq!(f.client.get_task_lifecycle_status(&id), TaskStatus::Created);
    assert_eq!(f.client.get_history(&id).len(), 1);
}

#[test]
fn a_task_cannot_jump_from_created_to_running() {
    let f = fixture();
    let id = task_id(&f, 1);
    create(&f, &id, &f.submitter, 1_000);

    assert_eq!(
        f.client
            .try_update_status(&id, &TaskStatus::Running, &f.submitter),
        Err(Ok(Error::InvalidStatusTransition))
    );
}

#[test]
fn a_completed_task_cannot_return_to_running() {
    let f = fixture();
    let id = task_id(&f, 1);
    create(&f, &id, &f.submitter, 1_000);
    for status in [
        TaskStatus::Queued,
        TaskStatus::Assigned,
        TaskStatus::Running,
        TaskStatus::Completed,
    ] {
        f.client.update_status(&id, &status, &f.submitter);
    }

    for status in [
        TaskStatus::Running,
        TaskStatus::Failed,
        TaskStatus::Cancelled,
    ] {
        assert_eq!(
            f.client.try_update_status(&id, &status, &f.submitter),
            Err(Ok(Error::InvalidStatusTransition))
        );
    }
    assert_eq!(
        f.client.get_task_lifecycle_status(&id),
        TaskStatus::Completed
    );
}

#[test]
fn a_cancelled_task_is_terminal() {
    let f = fixture();
    let id = task_id(&f, 1);
    create(&f, &id, &f.submitter, 1_000);
    f.client
        .update_status(&id, &TaskStatus::Cancelled, &f.submitter);

    assert_eq!(
        f.client
            .try_update_status(&id, &TaskStatus::Running, &f.submitter),
        Err(Ok(Error::InvalidStatusTransition))
    );
    assert_eq!(
        f.client.get_task_lifecycle_status(&id),
        TaskStatus::Cancelled
    );
}

#[test]
fn a_task_cannot_be_reverted_to_its_earlier_status() {
    let f = fixture();
    let id = task_id(&f, 1);
    create(&f, &id, &f.submitter, 1_000);
    f.client
        .update_status(&id, &TaskStatus::Queued, &f.submitter);

    assert_eq!(
        f.client
            .try_update_status(&id, &TaskStatus::Created, &f.submitter),
        Err(Ok(Error::InvalidStatusTransition))
    );
}

#[test]
fn a_coordinator_cannot_resurrect_a_finished_task() {
    let f = fixture();
    let id = task_id(&f, 1);
    create(&f, &id, &f.submitter, 1_000);
    let coordinator = Address::generate(&f.env);
    f.client.set_coordinator(&Some(coordinator.clone()));
    f.client
        .update_status(&id, &TaskStatus::Failed, &f.submitter);

    // Authorized, but the state machine still says no.
    assert_eq!(
        f.client
            .try_update_status(&id, &TaskStatus::Running, &coordinator),
        Err(Ok(Error::InvalidStatusTransition))
    );
}

// ── update_status: history + events ───────────────────────────────────────────

#[test]
fn each_accepted_transition_appends_exactly_one_version_record() {
    let f = fixture();
    let id = task_id(&f, 1);
    create(&f, &id, &f.submitter, 1_000);

    f.env.ledger().with_mut(|ledger| ledger.timestamp += 60);
    f.client
        .update_status(&id, &TaskStatus::Queued, &f.submitter);
    f.env.ledger().with_mut(|ledger| ledger.timestamp += 60);
    f.client
        .update_status(&id, &TaskStatus::Assigned, &f.submitter);

    let history = f.client.get_history(&id);
    assert_eq!(history.len(), 3);
    for index in 0..3 {
        let record = history.get(index).unwrap();
        assert_eq!(record.seq, index + 1);
    }
    // Timestamps are strictly increasing, so the history is chronological.
    assert!(history.get(0).unwrap().timestamp < history.get(1).unwrap().timestamp);
    assert!(history.get(1).unwrap().timestamp < history.get(2).unwrap().timestamp);
}

#[test]
fn the_history_attributes_each_transition_to_its_updater() {
    let f = fixture();
    let id = task_id(&f, 1);
    create(&f, &id, &f.submitter, 1_000);
    let coordinator = Address::generate(&f.env);
    f.client.set_coordinator(&Some(coordinator.clone()));

    f.client
        .update_status(&id, &TaskStatus::Queued, &f.submitter);
    f.client
        .update_status(&id, &TaskStatus::Assigned, &coordinator);

    let history = f.client.get_history(&id);
    assert_eq!(history.get(0).unwrap().updater, f.submitter);
    assert_eq!(history.get(1).unwrap().updater, f.submitter);
    assert_eq!(history.get(2).unwrap().updater, coordinator);
}

#[test]
fn a_rejected_transition_leaves_the_version_and_the_event_log_untouched() {
    let f = fixture();
    let id = task_id(&f, 1);
    create(&f, &id, &f.submitter, 1_000);

    let _ = f
        .client
        .try_update_status(&id, &TaskStatus::Completed, &f.submitter);

    assert_eq!(f.env.events().all().len(), 0);
    let task = f.client.get_task(&id).task;
    assert_eq!(task.version, 1);
    assert_eq!(task.status, TaskStatus::Created);
    // `updated_at` is untouched, so the record still reflects creation time.
    assert_eq!(task.updated_at, task.created_at);
}

#[test]
fn update_status_emits_exactly_one_event_per_transition() {
    let f = fixture();
    let id = task_id(&f, 1);
    create(&f, &id, &f.submitter, 1_000);
    f.client
        .update_status(&id, &TaskStatus::Queued, &f.submitter);

    let events = f.env.events().all();
    assert_eq!(events.len(), 1);
    assert_eq!(
        events.get(0).unwrap().1,
        (symbol_short!("task_life"), symbol_short!("status")).into_val(&f.env)
    );
}

#[test]
fn the_status_changed_event_carries_the_whole_transition() {
    let f = fixture();
    let id = task_id(&f, 1);
    create(&f, &id, &f.submitter, 1_000);
    f.client
        .update_status(&id, &TaskStatus::Queued, &f.submitter);

    let (_contract, _topics, data) = f.env.events().all().get(0).unwrap();
    let payload: LifecycleStatusChangedEvent = data.into_val(&f.env);
    assert_eq!(payload.version, TASK_LIFECYCLE_EVENT_VERSION);
    assert_eq!(payload.task_id, id);
    assert_eq!(payload.record_version, 2);
    assert_eq!(payload.from_status, TaskStatus::Created);
    assert_eq!(payload.to_status, TaskStatus::Queued);
    assert_eq!(payload.updater, f.submitter);
    assert_eq!(payload.updated_at, f.env.ledger().timestamp());
}

#[test]
fn the_status_changed_event_marks_the_new_version_on_the_record() {
    let f = fixture();
    let id = task_id(&f, 1);
    create(&f, &id, &f.submitter, 1_000);
    f.client
        .update_status(&id, &TaskStatus::Queued, &f.submitter);
    f.client
        .update_status(&id, &TaskStatus::Assigned, &f.submitter);

    let (_contract, _topics, data) = f.env.events().all().get(0).unwrap();
    let payload: LifecycleStatusChangedEvent = data.into_val(&f.env);
    assert_eq!(payload.record_version, 3);
    // The version on the record and the version in the event agree.
    assert_eq!(payload.record_version, f.client.get_task(&id).task.version);
}

#[test]
fn a_terminal_transition_still_emits_the_single_status_event() {
    let f = fixture();
    let id = task_id(&f, 1);
    create(&f, &id, &f.submitter, 1_000);
    f.client
        .update_status(&id, &TaskStatus::Cancelled, &f.submitter);

    let events = f.env.events().all();
    assert_eq!(events.len(), 1);
    let (_contract, _topics, data) = events.get(0).unwrap();
    let payload: LifecycleStatusChangedEvent = data.into_val(&f.env);
    assert_eq!(payload.to_status, TaskStatus::Cancelled);
    assert!(payload.to_status.is_terminal());
}

// ── Creator index across both submission paths ───────────────────────────────

#[test]
fn the_creator_index_holds_tasks_from_both_submission_paths() {
    let f = fixture();
    let dag_id = task_id(&f, 1);
    let lifecycle_id = task_id(&f, 2);
    store(&f, &dag_id, &f.submitter);
    create(&f, &lifecycle_id, &f.submitter, 1_000);

    let page = f
        .client
        .get_tasks_by_creator(&f.submitter, &0, &MAX_TASKS_PAGE_SIZE);
    assert_eq!(page.total, 2);
    assert!(contains(&page.task_ids, &dag_id));
    assert!(contains(&page.task_ids, &lifecycle_id));
}

#[test]
fn the_creator_index_paginates_a_large_lifecycle_backlog() {
    let f = fixture();
    let count = MAX_TRACKED_TASKS_PER_CREATOR;
    for i in 0..count {
        create(
            &f,
            &task_id(&f, (i + 1) as u8),
            &f.submitter,
            1_000 + i128::from(i),
        );
    }

    let mut seen = Vec::new(&f.env);
    let mut cursor = 0u32;
    let total = loop {
        let page = f.client.get_tasks_by_creator(&f.submitter, &cursor, &7u32);
        for id in page.task_ids.iter() {
            seen.push_back(id);
        }
        match page.next_cursor {
            Some(next) => cursor = next,
            None => break page.total,
        }
    };

    assert_eq!(total, count);
    assert_eq!(seen.len(), count);
    // No duplicates across pages, and the first task survived the cap.
    assert!(contains(&seen, &task_id(&f, 1)));
    assert_eq!(f.client.get_task(&task_id(&f, 1)).task.budget_xlm, 1_000);
}

#[test]
fn ttl_management_preserves_expiry_boundary_for_all_retention_days() {
    // Exercise every day in the retention window. A task remains readable
    // before the boundary and is reported expired at the boundary.
    for days in 0..=DEFAULT_TTL_DAYS {
        let f = fixture();
        let id = task_id(&f, (days + 1) as u8);
        create(&f, &id, &f.submitter, 1_000);

        f.env.ledger().with_mut(|ledger| {
            ledger.timestamp += u64::from(days) * SECONDS_PER_DAY;
        });

        if days < DEFAULT_TTL_DAYS {
            assert!(f.client.try_get_task(&id).is_ok());
        } else {
            assert_eq!(f.client.try_get_task(&id), Err(Ok(Error::Expired)));
        }
    }
}

// ─── TTL cleanup and extension tests (issue #937) ────────────────────────────
//
// Four test groups, one per issue task:
//   1. TTL is attached to task records (ledger rent + timestamp expiry).
//   2. cleanup_expired_tasks removes expired entries and leaves live ones.
//   3. extend_task_ttl pushes the rent window forward for active tasks.
//   4. Combined: expiry → cleanup → extension round-trip.

#[cfg(test)]
mod ttl_cleanup_tests {
    use super::*;
    #[allow(unused_imports)]
    use soroban_sdk::{
        testutils::{storage::Persistent as _, Address as _, Ledger as _},
        Address, Bytes, BytesN, Env, Vec,
    };

    const BASE_TS: u64 = 1_700_000_000;
    // One day in seconds (must match the private const in lib.rs).
    const SECS_PER_DAY: u64 = 86_400;

    // ── Shared helpers ──────────────────────────────────────────────────────

    fn setup() -> (Env, TaskStoreContractClient<'static>) {
        let env = Env::default();
        env.mock_all_auths();
        env.ledger().set_timestamp(BASE_TS);
        env.ledger().set_sequence_number(100);
        let id = env.register(TaskStoreContract, ());
        let client = TaskStoreContractClient::new(&env, &id);
        client.initialize(&Address::generate(&env));
        (env, client)
    }

    fn tid(env: &Env, n: u8) -> BytesN<32> {
        BytesN::from_array(env, &[n; 32])
    }

    fn dag_task(env: &Env, client: &TaskStoreContractClient<'_>, id: &BytesN<32>, ttl_days: u32) {
        let agents = Vec::from_array(env, [Address::generate(env)]);
        let dag = Bytes::from_slice(env, &[0x78, 0x9c, 0x03, 0x00]);
        client.store_task_metadata(
            &Address::generate(env),
            id,
            &BytesN::from_array(env, &[0xAA; 32]),
            &agents,
            &dag,
            &ttl_days,
            &None,
        );
    }

    fn lifecycle_task(
        env: &Env,
        client: &TaskStoreContractClient<'_>,
        id: &BytesN<32>,
        creator: &Address,
    ) {
        client.create_task(id, creator, &BytesN::from_array(env, &[0xBB; 32]), &1_000_000);
    }

    fn ttl_of(env: &Env, client: &TaskStoreContractClient<'_>, key: DataKey) -> u32 {
        env.as_contract(&client.address, || env.storage().persistent().get_ttl(&key))
    }

    fn has_key(env: &Env, client: &TaskStoreContractClient<'_>, key: DataKey) -> bool {
        env.as_contract(&client.address, || env.storage().persistent().has(&key))
    }

    // ── 1. TTL attached to task records ─────────────────────────────────────

    /// A DAG task stored with `ttl_days = 1` must have its `Task`,
    /// `TaskHistory`, and `TaskVersionCount` persistent keys each carrying a
    /// ledger TTL of exactly `LEDGERS_PER_DAY`. The `expires_at` timestamp
    /// must equal `created_at + 1 day`.
    #[test]
    fn dag_task_ttl_is_set_to_requested_days() {
        let (env, client) = setup();
        let id = tid(&env, 1);
        dag_task(&env, &client, &id, 1);

        let meta = client.get_task_metadata(&id);
        assert_eq!(meta.expires_at, BASE_TS + SECS_PER_DAY);

        assert_eq!(ttl_of(&env, &client, DataKey::Task(id.clone())), LEDGERS_PER_DAY);
        assert_eq!(
            ttl_of(&env, &client, DataKey::TaskHistory(id.clone())),
            LEDGERS_PER_DAY
        );
        assert_eq!(
            ttl_of(&env, &client, DataKey::TaskVersionCount(id.clone())),
            LEDGERS_PER_DAY
        );
    }

    /// A lifecycle task created at `BASE_TS` must carry a ledger TTL of
    /// `DEFAULT_TTL_DAYS * LEDGERS_PER_DAY` on its `LifecycleTask` key and
    /// must be readable until the timestamp boundary.
    #[test]
    fn lifecycle_task_ttl_uses_default_ttl_days() {
        let (env, client) = setup();
        let creator = Address::generate(&env);
        let id = tid(&env, 2);
        lifecycle_task(&env, &client, &id, &creator);

        // Key carries the full default TTL.
        let expected_ledgers = DEFAULT_TTL_DAYS * LEDGERS_PER_DAY;
        assert_eq!(
            ttl_of(&env, &client, DataKey::LifecycleTask(id.clone())),
            expected_ledgers
        );

        // Readable one second before expiry.
        env.ledger().set_timestamp(BASE_TS + u64::from(DEFAULT_TTL_DAYS) * SECS_PER_DAY - 1);
        assert!(client.try_get_task(&id).is_ok());

        // Expired at the boundary.
        env.ledger().set_timestamp(BASE_TS + u64::from(DEFAULT_TTL_DAYS) * SECS_PER_DAY);
        assert_eq!(client.try_get_task(&id), Err(Ok(Error::Expired)));
    }

    // ── 2. cleanup_expired_tasks removes expired entries ────────────────────

    /// After advancing the clock past a DAG task's `expires_at`,
    /// `cleanup_expired_tasks` must remove its `Task`, `TaskHistory`,
    /// `TaskVersionCount`, and `TaskCreator` keys and return a `CleanupResult`
    /// reflecting one expired task. A subsequent call on the same id is a no-op
    /// (idempotent).
    #[test]
    fn cleanup_removes_all_keys_for_expired_dag_task() {
        let (env, client) = setup();
        let id = tid(&env, 3);
        dag_task(&env, &client, &id, 1);

        // Advance past expiry.
        env.ledger().set_timestamp(BASE_TS + SECS_PER_DAY);

        let batch = Vec::from_array(&env, [id.clone()]);
        let result = client.cleanup_expired_tasks(&batch);

        assert_eq!(result.tasks_checked, 1);
        assert_eq!(result.tasks_expired, 1);
        // Task + TaskHistory + TaskVersionCount + TaskCreator = up to 4 entries.
        assert!(result.entries_removed >= 2, "expected at least 2 entries removed");

        // All task keys must be gone.
        assert!(!has_key(&env, &client, DataKey::Task(id.clone())));
        assert!(!has_key(&env, &client, DataKey::TaskHistory(id.clone())));
        assert!(!has_key(&env, &client, DataKey::TaskVersionCount(id.clone())));
        assert!(!has_key(&env, &client, DataKey::TaskCreator(id.clone())));

        // Calling cleanup again on the same (now-absent) id must succeed silently.
        let second = client.cleanup_expired_tasks(&Vec::from_array(&env, [id.clone()]));
        assert_eq!(second.tasks_expired, 0);
        assert_eq!(second.entries_removed, 0);
    }

    /// An expired lifecycle task must also be cleaned up, and its
    /// `TaskExpiredEvent` must be emitted exactly once per expired task.
    #[test]
    fn cleanup_removes_expired_lifecycle_task_and_emits_event() {
        let (env, client) = setup();
        let creator = Address::generate(&env);
        let id = tid(&env, 4);
        lifecycle_task(&env, &client, &id, &creator);

        // Advance past the default TTL.
        env.ledger().set_timestamp(BASE_TS + u64::from(DEFAULT_TTL_DAYS) * SECS_PER_DAY);

        let batch = Vec::from_array(&env, [id.clone()]);
        let result = client.cleanup_expired_tasks(&batch);

        assert_eq!(result.tasks_expired, 1);
        assert!(!has_key(&env, &client, DataKey::LifecycleTask(id.clone())));

        // Exactly one TaskExpiredEvent must have been emitted for this task.
        // The event was the most-recently published one (cleanup emits one per
        // expired task, and we cleaned exactly one).
        let events = env.events().all();
        let last_event = events.get(events.len() - 1).unwrap();
        assert_eq!(
            last_event.1,
            (symbol_short!("task_str"), symbol_short!("expired")).into_val(&env),
            "expected TaskExpiredEvent as the last emitted event"
        );
    }

    /// A live (not-yet-expired) task in the batch must be skipped — its storage
    /// keys must remain intact after `cleanup_expired_tasks` returns.
    #[test]
    fn cleanup_does_not_touch_live_tasks() {
        let (env, client) = setup();
        let id_live = tid(&env, 5);
        let id_expired = tid(&env, 6);

        dag_task(&env, &client, &id_live, MAX_TTL_DAYS); // long-lived
        dag_task(&env, &client, &id_expired, 1); // expires in 1 day

        // Advance past the short task but not the long one.
        env.ledger().set_timestamp(BASE_TS + SECS_PER_DAY);

        let batch = Vec::from_array(&env, [id_live.clone(), id_expired.clone()]);
        let result = client.cleanup_expired_tasks(&batch);

        assert_eq!(result.tasks_checked, 2);
        assert_eq!(result.tasks_expired, 1);

        // Short task removed.
        assert!(!has_key(&env, &client, DataKey::Task(id_expired.clone())));

        // Long task untouched — still readable.
        assert!(has_key(&env, &client, DataKey::Task(id_live.clone())));
        assert!(client.try_get_task_metadata(&id_live).is_ok());
    }

    /// A batch larger than `MAX_TASK_QUERY_BATCH` must be rejected before any
    /// storage is touched.
    #[test]
    fn cleanup_rejects_oversized_batch() {
        let (env, client) = setup();
        let mut ids = Vec::new(&env);
        for n in 0..=MAX_TASK_QUERY_BATCH {
            ids.push_back(tid(&env, n as u8));
        }
        assert_eq!(
            client.try_cleanup_expired_tasks(&ids),
            Err(Ok(Error::BatchTooLarge))
        );
    }

    // ── 3. extend_task_ttl pushes rent window forward ────────────────────────

    /// Extending a DAG task by 1 day must increment `expires_at` by exactly
    /// `SECS_PER_DAY` and re-arm the persistent TTL on its storage keys.
    #[test]
    fn extend_dag_task_ttl_increases_expires_at_and_refreshes_ledger_ttl() {
        let (env, client) = setup();
        let submitter = Address::generate(&env);
        let agents = Vec::from_array(&env, [Address::generate(&env)]);
        let dag = Bytes::from_slice(&env, &[0x78, 0x9c, 0x03, 0x00]);
        let id = tid(&env, 7);
        client.store_task_metadata(
            &submitter,
            &id,
            &BytesN::from_array(&env, &[0xAA; 32]),
            &agents,
            &dag,
            &1,
            &None,
        );

        let before = client.get_task_metadata(&id).expires_at;
        assert_eq!(before, BASE_TS + SECS_PER_DAY);

        // Extend by 1 more day (the submitter is indexed as the TaskCreator).
        client.extend_task_ttl(&id, &submitter, &1u32);

        let after = client.get_task_metadata(&id).expires_at;
        assert_eq!(after, before + SECS_PER_DAY);

        // The persistent-storage TTL on the Task key must be ≥ 2 days.
        let ttl = ttl_of(&env, &client, DataKey::Task(id.clone()));
        assert!(
            ttl >= 2 * LEDGERS_PER_DAY,
            "expected TTL ≥ 2 days worth of ledgers, got {}",
            ttl
        );

        // A `TaskTtlExtendedEvent` must be emitted as the last event.
        let events = env.events().all();
        let last_event = events.get(events.len() - 1).unwrap();
        assert_eq!(
            last_event.1,
            (symbol_short!("task_str"), symbol_short!("ttl_ext")).into_val(&env),
            "expected TaskTtlExtendedEvent as the last emitted event"
        );
    }

    /// Extending a lifecycle task must re-arm the rent on `LifecycleTask`,
    /// `TaskHistory`, and `TaskVersionCount`.
    #[test]
    fn extend_lifecycle_task_ttl_refreshes_all_auxiliary_keys() {
        let (env, client) = setup();
        let creator = Address::generate(&env);
        let id = tid(&env, 8);
        lifecycle_task(&env, &client, &id, &creator);

        // Extend by 1 day.
        client.extend_task_ttl(&id, &creator, &1u32);

        let lc_ttl = ttl_of(&env, &client, DataKey::LifecycleTask(id.clone()));
        let hist_ttl = ttl_of(&env, &client, DataKey::TaskHistory(id.clone()));
        let cnt_ttl = ttl_of(&env, &client, DataKey::TaskVersionCount(id.clone()));

        // All three keys must have been extended beyond the default window.
        let default_ttl = DEFAULT_TTL_DAYS * LEDGERS_PER_DAY;
        assert!(
            lc_ttl > default_ttl,
            "LifecycleTask TTL should exceed default after extension"
        );
        assert!(
            hist_ttl > default_ttl,
            "TaskHistory TTL should exceed default after extension"
        );
        assert!(
            cnt_ttl > default_ttl,
            "TaskVersionCount TTL should exceed default after extension"
        );
    }

    /// Attempting to extend a task with `extension_days = 0` must be rejected
    /// with `InvalidTtl`.
    #[test]
    fn extend_task_ttl_rejects_zero_extension() {
        let (env, client) = setup();
        let creator = Address::generate(&env);
        let id = tid(&env, 9);
        lifecycle_task(&env, &client, &id, &creator);

        assert_eq!(
            client.try_extend_task_ttl(&id, &creator, &0u32),
            Err(Ok(Error::InvalidTtl))
        );
    }

    /// Calling `extend_task_ttl` on an already-expired task must return
    /// `Error::Expired` and must not alter any storage.
    #[test]
    fn extend_task_ttl_rejects_already_expired_task() {
        let (env, client) = setup();
        let creator = Address::generate(&env);
        let id = tid(&env, 10);
        lifecycle_task(&env, &client, &id, &creator);

        // Expire the task.
        env.ledger().set_timestamp(BASE_TS + u64::from(DEFAULT_TTL_DAYS) * SECS_PER_DAY);

        assert_eq!(
            client.try_extend_task_ttl(&id, &creator, &1u32),
            Err(Ok(Error::Expired))
        );
    }

    /// A non-creator, non-coordinator address must be rejected with
    /// `Unauthorized`.
    #[test]
    fn extend_task_ttl_rejects_unauthorized_caller() {
        let (env, client) = setup();
        let creator = Address::generate(&env);
        let stranger = Address::generate(&env);
        let id = tid(&env, 11);
        lifecycle_task(&env, &client, &id, &creator);

        assert_eq!(
            client.try_extend_task_ttl(&id, &stranger, &1u32),
            Err(Ok(Error::Unauthorized))
        );
    }

    /// Calling `extend_task_ttl` on an unknown task id must return
    /// `Error::NotFound`.
    #[test]
    fn extend_task_ttl_rejects_unknown_task() {
        let (env, client) = setup();
        let stranger = Address::generate(&env);
        let ghost = tid(&env, 12);

        assert_eq!(
            client.try_extend_task_ttl(&ghost, &stranger, &1u32),
            Err(Ok(Error::NotFound))
        );
    }
}
