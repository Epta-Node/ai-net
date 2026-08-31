#![no_std]

mod types;

pub use types::{
    DataKey, Error, TaskCreatedEvent, TaskFinalizedEvent, TaskMetadata, TaskStatus,
    TaskUpdatedEvent, DEFAULT_TTL_DAYS, LEDGERS_PER_DAY, MAX_COMPRESSED_DAG_BYTES, MAX_TTL_DAYS,
    TASK_LIFECYCLE_EVENT_VERSION,
};

use soroban_sdk::{contract, contractimpl, symbol_short, Address, Bytes, BytesN, Env, Vec};

const SECONDS_PER_DAY: u64 = 86_400;

fn ttl_ledgers(ttl_days: u32) -> u32 {
    ttl_days.saturating_mul(LEDGERS_PER_DAY)
}

fn is_expired(env: &Env, metadata: &TaskMetadata) -> bool {
    env.ledger().timestamp() >= metadata.expires_at
}

fn read_metadata(env: &Env, task_id: &BytesN<32>) -> Result<TaskMetadata, Error> {
    let key = DataKey::Task(task_id.clone());
    let metadata: TaskMetadata = env
        .storage()
        .persistent()
        .get(&key)
        .ok_or(Error::NotFound)?;

    if is_expired(env, &metadata) {
        return Err(Error::Expired);
    }

    Ok(metadata)
}

fn has_duplicate_agents(agents: &Vec<Address>) -> bool {
    for (index, agent) in agents.iter().enumerate() {
        for other in agents.iter().skip(index + 1) {
            if agent == other {
                return true;
            }
        }
    }
    false
}

fn can_transition(from: TaskStatus, to: TaskStatus) -> bool {
    matches!(
        (from, to),
        (TaskStatus::Pending, TaskStatus::Running)
            | (TaskStatus::Pending, TaskStatus::Failed)
            | (TaskStatus::Running, TaskStatus::Completed)
            | (TaskStatus::Running, TaskStatus::Failed)
    )
}

fn is_terminal(status: TaskStatus) -> bool {
    matches!(status, TaskStatus::Completed | TaskStatus::Failed)
}

#[contract]
pub struct TaskStoreContract;

#[contractimpl]
impl TaskStoreContract {
    pub fn store_task_metadata(
        env: Env,
        submitter: Address,
        task_id: BytesN<32>,
        prompt_hash: BytesN<32>,
        assigned_agents: Vec<Address>,
        compressed_dag: Bytes,
        ttl_days: u32,
    ) -> Result<(), Error> {
        submitter.require_auth();

        let key = DataKey::Task(task_id.clone());
        if env.storage().persistent().has(&key) {
            return Err(Error::AlreadyExists);
        }
        if assigned_agents.is_empty() {
            return Err(Error::NoAssignedAgents);
        }
        if has_duplicate_agents(&assigned_agents) {
            return Err(Error::DuplicateAgent);
        }
        if compressed_dag.is_empty() || compressed_dag.len() > MAX_COMPRESSED_DAG_BYTES {
            return Err(Error::InvalidDag);
        }

        let retention_days = if ttl_days == 0 {
            DEFAULT_TTL_DAYS
        } else {
            ttl_days
        };
        if retention_days > MAX_TTL_DAYS {
            return Err(Error::InvalidTtl);
        }

        let created_at = env.ledger().timestamp();
        let expires_at =
            created_at.saturating_add(u64::from(retention_days).saturating_mul(SECONDS_PER_DAY));
        let metadata = TaskMetadata {
            task_id: task_id.clone(),
            prompt_hash: prompt_hash.clone(),
            assigned_agents,
            compressed_dag,
            status: TaskStatus::Pending,
            created_at,
            expires_at,
        };

        env.storage().persistent().set(&key, &metadata);
        let ledgers = ttl_ledgers(retention_days);
        env.storage()
            .persistent()
            .extend_ttl(&key, ledgers.saturating_sub(1), ledgers);

        env.events().publish(
            (symbol_short!("task_meta"), symbol_short!("created")),
            TaskCreatedEvent {
                version: TASK_LIFECYCLE_EVENT_VERSION,
                task_id,
                prompt_hash,
                assigned_agents: metadata.assigned_agents,
                created_at,
                expires_at,
            },
        );

        Ok(())
    }

    pub fn get_task_metadata(env: Env, task_id: BytesN<32>) -> Result<TaskMetadata, Error> {
        read_metadata(&env, &task_id)
    }

    pub fn get_task_status(env: Env, task_id: BytesN<32>) -> Result<TaskStatus, Error> {
        Ok(read_metadata(&env, &task_id)?.status)
    }

    pub fn update_task_status(
        env: Env,
        task_id: BytesN<32>,
        agent: Address,
        new_status: TaskStatus,
    ) -> Result<(), Error> {
        agent.require_auth();

        let key = DataKey::Task(task_id.clone());
        let mut metadata = read_metadata(&env, &task_id)?;
        if !metadata.assigned_agents.contains(&agent) {
            return Err(Error::NotAssignedAgent);
        }
        if !can_transition(metadata.status, new_status) {
            return Err(Error::InvalidStatusTransition);
        }

        let old_status = metadata.status;
        metadata.status = new_status;
        env.storage().persistent().set(&key, &metadata);

        // Every successful transition emits exactly one lifecycle event:
        // terminal transitions (-> Completed / -> Failed) emit `finalized`,
        // everything else emits `updated` — never both.
        let timestamp = env.ledger().timestamp();
        if is_terminal(new_status) {
            env.events().publish(
                (symbol_short!("task_meta"), symbol_short!("finalized")),
                TaskFinalizedEvent {
                    version: TASK_LIFECYCLE_EVENT_VERSION,
                    task_id,
                    agent,
                    old_status,
                    final_status: new_status,
                    finalized_at: timestamp,
                },
            );
        } else {
            env.events().publish(
                (symbol_short!("task_meta"), symbol_short!("updated")),
                TaskUpdatedEvent {
                    version: TASK_LIFECYCLE_EVENT_VERSION,
                    task_id,
                    agent,
                    old_status,
                    new_status,
                    updated_at: timestamp,
                },
            );
        }

        Ok(())
    }
}

#[cfg(test)]
mod test {
    use super::*;
    use soroban_sdk::{
        testutils::Address as _, testutils::Events, testutils::Ledger, Address, Env, IntoVal,
    };

    struct Fixture {
        env: Env,
        client: TaskStoreContractClient<'static>,
        submitter: Address,
        agent: Address,
        task_id: BytesN<32>,
        prompt_hash: BytesN<32>,
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

        Fixture {
            submitter: Address::generate(&env),
            agent: Address::generate(&env),
            task_id: BytesN::from_array(&env, &[1; 32]),
            prompt_hash: BytesN::from_array(&env, &[2; 32]),
            env,
            client,
        }
    }

    fn store(fixture: &Fixture, ttl_days: u32) {
        let agents = Vec::from_array(&fixture.env, [fixture.agent.clone()]);
        let dag = Bytes::from_slice(&fixture.env, &[0x78, 0x9c, 0x03, 0x00]);
        fixture.client.store_task_metadata(
            &fixture.submitter,
            &fixture.task_id,
            &fixture.prompt_hash,
            &agents,
            &dag,
            &ttl_days,
        );
    }

    #[test]
    fn stores_and_retrieves_metadata() {
        let fixture = fixture();
        store(&fixture, 0);

        let metadata = fixture.client.get_task_metadata(&fixture.task_id);
        assert_eq!(metadata.task_id, fixture.task_id);
        assert_eq!(metadata.prompt_hash, fixture.prompt_hash);
        assert_eq!(metadata.assigned_agents.get(0), Some(fixture.agent));
        assert_eq!(metadata.status, TaskStatus::Pending);
        assert_eq!(
            metadata.expires_at,
            metadata.created_at + u64::from(DEFAULT_TTL_DAYS) * SECONDS_PER_DAY
        );
    }

    #[test]
    fn assigned_agent_updates_status() {
        let fixture = fixture();
        store(&fixture, 1);

        fixture
            .client
            .update_task_status(&fixture.task_id, &fixture.agent, &TaskStatus::Running);
        assert_eq!(
            fixture.client.get_task_status(&fixture.task_id),
            TaskStatus::Running
        );
    }

    #[test]
    fn unassigned_agent_cannot_update_status() {
        let fixture = fixture();
        store(&fixture, 1);
        let stranger = Address::generate(&fixture.env);

        let result = fixture.client.try_update_task_status(
            &fixture.task_id,
            &stranger,
            &TaskStatus::Running,
        );
        assert_eq!(result, Err(Ok(Error::NotAssignedAgent)));
    }

    #[test]
    fn rejects_invalid_status_transition() {
        let fixture = fixture();
        store(&fixture, 1);

        let result = fixture.client.try_update_task_status(
            &fixture.task_id,
            &fixture.agent,
            &TaskStatus::Completed,
        );
        assert_eq!(result, Err(Ok(Error::InvalidStatusTransition)));
    }

    #[test]
    fn metadata_expires_after_configured_period() {
        let fixture = fixture();
        store(&fixture, 1);
        fixture.env.ledger().with_mut(|ledger| {
            ledger.timestamp += SECONDS_PER_DAY;
        });

        assert_eq!(
            fixture.client.try_get_task_metadata(&fixture.task_id),
            Err(Ok(Error::Expired))
        );
    }

    #[test]
    fn emits_exactly_one_created_event_on_store() {
        let fixture = fixture();
        store(&fixture, 1);

        let events = fixture.env.events().all();
        assert_eq!(events.len(), 1);
        assert_eq!(
            events.get(0).unwrap().1,
            (symbol_short!("task_meta"), symbol_short!("created")).into_val(&fixture.env)
        );
    }

    #[test]
    fn emits_exactly_one_updated_event_on_non_terminal_transition() {
        let fixture = fixture();
        store(&fixture, 1);

        fixture
            .client
            .update_task_status(&fixture.task_id, &fixture.agent, &TaskStatus::Running);

        let events = fixture.env.events().all();
        assert_eq!(events.len(), 1);
        assert_eq!(
            events.get(0).unwrap().1,
            (symbol_short!("task_meta"), symbol_short!("updated")).into_val(&fixture.env)
        );
    }

    #[test]
    fn emits_exactly_one_finalized_event_on_terminal_transition() {
        let fixture = fixture();
        store(&fixture, 1);
        fixture
            .client
            .update_task_status(&fixture.task_id, &fixture.agent, &TaskStatus::Running);

        fixture
            .client
            .update_task_status(&fixture.task_id, &fixture.agent, &TaskStatus::Completed);

        // No `updated` event alongside it — exactly one lifecycle event
        // for this transition, and it's `finalized`, not `updated`.
        let events = fixture.env.events().all();
        assert_eq!(events.len(), 1);
        assert_eq!(
            events.get(0).unwrap().1,
            (symbol_short!("task_meta"), symbol_short!("finalized")).into_val(&fixture.env)
        );
    }

    #[test]
    fn finalized_event_fires_for_the_failed_terminal_status_too() {
        let fixture = fixture();
        store(&fixture, 1);

        fixture
            .client
            .update_task_status(&fixture.task_id, &fixture.agent, &TaskStatus::Failed);

        let events = fixture.env.events().all();
        assert_eq!(events.len(), 1);
        assert_eq!(
            events.get(0).unwrap().1,
            (symbol_short!("task_meta"), symbol_short!("finalized")).into_val(&fixture.env)
        );
    }

    #[test]
    fn created_event_payload_matches_stored_metadata() {
        let fixture = fixture();
        store(&fixture, 1);

        let metadata = fixture.client.get_task_metadata(&fixture.task_id);
        let events = fixture.env.events().all();
        let (_contract_id, _topics, data) = events.get(0).unwrap();
        let payload: TaskCreatedEvent = data.into_val(&fixture.env);

        assert_eq!(payload.version, TASK_LIFECYCLE_EVENT_VERSION);
        assert_eq!(payload.task_id, fixture.task_id);
        assert_eq!(payload.prompt_hash, fixture.prompt_hash);
        assert_eq!(payload.assigned_agents, metadata.assigned_agents);
        assert_eq!(payload.created_at, metadata.created_at);
        assert_eq!(payload.expires_at, metadata.expires_at);
    }

    #[test]
    fn a_rejected_transition_emits_no_lifecycle_event() {
        let fixture = fixture();
        store(&fixture, 1);

        // Pending -> Completed is not a valid transition (must pass through
        // Running first) and is rejected before any event is published.
        let _ = fixture.client.try_update_task_status(
            &fixture.task_id,
            &fixture.agent,
            &TaskStatus::Completed,
        );

        assert_eq!(fixture.env.events().all().len(), 0);
    }
}
