//! Unit tests for the Agent Governance contract: proposal lifecycle, voting
//! power weighting, quorum + majority checks, and execution outcomes.

extern crate std;

use super::*;
use soroban_sdk::{
    testutils::{Address as _, Events as _, Ledger as _},
    Address, Env, String,
};

fn setup() -> (Env, AgentGovernanceContractClient<'static>) {
    let env = Env::default();
    env.mock_all_auths();
    let id = env.register(AgentGovernanceContract, ());
    let client = AgentGovernanceContractClient::new(&env, &id);
    let admin = Address::generate(&env);
    client.initialize(&admin);
    (env, client)
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
        &ProposalType::ParameterChange,
        &String::from_str(env, "Raise fee"),
        &String::from_str(env, "Increase protocol fee to 2%"),
        &0, // default 7 days
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
    register(&client, &a, 50, 10_000_000);
    let id = new_proposal(&env, &client, &a);
    let _ = env.events().all(); // drain
    client.vote_on_proposal(&id, &a, &VoteChoice::For);
    assert!(!env.events().all().is_empty());

    let p = client.get_proposal(&id).unwrap();
    env.ledger().set_timestamp(p.voting_ends_at + 1);
    let _ = env.events().all();
    client.execute_proposal(&id);
    assert!(!env.events().all().is_empty());
}

#[test]
fn full_proposal_lifecycle_all_types() {
    let (env, client) = setup();
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
