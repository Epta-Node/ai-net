//! Unit tests for the multi-phase dispute contract.

extern crate std;

use super::*;
use agent_registry::{AgentRecord, AgentRegistryContract, AgentRegistryContractClient};
use soroban_sdk::{
    testutils::{Address as _, Ledger as _},
    Address, BytesN, Env, Map, String, Symbol,
};

struct Fixture {
    env: Env,
    client: DisputeResolutionContractClient<'static>,
    registry: AgentRegistryContractClient<'static>,
    registry_agent_id: Symbol,
    voters: [Address; 5],
    filer: Address,
    agent: Address,
    task_id: Symbol,
}

fn setup() -> Fixture {
    let env = Env::default();
    env.mock_all_auths();
    let contract_id = env.register(DisputeResolutionContract, ());
    let client = DisputeResolutionContractClient::new(&env, &contract_id);
    let admin = Address::generate(&env);
    client.initialize(&admin);

    let voters = [
        Address::generate(&env),
        Address::generate(&env),
        Address::generate(&env),
        Address::generate(&env),
        Address::generate(&env),
    ];
    let voter_vec = soroban_sdk::vec![
        &env,
        voters[0].clone(),
        voters[1].clone(),
        voters[2].clone(),
        voters[3].clone(),
        voters[4].clone(),
    ];
    client.set_voters(&voter_vec);
    for voter in voters.iter() {
        client.set_reputation(voter, &3);
    }

    let filer = Address::generate(&env);
    let agent = Address::generate(&env);
    let task_id = Symbol::new(&env, "task1");
    client.set_reputation(&filer, &10);
    client.set_reputation(&agent, &10);
    let registry_id = env.register(AgentRegistryContract, ());
    let registry = AgentRegistryContractClient::new(&env, &registry_id);
    let registry_agent_id = Symbol::new(&env, "registry_agent");
    registry.initialize(&admin);
    registry.set_min_bond(&100);
    registry.set_dispute_resolver(&contract_id);
    registry.register_agent(&AgentRecord {
        id: registry_agent_id.clone(),
        capability: Symbol::new(&env, "research"),
        price_stroops: 1,
        endpoint: String::from_str(&env, "https://agent.example"),
        owner: agent.clone(),
        metadata: Map::new(&env),
        bond_amount: 100,
    });
    client.set_agent_registry(&registry_id);
    client.set_agent_registry_id(&agent, &registry_agent_id);
    client.set_agent_bond(&agent, &100);
    client.set_task_escrow(&task_id, &1_000);

    Fixture {
        env,
        client,
        registry,
        registry_agent_id,
        voters,
        filer,
        agent,
        task_id,
    }
}

fn file(fixture: &Fixture) {
    fixture.client.file_dispute(
        &fixture.task_id,
        &fixture.filer,
        &fixture.agent,
        &String::from_str(&fixture.env, "work was not delivered"),
    );
}

fn advance_to_voting(fixture: &Fixture) {
    fixture.env.ledger().with_mut(|ledger| {
        ledger.timestamp += EVIDENCE_PHASE;
    });
}

fn advance_to_resolution(fixture: &Fixture) {
    fixture.env.ledger().with_mut(|ledger| {
        ledger.timestamp += EVIDENCE_PHASE + VOTING_PHASE;
    });
}

fn advance_to_appeal_finalization(fixture: &Fixture) {
    fixture.env.ledger().with_mut(|ledger| {
        ledger.timestamp += APPEAL_PHASE + 1;
    });
}

#[test]
fn filing_validates_reason_and_stores_record() {
    let fixture = setup();
    let id = fixture.client.file_dispute(
        &fixture.task_id,
        &fixture.filer,
        &fixture.agent,
        &String::from_str(&fixture.env, "incorrect output"),
    );
    assert_eq!(id, fixture.task_id);
    let dispute = fixture.client.get_dispute(&id).unwrap();
    assert_eq!(dispute.status, DisputeStatus::EvidencePhase);
    assert_eq!(dispute.evidence_deadline, dispute.filed_at + EVIDENCE_PHASE);
    assert_eq!(
        dispute.voting_deadline,
        dispute.evidence_deadline + VOTING_PHASE
    );
}

#[test]
fn both_parties_can_submit_evidence_and_outsiders_cannot() {
    let fixture = setup();
    file(&fixture);
    let hash = BytesN::from_array(&fixture.env, &[7u8; 32]);
    fixture
        .client
        .submit_evidence(&fixture.task_id, &fixture.filer, &hash);
    fixture
        .client
        .submit_evidence(&fixture.task_id, &fixture.agent, &hash);
    assert_eq!(fixture.client.get_evidence_count(&fixture.task_id), 2);

    let outsider = Address::generate(&fixture.env);
    assert_eq!(
        fixture
            .client
            .try_submit_evidence(&fixture.task_id, &outsider, &hash),
        Err(Ok(Error::Unauthorized))
    );
}

#[test]
fn vote_requires_reputation_and_prevents_double_voting() {
    let fixture = setup();
    file(&fixture);
    let voter = fixture.voters[0].clone();
    assert_eq!(
        fixture
            .client
            .try_vote(&fixture.task_id, &voter, &VoteSide::SupportFiler),
        Err(Ok(Error::InvalidPhase))
    );
    advance_to_voting(&fixture);
    fixture.client.set_reputation(&voter, &2);
    assert_eq!(
        fixture
            .client
            .try_vote(&fixture.task_id, &voter, &VoteSide::SupportFiler),
        Err(Ok(Error::NotEligibleVoter))
    );
    fixture.client.set_reputation(&voter, &3);
    fixture
        .client
        .vote(&fixture.task_id, &voter, &VoteSide::SupportFiler);
    assert_eq!(
        fixture
            .client
            .try_vote(&fixture.task_id, &voter, &VoteSide::SupportAgent),
        Err(Ok(Error::AlreadyVoted))
    );
}

#[test]
fn support_filer_refunds_and_slashes_half_the_agent_bond() {
    let fixture = setup();
    file(&fixture);
    advance_to_voting(&fixture);
    for voter in fixture.voters.iter().take(3) {
        fixture
            .client
            .vote(&fixture.task_id, voter, &VoteSide::SupportFiler);
    }
    for voter in fixture.voters.iter().skip(3) {
        fixture
            .client
            .vote(&fixture.task_id, voter, &VoteSide::SupportAgent);
    }
    advance_to_resolution(&fixture);

    assert_eq!(
        fixture.client.resolve(&fixture.task_id),
        DisputeOutcome::SupportFiler
    );
    let proposed = fixture.client.get_dispute(&fixture.task_id).unwrap();
    assert_eq!(proposed.status, DisputeStatus::AppealPending);
    assert!(proposed.appeal_deadline.is_some());
    assert!(!proposed.appealed);
    assert_eq!(proposed.bond_slashed, 50);
    assert_eq!(fixture.client.get_agent_bond(&fixture.agent), 100);
    assert_eq!(
        fixture.client.try_finalize_dispute(&fixture.task_id),
        Err(Ok(Error::InvalidPhase))
    );
    assert_eq!(
        fixture.client.try_resolve(&fixture.task_id),
        Err(Ok(Error::InvalidPhase))
    );
    advance_to_appeal_finalization(&fixture);
    fixture.client.finalize_dispute(&fixture.task_id);
    let dispute = fixture.client.get_dispute(&fixture.task_id).unwrap();
    assert_eq!(dispute.bond_slashed, 50);
    assert_eq!(fixture.client.get_agent_bond(&fixture.agent), 50);
    assert_eq!(dispute.filer_refund, 1_000);
    assert_eq!(dispute.agent_payment, 0);
    assert_eq!(dispute.status, DisputeStatus::Resolved);
}

#[test]
fn insufficient_votes_return_a_neutral_split_without_penalties() {
    let fixture = setup();
    file(&fixture);
    advance_to_voting(&fixture);
    fixture.client.vote(
        &fixture.task_id,
        &fixture.voters[0],
        &VoteSide::SupportFiler,
    );
    advance_to_resolution(&fixture);

    assert_eq!(
        fixture.client.resolve(&fixture.task_id),
        DisputeOutcome::Tie
    );
    advance_to_appeal_finalization(&fixture);
    fixture.client.finalize_dispute(&fixture.task_id);
    let dispute = fixture.client.get_dispute(&fixture.task_id).unwrap();
    assert_eq!(dispute.filer_refund, 500);
    assert_eq!(dispute.agent_payment, 500);
    assert_eq!(dispute.bond_slashed, 0);
    assert_eq!(fixture.client.get_agent_bond(&fixture.agent), 100);
}

fn setup_with_admin() -> (Env, DisputeResolutionContractClient<'static>, Address) {
    let env = Env::default();
    env.mock_all_auths();
    let contract_id = env.register(DisputeResolutionContract, ());
    let client = DisputeResolutionContractClient::new(&env, &contract_id);
    let admin = Address::generate(&env);
    client.initialize(&admin);
    (env, client, admin)
}

#[test]
fn negative_auth_initialize() {
    let env = Env::default();
    env.mock_auths(&[]);
    let contract_id = env.register(DisputeResolutionContract, ());
    let client = DisputeResolutionContractClient::new(&env, &contract_id);
    let admin = Address::generate(&env);
    assert!(client.try_initialize(&admin).is_err());
}

#[test]
fn appeal_reopens_voting_and_reverses_provisional_slash() {
    let fixture = setup();
    file(&fixture);
    assert_eq!(
        fixture
            .registry
            .try_initiate_bond_return(&fixture.registry_agent_id),
        Err(Ok(agent_registry::Error::DisputePending))
    );
    advance_to_voting(&fixture);
    for voter in fixture.voters.iter().take(3) {
        fixture
            .client
            .vote(&fixture.task_id, voter, &VoteSide::SupportFiler);
    }
    for voter in fixture.voters.iter().skip(3) {
        fixture
            .client
            .vote(&fixture.task_id, voter, &VoteSide::SupportAgent);
    }
    advance_to_resolution(&fixture);
    assert_eq!(
        fixture.client.resolve(&fixture.task_id),
        DisputeOutcome::SupportFiler
    );
    assert_eq!(
        fixture
            .client
            .try_appeal_dispute(&fixture.task_id, &fixture.filer),
        Err(Ok(Error::Unauthorized))
    );
    fixture
        .client
        .appeal_dispute(&fixture.task_id, &fixture.agent);

    for voter in fixture.voters.iter().take(3) {
        fixture
            .client
            .vote(&fixture.task_id, voter, &VoteSide::SupportAgent);
    }
    for voter in fixture.voters.iter().skip(3) {
        fixture
            .client
            .vote(&fixture.task_id, voter, &VoteSide::SupportFiler);
    }
    fixture.env.ledger().with_mut(|ledger| {
        ledger.timestamp += VOTING_PHASE;
    });
    assert_eq!(
        fixture.client.resolve(&fixture.task_id),
        DisputeOutcome::SupportAgent
    );
    let dispute = fixture.client.get_dispute(&fixture.task_id).unwrap();
    assert_eq!(dispute.status, DisputeStatus::Resolved);
    assert_eq!(dispute.bond_slashed, 0);
    assert_eq!(fixture.client.get_agent_bond(&fixture.agent), 100);
    assert_eq!(dispute.agent_payment, 1_000);
    fixture
        .registry
        .initiate_bond_return(&fixture.registry_agent_id);
}

#[test]
fn finalized_verified_dispute_slashes_registry_bond_with_reason() {
    let fixture = setup();
    file(&fixture);
    advance_to_voting(&fixture);
    for voter in fixture.voters.iter().take(3) {
        fixture
            .client
            .vote(&fixture.task_id, voter, &VoteSide::SupportFiler);
    }
    advance_to_resolution(&fixture);
    fixture.client.resolve(&fixture.task_id);
    advance_to_appeal_finalization(&fixture);
    fixture.client.finalize_dispute(&fixture.task_id);

    let bond = fixture
        .registry
        .get_bond(&fixture.registry_agent_id)
        .unwrap();
    assert_eq!(bond.amount_stroops, 50);
    assert_eq!(bond.status, agent_registry::bond::BondStatus::Active);
}

#[test]
fn negative_auth_set_admin() {
    let fixture = setup();
    let intruder = Address::generate(&fixture.env);
    fixture.env.mock_auths(&[]);
    assert!(fixture.client.try_set_admin(&intruder).is_err());
}

#[test]
fn evidence_index_zero_survives_submission() {
    let fixture = setup();
    file(&fixture);

    let hash0 = BytesN::from_array(&fixture.env, &[1u8; 32]);
    let hash1 = BytesN::from_array(&fixture.env, &[2u8; 32]);
    let hash2 = BytesN::from_array(&fixture.env, &[3u8; 32]);

    // Submit 3 pieces of evidence
    let id0 = fixture
        .client
        .submit_evidence(&fixture.task_id, &fixture.filer, &hash0);
    let id1 = fixture
        .client
        .submit_evidence(&fixture.task_id, &fixture.agent, &hash1);
    let id2 = fixture
        .client
        .submit_evidence(&fixture.task_id, &fixture.filer, &hash2);

    // Verify evidence IDs are sequential
    assert_eq!(id0, 0);
    assert_eq!(id1, 1);
    assert_eq!(id2, 2);

    // Verify count is correct
    assert_eq!(fixture.client.get_evidence_count(&fixture.task_id), 3);

    // CRITICAL: Verify evidence #0 is retrievable and has correct data
    let evidence0 = fixture.client.get_evidence(&fixture.task_id, &0).unwrap();
    assert_eq!(evidence0.evidence_id, 0);
    assert_eq!(evidence0.evidence_hash, hash0);
    assert_eq!(evidence0.submitter, fixture.filer);
    assert_eq!(evidence0.dispute_id, fixture.task_id);

    // Verify evidence #1 and #2 are also retrievable
    let evidence1 = fixture.client.get_evidence(&fixture.task_id, &1).unwrap();
    assert_eq!(evidence1.evidence_id, 1);
    assert_eq!(evidence1.evidence_hash, hash1);
    assert_eq!(evidence1.submitter, fixture.agent);

    let evidence2 = fixture.client.get_evidence(&fixture.task_id, &2).unwrap();
    assert_eq!(evidence2.evidence_id, 2);
    assert_eq!(evidence2.evidence_hash, hash2);
    assert_eq!(evidence2.submitter, fixture.filer);
}

fn setup_with_admin() -> (Env, DisputeResolutionContractClient<'static>, Address) {
    let env = Env::default();
    env.mock_all_auths();
    let contract_id = env.register(DisputeResolutionContract, ());
    let client = DisputeResolutionContractClient::new(&env, &contract_id);
    let admin = Address::generate(&env);
    client.initialize(&admin);
    (env, client, admin)
}

// ========================================================================
// Negative Authorization Tests (Issue #549)
// ========================================================================

#[test]
fn negative_auth_set_admin() {
    let (env, client, _admin) = setup_with_admin();
    let intruder = Address::generate(&env);
    env.mock_auths(&[]);
    assert_eq!(
        client.try_set_admin(&intruder),
        Err(Ok(Error::Unauthorized))
    );
}

#[test]
fn negative_auth_pause() {
    let (env, client, _admin) = setup_with_admin();
    env.mock_auths(&[]);
    assert_eq!(client.try_pause(), Err(Ok(Error::Unauthorized)));
}

#[test]
fn negative_auth_unpause() {
    let (env, client, admin) = setup_with_admin();
    client.pause();
    env.mock_auths(&[]);
    assert_eq!(client.try_unpause(), Err(Ok(Error::Unauthorized)));
}

#[test]
fn negative_auth_set_voters() {
    let (env, client, _admin) = setup_with_admin();
    let voters = soroban_sdk::vec![&env, Address::generate(&env)];
    env.mock_auths(&[]);
    assert_eq!(client.try_set_voters(&voters), Err(Ok(Error::Unauthorized)));
}

#[test]
fn negative_auth_set_reputation() {
    let (env, client, _admin) = setup_with_admin();
    let account = Address::generate(&env);
    env.mock_auths(&[]);
    assert_eq!(
        client.try_set_reputation(&account, &50),
        Err(Ok(Error::Unauthorized))
    );
}

#[test]
fn negative_auth_set_agent_bond() {
    let (env, client, _admin) = setup_with_admin();
    let agent = Address::generate(&env);
    env.mock_auths(&[]);
    assert_eq!(
        client.try_set_agent_bond(&agent, &100),
        Err(Ok(Error::Unauthorized))
    );
}

#[test]
fn negative_auth_set_task_escrow() {
    let (env, client, _admin) = setup_with_admin();
    let task_id = Symbol::new(&env, "task1");
    env.mock_auths(&[]);
    assert_eq!(
        client.try_set_task_escrow(&task_id, &1000),
        Err(Ok(Error::Unauthorized))
    );
}

/// Force a dispute into `status` with ledger time positioned relative to its
/// voting deadline (`offset` of -1, 0 or +1 seconds).
fn force_state(fixture: &Fixture, status: DisputeStatus, offset: i64) {
    let mut dispute = fixture.client.get_dispute(&fixture.task_id).unwrap();
    dispute.status = status.clone();
    if status == DisputeStatus::AppealPending {
        dispute.resolution = Some(0);
        dispute.appeal_deadline = Some(dispute.voting_deadline + APPEAL_PHASE);
    }
    let deadline = dispute.voting_deadline;
    let contract_id = fixture.client.address.clone();
    fixture.env.as_contract(&contract_id, || save_dispute(&fixture.env, &dispute));
    fixture.env.ledger().with_mut(|ledger| {
        ledger.timestamp = (deadline as i64 + offset) as u64;
    });
}

const STATES: [DisputeStatus; 5] = [
    DisputeStatus::Filed,
    DisputeStatus::EvidencePhase,
    DisputeStatus::Voting,
    DisputeStatus::Resolved,
    DisputeStatus::AppealPending,
];
const OFFSETS: [i64; 3] = [-1, 0, 1];

#[test]
fn resolve_state_time_matrix() {
    for status in STATES.iter() {
        for offset in OFFSETS.iter() {
            let fixture = setup();
            file(&fixture);
            force_state(&fixture, status.clone(), *offset);
            let expected: Result<(), Error> = match status {
                DisputeStatus::Resolved => Err(Error::DisputeAlreadyResolved),
                DisputeStatus::AppealPending => Err(Error::InvalidPhase),
                _ if *offset < 0 => Err(Error::VotingStillOpen),
                _ => Ok(()),
            };
            let actual = match fixture.client.try_resolve(&fixture.task_id) {
                Ok(_) => Ok(()),
                Err(Ok(e)) => Err(e),
                Err(Err(_)) => panic!("unexpected host error"),
            };
            assert_eq!(actual, expected, "status={:?} offset={}", status, offset);
        }
    }
}

#[test]
fn appeal_state_time_matrix() {
    for status in STATES.iter() {
        for offset in OFFSETS.iter() {
            let fixture = setup();
            file(&fixture);
            force_state(&fixture, status.clone(), *offset);
            let expected: Result<(), Error> = match status {
                DisputeStatus::Filed | DisputeStatus::EvidencePhase | DisputeStatus::Voting => {
                    Err(Error::NotResolved)
                }
                DisputeStatus::Resolved => Err(Error::DisputeAlreadyResolved),
                DisputeStatus::AppealPending => Ok(()),
            };
            let actual = match fixture
                .client
                .try_appeal_dispute(&fixture.task_id, &fixture.agent)
            {
                Ok(_) => Ok(()),
                Err(Ok(e)) => Err(e),
                Err(Err(_)) => panic!("unexpected host error"),
            };
            assert_eq!(actual, expected, "status={:?} offset={}", status, offset);
        }
    }
}
