//! Unit tests for the Agent Governance contract: proposal lifecycle, voting
//! power weighting, quorum + majority checks, and execution outcomes.

extern crate std;

use super::*;
use soroban_sdk::TryFromVal;
use soroban_sdk::{
    contract, contractimpl, symbol_short,
    testutils::{Address as _, Events as _, Ledger as _, MockAuth, MockAuthInvoke},
    Address, Bytes, Env, IntoVal, String, Symbol,
};

// ── mock execution target ───────────────────────────────────────────────────

#[contract]
pub struct MockTarget;

#[contractimpl]
impl MockTarget {
    pub fn apply(env: Env, calldata: Bytes) {
        env.storage()
            .instance()
            .set(&symbol_short!("last"), &calldata);
    }

    pub fn boom(_env: Env, _calldata: Bytes) {
        panic!("target failure");
    }

    pub fn last(env: Env) -> Option<Bytes> {
        env.storage().instance().get(&symbol_short!("last"))
    }
}

fn setup() -> (Env, AgentGovernanceContractClient<'static>) {
    let env = Env::default();
    env.mock_all_auths();
    let id = env.register(AgentGovernanceContract, ());
    let client = AgentGovernanceContractClient::new(&env, &id);
    let admin = Address::generate(&env);
    client.initialize(&admin);
    (env, client)
}

fn signal_payload(env: &Env) -> ExecutionPayload {
    ExecutionPayload {
        target: None,
        function: symbol_short!("noop"),
        calldata: Bytes::new(env),
        expected_hash: None,
    }
}

fn target_payload(env: &Env, target: &Address, function: Symbol) -> ExecutionPayload {
    ExecutionPayload {
        target: Some(target.clone()),
        function,
        calldata: Bytes::from_slice(env, b"fee=200"),
        expected_hash: None,
    }
}

fn register(
    client: &AgentGovernanceContractClient<'static>,
    agent: &Address,
    rep: u32,
    stake: i128,
) {
    client.register_agent(agent, &rep, &stake);
}

fn new_proposal(
    env: &Env,
    client: &AgentGovernanceContractClient<'static>,
    proposer: &Address,
) -> u64 {
    client.create_proposal(
        proposer,
        &ProposalType::AgentDispute,
        &String::from_str(env, "Raise fee"),
        &String::from_str(env, "Increase protocol fee to 2%"),
        &0, // default 7 days
        &signal_payload(env),
    )
}

// ── initialization ──────────────────────────────────────────────────────────

#[test]
fn initialize_is_one_time() {
    let (env, client) = setup();
    let other = Address::generate(&env);
    let err = client.try_initialize(&other);
    assert_eq!(err.err(), Some(Ok(Error::AlreadyInitialized)));
}

// ── agent registration & voting power ───────────────────────────────────────

#[test]
fn voting_power_is_weighted_by_stake_and_reputation() {
    let (env, client) = setup();
    let agent = Address::generate(&env);
    register(&client, &agent, 80, 5_000_000);

    let info = client.get_agent(&agent).unwrap();
    // 5_000_000 + 80 * 1_000_000
    assert_eq!(info.power, 85_000_000);
    assert_eq!(client.get_total_voting_power(), 85_000_000);
}

#[test]
fn register_rejects_bad_reputation() {
    let (env, client) = setup();
    let agent = Address::generate(&env);
    let err = client.try_register_agent(&agent, &101, &1_000_000);
    assert_eq!(err.err(), Some(Ok(Error::InvalidReputation)));
}

#[test]
fn register_twice_fails() {
    let (env, client) = setup();
    let agent = Address::generate(&env);
    register(&client, &agent, 50, 1_000_000);
    let err = client.try_register_agent(&agent, &60, &2_000_000);
    assert_eq!(err.err(), Some(Ok(Error::AgentAlreadyRegistered)));
}

#[test]
fn update_agent_adjusts_total_power() {
    let (env, client) = setup();
    let agent = Address::generate(&env);
    register(&client, &agent, 10, 1_000_000); // power 11_000_000
    client.update_agent(&agent, &50, &2_000_000); // power 52_000_000
    assert_eq!(client.get_agent(&agent).unwrap().power, 52_000_000);
    assert_eq!(client.get_total_voting_power(), 52_000_000);
}

// ── proposal creation ───────────────────────────────────────────────────────

#[test]
fn create_proposal_snapshots_total_power() {
    let (env, client) = setup();
    let a = Address::generate(&env);
    let b = Address::generate(&env);
    register(&client, &a, 50, 10_000_000);
    register(&client, &b, 50, 10_000_000);

    let id = new_proposal(&env, &client, &a);
    let p = client.get_proposal(&id).unwrap();
    assert_eq!(id, 1);
    assert_eq!(p.status, ProposalStatus::Active);
    assert_eq!(p.total_power_snapshot, client.get_total_voting_power());
    assert_eq!(p.voting_ends_at, p.created_at + DEFAULT_VOTING_PERIOD_SECS);
}

#[test]
fn create_proposal_requires_registered_proposer() {
    let (env, client) = setup();
    let stranger = Address::generate(&env);
    let err = client.try_create_proposal(
        &stranger,
        &ProposalType::ProtocolUpgrade,
        &String::from_str(&env, "t"),
        &String::from_str(&env, "d"),
        &0,
        &signal_payload(&env),
    );
    assert_eq!(err.err(), Some(Ok(Error::AgentNotRegistered)));
}

#[test]
fn create_proposal_rejects_empty_metadata() {
    let (env, client) = setup();
    let a = Address::generate(&env);
    register(&client, &a, 50, 10_000_000);
    let err = client.try_create_proposal(
        &a,
        &ProposalType::AgentDispute,
        &String::from_str(&env, ""),
        &String::from_str(&env, "d"),
        &0,
        &signal_payload(&env),
    );
    assert_eq!(err.err(), Some(Ok(Error::EmptyMetadata)));
}

#[test]
fn create_proposal_rejects_out_of_range_period() {
    let (env, client) = setup();
    let a = Address::generate(&env);
    register(&client, &a, 50, 10_000_000);
    let err = client.try_create_proposal(
        &a,
        &ProposalType::ParameterChange,
        &String::from_str(&env, "t"),
        &String::from_str(&env, "d"),
        &60, // below MIN_VOTING_PERIOD_SECS
        &signal_payload(&env),
    );
    assert_eq!(err.err(), Some(Ok(Error::InvalidVotingPeriod)));
}

// ── voting ──────────────────────────────────────────────────────────────────

#[test]
fn vote_accumulates_weighted_power() {
    let (env, client) = setup();
    let a = Address::generate(&env);
    let b = Address::generate(&env);
    register(&client, &a, 100, 10_000_000); // power 110_000_000
    register(&client, &b, 0, 5_000_000); //    power 5_000_000

    let id = new_proposal(&env, &client, &a);
    client.vote_on_proposal(&id, &a, &VoteChoice::For);
    client.vote_on_proposal(&id, &b, &VoteChoice::Against);

    let p = client.get_proposal(&id).unwrap();
    assert_eq!(p.for_power, 110_000_000);
    assert_eq!(p.against_power, 5_000_000);
    assert_eq!(client.get_vote(&id, &a).unwrap().choice, VoteChoice::For);
}

#[test]
fn double_vote_fails() {
    let (env, client) = setup();
    let a = Address::generate(&env);
    register(&client, &a, 50, 10_000_000);
    let id = new_proposal(&env, &client, &a);
    client.vote_on_proposal(&id, &a, &VoteChoice::For);
    let err = client.try_vote_on_proposal(&id, &a, &VoteChoice::Against);
    assert_eq!(err.err(), Some(Ok(Error::AlreadyVoted)));
}

#[test]
fn vote_after_deadline_fails() {
    let (env, client) = setup();
    let a = Address::generate(&env);
    register(&client, &a, 50, 10_000_000);
    let id = new_proposal(&env, &client, &a);
    let p = client.get_proposal(&id).unwrap();
    env.ledger().set_timestamp(p.voting_ends_at + 1);
    let err = client.try_vote_on_proposal(&id, &a, &VoteChoice::For);
    assert_eq!(err.err(), Some(Ok(Error::VotingPeriodEnded)));
}

#[test]
fn unregistered_voter_fails() {
    let (env, client) = setup();
    let a = Address::generate(&env);
    register(&client, &a, 50, 10_000_000);
    let id = new_proposal(&env, &client, &a);
    let stranger = Address::generate(&env);
    let err = client.try_vote_on_proposal(&id, &stranger, &VoteChoice::For);
    assert_eq!(err.err(), Some(Ok(Error::AgentNotRegistered)));
}

// ── execution: quorum & majority ────────────────────────────────────────────

#[test]
fn execute_passes_with_quorum_and_majority() {
    let (env, client) = setup();
    // Four equal voters, total power 4 * 11_000_000 = 44_000_000.
    let voters: std::vec::Vec<Address> = (0..4).map(|_| Address::generate(&env)).collect();
    for v in &voters {
        register(&client, v, 1, 10_000_000); // power 11_000_000
    }
    let id = new_proposal(&env, &client, &voters[0]);

    // 3 For, 1 Against → cast = 44M (100% quorum), for = 33M of 44M decisive (75%).
    client.vote_on_proposal(&id, &voters[0], &VoteChoice::For);
    client.vote_on_proposal(&id, &voters[1], &VoteChoice::For);
    client.vote_on_proposal(&id, &voters[2], &VoteChoice::For);
    client.vote_on_proposal(&id, &voters[3], &VoteChoice::Against);

    let p = client.get_proposal(&id).unwrap();
    env.ledger().set_timestamp(p.voting_ends_at + 1);

    let status = client.execute_proposal(&id);
    assert_eq!(status, ProposalStatus::Executed);
    assert_eq!(
        client.get_proposal(&id).unwrap().status,
        ProposalStatus::Executed
    );
}

#[test]
fn execute_fails_without_quorum() {
    let (env, client) = setup();
    // Ten voters; only one votes → 10% turnout, below 30% quorum.
    let voters: std::vec::Vec<Address> = (0..10).map(|_| Address::generate(&env)).collect();
    for v in &voters {
        register(&client, v, 0, 10_000_000);
    }
    let id = new_proposal(&env, &client, &voters[0]);
    client.vote_on_proposal(&id, &voters[0], &VoteChoice::For);

    let p = client.get_proposal(&id).unwrap();
    env.ledger().set_timestamp(p.voting_ends_at + 1);

    assert_eq!(client.execute_proposal(&id), ProposalStatus::Failed);
}

#[test]
fn execute_fails_without_majority() {
    let (env, client) = setup();
    let voters: std::vec::Vec<Address> = (0..4).map(|_| Address::generate(&env)).collect();
    for v in &voters {
        register(&client, v, 0, 10_000_000);
    }
    let id = new_proposal(&env, &client, &voters[0]);

    // 2 For, 2 Against → exactly 50%, not a strict majority → fails.
    client.vote_on_proposal(&id, &voters[0], &VoteChoice::For);
    client.vote_on_proposal(&id, &voters[1], &VoteChoice::For);
    client.vote_on_proposal(&id, &voters[2], &VoteChoice::Against);
    client.vote_on_proposal(&id, &voters[3], &VoteChoice::Against);

    let p = client.get_proposal(&id).unwrap();
    env.ledger().set_timestamp(p.voting_ends_at + 1);

    assert_eq!(client.execute_proposal(&id), ProposalStatus::Failed);
}

#[test]
fn abstain_counts_for_quorum_but_not_majority() {
    let (env, client) = setup();
    // 3 voters equal power. 1 For, 0 Against, 2 Abstain.
    // Quorum: 100% cast → met. Majority: for / (for+against) = 100% → met.
    let voters: std::vec::Vec<Address> = (0..3).map(|_| Address::generate(&env)).collect();
    for v in &voters {
        register(&client, v, 0, 10_000_000);
    }
    let id = new_proposal(&env, &client, &voters[0]);
    client.vote_on_proposal(&id, &voters[0], &VoteChoice::For);
    client.vote_on_proposal(&id, &voters[1], &VoteChoice::Abstain);
    client.vote_on_proposal(&id, &voters[2], &VoteChoice::Abstain);

    let p = client.get_proposal(&id).unwrap();
    env.ledger().set_timestamp(p.voting_ends_at + 1);
    assert_eq!(client.execute_proposal(&id), ProposalStatus::Executed);
}

#[test]
fn all_abstain_fails_majority() {
    let (env, client) = setup();
    let voters: std::vec::Vec<Address> = (0..3).map(|_| Address::generate(&env)).collect();
    for v in &voters {
        register(&client, v, 0, 10_000_000);
    }
    let id = new_proposal(&env, &client, &voters[0]);
    for v in &voters {
        client.vote_on_proposal(&id, v, &VoteChoice::Abstain);
    }
    let p = client.get_proposal(&id).unwrap();
    env.ledger().set_timestamp(p.voting_ends_at + 1);
    // Quorum met (100%) but no decisive votes → majority fails.
    assert_eq!(client.execute_proposal(&id), ProposalStatus::Failed);
}

#[test]
fn execute_before_deadline_fails() {
    let (env, client) = setup();
    let a = Address::generate(&env);
    register(&client, &a, 50, 10_000_000);
    let id = new_proposal(&env, &client, &a);
    let err = client.try_execute_proposal(&id);
    assert_eq!(err.err(), Some(Ok(Error::VotingPeriodActive)));
}

#[test]
fn execute_twice_fails() {
    let (env, client) = setup();
    let a = Address::generate(&env);
    register(&client, &a, 50, 10_000_000);
    let id = new_proposal(&env, &client, &a);
    client.vote_on_proposal(&id, &a, &VoteChoice::For);
    let p = client.get_proposal(&id).unwrap();
    env.ledger().set_timestamp(p.voting_ends_at + 1);
    client.execute_proposal(&id);
    let err = client.try_execute_proposal(&id);
    assert_eq!(err.err(), Some(Ok(Error::ProposalFinalized)));
}

#[test]
fn vote_on_finalized_proposal_fails() {
    let (env, client) = setup();
    let a = Address::generate(&env);
    let b = Address::generate(&env);
    register(&client, &a, 50, 10_000_000);
    register(&client, &b, 50, 10_000_000);
    let id = new_proposal(&env, &client, &a);
    client.vote_on_proposal(&id, &a, &VoteChoice::For);
    let p = client.get_proposal(&id).unwrap();
    env.ledger().set_timestamp(p.voting_ends_at + 1);
    client.execute_proposal(&id);
    let err = client.try_vote_on_proposal(&id, &b, &VoteChoice::For);
    assert_eq!(err.err(), Some(Ok(Error::ProposalNotActive)));
}

// ── events ──────────────────────────────────────────────────────────────────

#[test]
fn lifecycle_emits_events() {
    let (env, client) = setup();
    let a = Address::generate(&env);
    register(&client, &a, 50, 10_000_000); // power = 10_000_000 + 50 * 1_000_000 = 60_000_000
    let id = new_proposal(&env, &client, &a);

    // Verify ProposalCreated event
    let events = env.events().all();
    let created_topic = (symbol_short!("gov"), symbol_short!("created")).into_val(&env);
    let created_ev = events
        .iter()
        .find(|(_, topics, _)| *topics == created_topic)
        .expect("ProposalCreated event must be emitted");
    let created: ProposalCreated = ProposalCreated::try_from_val(&env, &created_ev.2).unwrap();
    assert_eq!(created.id, id);
    assert_eq!(created.proposer, a);
    assert_eq!(created.total_power_snapshot, 60_000_000);

    // Vote on proposal and verify ProposalVoted (VoteCast) event
    let _ = env.events().all(); // drain
    client.vote_on_proposal(&id, &a, &VoteChoice::For);
    let events_after_vote = env.events().all();
    let voted_topic = (symbol_short!("gov"), symbol_short!("vote_cast")).into_val(&env);
    let voted_ev = events_after_vote
        .iter()
        .find(|(_, topics, _)| *topics == voted_topic)
        .expect("ProposalVoted/VoteCast event must be emitted");
    let voted: ProposalVoted = ProposalVoted::try_from_val(&env, &voted_ev.2).unwrap();
    assert_eq!(voted.proposal_id, id);
    assert_eq!(voted.voter, a);
    assert_eq!(voted.choice, VoteChoice::For);
    assert_eq!(voted.weight, 60_000_000);

    // Execute proposal and verify ProposalExecuted event
    let p = client.get_proposal(&id).unwrap();
    env.ledger().set_timestamp(p.voting_ends_at + 1);
    let _ = env.events().all();
    let status = client.execute_proposal(&id);
    assert_eq!(status, ProposalStatus::Executed);

    let events_after_exec = env.events().all();
    let exec_topic = (symbol_short!("gov"), symbol_short!("executed")).into_val(&env);
    let exec_ev = events_after_exec
        .iter()
        .find(|(_, topics, _)| *topics == exec_topic)
        .expect("ProposalExecuted event must be emitted");
    let executed: ProposalExecuted = ProposalExecuted::try_from_val(&env, &exec_ev.2).unwrap();
    assert_eq!(executed.id, id);
    assert_eq!(executed.for_power, 60_000_000);
    assert_eq!(executed.against_power, 0);
    assert_eq!(executed.abstain_power, 0);
}

#[test]
fn full_proposal_lifecycle_all_types() {
    let (env, client) = setup();
    let target = env.register(MockTarget, ());
    client.set_param_registry(&target);
    let voters: std::vec::Vec<Address> = (0..3).map(|_| Address::generate(&env)).collect();
    for v in &voters {
        register(&client, v, 40, 6_000_000); // power 46_000_000
    }

    for pt in [
        ProposalType::ParameterChange,
        ProposalType::AgentDispute,
        ProposalType::ProtocolUpgrade,
    ] {
        let id = client.create_proposal(
            &voters[0],
            &pt,
            &String::from_str(&env, "title"),
            &String::from_str(&env, "body"),
            &MIN_VOTING_PERIOD_SECS,
            &target_payload(&env, &target, symbol_short!("apply")),
        );
        client.vote_on_proposal(&id, &voters[0], &VoteChoice::For);
        client.vote_on_proposal(&id, &voters[1], &VoteChoice::For);
        client.vote_on_proposal(&id, &voters[2], &VoteChoice::Against);

        let p = client.get_proposal(&id).unwrap();
        assert_eq!(p.proposal_type, pt);
        env.ledger().set_timestamp(p.voting_ends_at + 1);
        assert_eq!(client.execute_proposal(&id), ProposalStatus::Executed);
    }
    assert_eq!(client.get_proposal_count(), 3);
}

// ── execution payload ───────────────────────────────────────────────────────

fn pass_proposal(
    env: &Env,
    client: &AgentGovernanceContractClient<'static>,
    id: u64,
    voter: &Address,
) {
    client.vote_on_proposal(&id, voter, &VoteChoice::For);
    let p = client.get_proposal(&id).unwrap();
    env.ledger().set_timestamp(p.voting_ends_at + 1);
}

#[test]
fn passing_proposal_invokes_target() {
    let (env, client) = setup();
    let target = env.register(MockTarget, ());
    let a = Address::generate(&env);
    register(&client, &a, 50, 10_000_000);
    let id = client.create_proposal(
        &a,
        &ProposalType::ProtocolUpgrade,
        &String::from_str(&env, "t"),
        &String::from_str(&env, "d"),
        &0,
        &target_payload(&env, &target, symbol_short!("apply")),
    );
    pass_proposal(&env, &client, id, &a);
    assert_eq!(client.execute_proposal(&id), ProposalStatus::Executed);
    let target_client = MockTargetClient::new(&env, &target);
    assert_eq!(
        target_client.last(),
        Some(Bytes::from_slice(&env, b"fee=200"))
    );
}

#[test]
fn failed_invocation_marks_proposal_failed() {
    let (env, client) = setup();
    let target = env.register(MockTarget, ());
    let a = Address::generate(&env);
    register(&client, &a, 50, 10_000_000);
    let id = client.create_proposal(
        &a,
        &ProposalType::ProtocolUpgrade,
        &String::from_str(&env, "t"),
        &String::from_str(&env, "d"),
        &0,
        &target_payload(&env, &target, symbol_short!("boom")),
    );
    pass_proposal(&env, &client, id, &a);
    assert_eq!(client.execute_proposal(&id), ProposalStatus::Failed);
    assert_eq!(
        client.get_proposal(&id).unwrap().status,
        ProposalStatus::Failed
    );
}

#[test]
fn protocol_upgrade_requires_target() {
    let (env, client) = setup();
    let a = Address::generate(&env);
    register(&client, &a, 50, 10_000_000);
    let err = client.try_create_proposal(
        &a,
        &ProposalType::ProtocolUpgrade,
        &String::from_str(&env, "t"),
        &String::from_str(&env, "d"),
        &0,
        &signal_payload(&env),
    );
    assert_eq!(err.err(), Some(Ok(Error::InvalidTarget)));
}

#[test]
fn self_target_rejected() {
    let (env, client) = setup();
    let a = Address::generate(&env);
    register(&client, &a, 50, 10_000_000);
    let err = client.try_create_proposal(
        &a,
        &ProposalType::ProtocolUpgrade,
        &String::from_str(&env, "t"),
        &String::from_str(&env, "d"),
        &0,
        &target_payload(&env, &client.address, symbol_short!("apply")),
    );
    assert_eq!(err.err(), Some(Ok(Error::InvalidTarget)));
}

#[test]
fn parameter_change_requires_registry() {
    let (env, client) = setup();
    let a = Address::generate(&env);
    register(&client, &a, 50, 10_000_000);
    let err = client.try_create_proposal(
        &a,
        &ProposalType::ParameterChange,
        &String::from_str(&env, "t"),
        &String::from_str(&env, "d"),
        &0,
        &signal_payload(&env),
    );
    assert_eq!(err.err(), Some(Ok(Error::RegistryNotSet)));
}

#[test]
fn oversized_calldata_rejected() {
    let (env, client) = setup();
    let target = env.register(MockTarget, ());
    let a = Address::generate(&env);
    register(&client, &a, 50, 10_000_000);
    let mut payload = target_payload(&env, &target, symbol_short!("apply"));
    payload.calldata = Bytes::from_array(&env, &[0u8; (MAX_CALLDATA_LEN as usize) + 1]);
    let err = client.try_create_proposal(
        &a,
        &ProposalType::ProtocolUpgrade,
        &String::from_str(&env, "t"),
        &String::from_str(&env, "d"),
        &0,
        &payload,
    );
    assert_eq!(err.err(), Some(Ok(Error::CalldataTooLarge)));
}

#[test]
fn expected_hash_mismatch_rejected() {
    let (env, client) = setup();
    let target = env.register(MockTarget, ());
    let a = Address::generate(&env);
    register(&client, &a, 50, 10_000_000);
    let mut payload = target_payload(&env, &target, symbol_short!("apply"));
    payload.expected_hash = Some(soroban_sdk::BytesN::from_array(&env, &[7u8; 32]));
    let err = client.try_create_proposal(
        &a,
        &ProposalType::ProtocolUpgrade,
        &String::from_str(&env, "t"),
        &String::from_str(&env, "d"),
        &0,
        &payload,
    );
    assert_eq!(err.err(), Some(Ok(Error::PayloadHashMismatch)));
}

// ── voting-power snapshot ───────────────────────────────────────────────────

#[test]
fn vote_weight_uses_creation_snapshot() {
    let (env, client) = setup();
    let a = Address::generate(&env);
    register(&client, &a, 10, 1_000_000); // power 11_000_000
    let id = new_proposal(&env, &client, &a);

    env.ledger().set_timestamp(100);
    client.update_agent(&a, &100, &50_000_000); // inflate after creation
    client.vote_on_proposal(&id, &a, &VoteChoice::For);
    assert_eq!(client.get_vote(&id, &a).unwrap().weight, 11_000_000);
}

#[test]
fn agent_registered_after_snapshot_has_no_weight() {
    let (env, client) = setup();
    let a = Address::generate(&env);
    register(&client, &a, 50, 10_000_000);
    let id = new_proposal(&env, &client, &a);
    env.ledger().set_timestamp(100);
    let late = Address::generate(&env);
    register(&client, &late, 50, 10_000_000);
    let err = client.try_vote_on_proposal(&id, &late, &VoteChoice::For);
    assert_eq!(err.err(), Some(Ok(Error::NoSnapshotPower)));
}

#[test]
fn remove_agent_reduces_total_power() {
    let (env, client) = setup();
    let a = Address::generate(&env);
    let b = Address::generate(&env);
    register(&client, &a, 10, 1_000_000); // 11_000_000
    register(&client, &b, 10, 1_000_000); // 11_000_000
    client.remove_agent(&a);
    assert_eq!(client.get_total_voting_power(), 11_000_000);
    assert!(client.get_agent(&a).is_none());
}

// ── admin & pause ───────────────────────────────────────────────────────────

#[test]
fn set_admin_updates_admin() {
    let (env, client) = setup();
    let new_admin = Address::generate(&env);
    client.set_admin(&new_admin);
    assert_eq!(client.get_admin(), new_admin);
}

#[test]
fn pause_blocks_creation_and_voting() {
    let (env, client) = setup();
    let a = Address::generate(&env);
    register(&client, &a, 50, 10_000_000);
    let id = new_proposal(&env, &client, &a);
    client.pause();
    assert!(client.is_paused());

    let err = client.try_vote_on_proposal(&id, &a, &VoteChoice::For);
    assert_eq!(err.err(), Some(Ok(Error::ContractPaused)));
    let err = client.try_create_proposal(
        &a,
        &ProposalType::AgentDispute,
        &String::from_str(&env, "t"),
        &String::from_str(&env, "d"),
        &0,
        &signal_payload(&env),
    );
    assert_eq!(err.err(), Some(Ok(Error::ContractPaused)));

    client.unpause();
    client.vote_on_proposal(&id, &a, &VoteChoice::For);
}

fn setup_no_auth() -> (Env, AgentGovernanceContractClient<'static>, Address) {
    let env = Env::default();
    let id = env.register(AgentGovernanceContract, ());
    let client = AgentGovernanceContractClient::new(&env, &id);
    let admin = Address::generate(&env);
    client
        .mock_auths(&[MockAuth {
            address: &admin,
            invoke: &MockAuthInvoke {
                contract: &id,
                fn_name: "initialize",
                args: (admin.clone(),).into_val(&env),
                sub_invokes: &[],
            },
        }])
        .initialize(&admin);
    (env, client, admin)
}

#[test]
fn pause_requires_admin_auth() {
    let (_env, client, _admin) = setup_no_auth();
    assert!(client.mock_auths(&[]).try_pause().is_err());
    assert!(!client.is_paused());
}

#[test]
fn unpause_requires_admin_auth() {
    let (_env, client, _admin) = setup_no_auth();
    assert!(client.mock_auths(&[]).try_unpause().is_err());
}

#[test]
fn set_admin_requires_admin_auth() {
    let (env, client, admin) = setup_no_auth();
    let new_admin = Address::generate(&env);
    assert!(client.mock_auths(&[]).try_set_admin(&new_admin).is_err());
    assert_eq!(client.get_admin(), admin);
}

#[test]
fn set_admin_requires_incoming_admin_auth() {
    let (env, client, admin) = setup_no_auth();
    let new_admin = Address::generate(&env);
    let res = client
        .mock_auths(&[MockAuth {
            address: &admin,
            invoke: &MockAuthInvoke {
                contract: &client.address,
                fn_name: "set_admin",
                args: (new_admin.clone(),).into_val(&env),
                sub_invokes: &[],
            },
        }])
        .try_set_admin(&new_admin);
    assert!(res.is_err());
    assert_eq!(client.get_admin(), admin);
}

#[test]
fn set_param_registry_requires_admin_auth() {
    let (env, client, _admin) = setup_no_auth();
    let target = env.register(MockTarget, ());
    assert!(client
        .mock_auths(&[])
        .try_set_param_registry(&target)
        .is_err());
    assert!(client.get_param_registry().is_none());
}
