//! Integration tests for multi-admin role management (issue #940).
//!
//! Tests the new admin management system with majority voting for adding/removing admins.

use agent_governance::{
    AgentGovernanceContract, AgentGovernanceContractClient, Error,
};
use soroban_sdk::{
    testutils::{Address as _, Ledger},
    Address, Env, Vec,
};

fn setup_test_env() -> (Env, AgentGovernanceContractClient<'static>, Address) {
    let env = Env::default();
    env.mock_all_auths();
    env.ledger().set_timestamp(1_000_000);

    let contract_id = env.register(AgentGovernanceContract, ());
    let client = AgentGovernanceContractClient::new(&env, &contract_id);

    let admin = Address::generate(&env);
    client.initialize(&admin);

    (env, client, admin)
}

// ─── Initialization Tests ────────────────────────────────────────────────────

#[test]
fn test_add_admins_to_set_by_initial_admin() {
    let (env, client, admin) = setup_test_env();

    let admin2 = Address::generate(&env);
    let admin3 = Address::generate(&env);

    let mut new_admins = Vec::new(&env);
    new_admins.push_back(admin2.clone());
    new_admins.push_back(admin3.clone());

    client.add_admins_to_set(&new_admins);

    let admin_set = client.get_admin_set().unwrap();
    assert_eq!(admin_set.len(), 3);
    assert!(admin_set.contains(&admin));
    assert!(admin_set.contains(&admin2));
    assert!(admin_set.contains(&admin3));
}

#[test]
fn test_get_admin_set_returns_none_before_initialization() {
    let (_, client, _) = setup_test_env();

    // Before adding admins to set, should return None
    let admin_set = client.get_admin_set();
    assert_eq!(admin_set, None);
}

// ─── Add Admin Tests ─────────────────────────────────────────────────────────

#[test]
fn test_propose_add_admin_creates_proposal() {
    let (env, client, admin) = setup_test_env();

    let admin2 = Address::generate(&env);
    let admin3 = Address::generate(&env);

    let mut new_admins = Vec::new(&env);
    new_admins.push_back(admin2.clone());
    client.add_admins_to_set(&new_admins);

    // Propose adding admin3
    let proposal_id = client.propose_add_admin(&admin, &admin3);
    assert_eq!(proposal_id, 1);

    let proposal = client.get_admin_proposal(&proposal_id).unwrap();
    assert_eq!(proposal.proposer, admin);
    assert_eq!(proposal.target_admin, admin3);
    assert!(proposal.is_add);
    assert_eq!(proposal.approvals.len(), 1);
    assert!(!proposal.executed);
}

#[test]
fn test_add_admin_requires_majority_approval() {
    let (env, client, admin) = setup_test_env();

    let admin2 = Address::generate(&env);
    let admin3 = Address::generate(&env);
    let admin4 = Address::generate(&env);

    let mut new_admins = Vec::new(&env);
    new_admins.push_back(admin2.clone());
    new_admins.push_back(admin3.clone());
    client.add_admins_to_set(&new_admins);

    // Propose adding admin4 (need 2 of 3 admins to approve)
    let proposal_id = client.propose_add_admin(&admin, &admin4);

    let proposal = client.get_admin_proposal(&proposal_id).unwrap();
    assert_eq!(proposal.approvals.len(), 1);
    assert!(!proposal.executed);

    // Second approval should auto-execute
    client.approve_admin_change(&admin2, &proposal_id);

    let updated_proposal = client.get_admin_proposal(&proposal_id).unwrap();
    assert!(updated_proposal.executed);

    let admin_set = client.get_admin_set().unwrap();
    assert_eq!(admin_set.len(), 4);
    assert!(admin_set.contains(&admin4));
}

#[test]
fn test_add_admin_cannot_add_existing_admin() {
    let (env, client, admin) = setup_test_env();

    let admin2 = Address::generate(&env);

    let mut new_admins = Vec::new(&env);
    new_admins.push_back(admin2.clone());
    client.add_admins_to_set(&new_admins);

    // Try to add admin2 again (already in the set)
    let res = client.try_propose_add_admin(&admin, &admin2);
    assert_eq!(res, Err(Ok(Error::AlreadyInitialized)));
}

#[test]
fn test_add_admin_non_admin_cannot_propose() {
    let (env, client, admin) = setup_test_env();

    let admin2 = Address::generate(&env);
    let outsider = Address::generate(&env);

    let mut new_admins = Vec::new(&env);
    new_admins.push_back(admin2.clone());
    client.add_admins_to_set(&new_admins);

    // Outsider tries to propose
    let res = client.try_propose_add_admin(&outsider, &Address::generate(&env));
    assert_eq!(res, Err(Ok(Error::Unauthorized)));
}

// ─── Remove Admin Tests ──────────────────────────────────────────────────────

#[test]
fn test_propose_remove_admin_creates_proposal() {
    let (env, client, admin) = setup_test_env();

    let admin2 = Address::generate(&env);
    let admin3 = Address::generate(&env);

    let mut new_admins = Vec::new(&env);
    new_admins.push_back(admin2.clone());
    new_admins.push_back(admin3.clone());
    client.add_admins_to_set(&new_admins);

    // Propose removing admin3
    let proposal_id = client.propose_remove_admin(&admin, &admin3);
    assert_eq!(proposal_id, 1);

    let proposal = client.get_admin_proposal(&proposal_id).unwrap();
    assert_eq!(proposal.proposer, admin);
    assert_eq!(proposal.target_admin, admin3);
    assert!(!proposal.is_add);
    assert_eq!(proposal.approvals.len(), 1);
    assert!(!proposal.executed);
}

#[test]
fn test_remove_admin_requires_majority_approval() {
    let (env, client, admin) = setup_test_env();

    let admin2 = Address::generate(&env);
    let admin3 = Address::generate(&env);

    let mut new_admins = Vec::new(&env);
    new_admins.push_back(admin2.clone());
    new_admins.push_back(admin3.clone());
    client.add_admins_to_set(&new_admins);

    // Propose removing admin3 (need 2 of 3 to approve)
    let proposal_id = client.propose_remove_admin(&admin, &admin3);

    let proposal = client.get_admin_proposal(&proposal_id).unwrap();
    assert_eq!(proposal.approvals.len(), 1);
    assert!(!proposal.executed);

    // Second approval should auto-execute
    client.approve_admin_change(&admin2, &proposal_id);

    let updated_proposal = client.get_admin_proposal(&proposal_id).unwrap();
    assert!(updated_proposal.executed);

    let admin_set = client.get_admin_set().unwrap();
    assert_eq!(admin_set.len(), 2);
    assert!(!admin_set.contains(&admin3));
    assert!(admin_set.contains(&admin));
    assert!(admin_set.contains(&admin2));
}

#[test]
fn test_remove_admin_cannot_remove_last_admin() {
    let (env, client, admin) = setup_test_env();

    let admin2 = Address::generate(&env);

    let mut new_admins = Vec::new(&env);
    new_admins.push_back(admin2.clone());
    client.add_admins_to_set(&new_admins);

    // Remove admin2, leaving only admin
    let proposal_id = client.propose_remove_admin(&admin, &admin2);
    client.approve_admin_change(&admin2, &proposal_id);

    // Now try to remove the last remaining admin
    let res = client.try_propose_remove_admin(&admin, &admin);
    assert_eq!(res, Err(Ok(Error::InvalidReputation)));
}

#[test]
fn test_remove_admin_cannot_remove_non_admin() {
    let (env, client, admin) = setup_test_env();

    let admin2 = Address::generate(&env);
    let non_admin = Address::generate(&env);

    let mut new_admins = Vec::new(&env);
    new_admins.push_back(admin2.clone());
    client.add_admins_to_set(&new_admins);

    // Try to remove someone who isn't an admin
    let res = client.try_propose_remove_admin(&admin, &non_admin);
    assert_eq!(res, Err(Ok(Error::AgentNotRegistered)));
}

// ─── Approval Tests ──────────────────────────────────────────────────────────

#[test]
fn test_approve_admin_change_duplicate_approval_rejected() {
    let (env, client, admin) = setup_test_env();

    let admin2 = Address::generate(&env);
    let admin3 = Address::generate(&env);

    let mut new_admins = Vec::new(&env);
    new_admins.push_back(admin2.clone());
    new_admins.push_back(admin3.clone());
    client.add_admins_to_set(&new_admins);

    let proposal_id = client.propose_add_admin(&admin, &Address::generate(&env));

    // Proposer already approved implicitly
    let res = client.try_approve_admin_change(&admin, &proposal_id);
    assert_eq!(res, Err(Ok(Error::AlreadyVoted)));
}

#[test]
fn test_approve_admin_change_non_admin_cannot_approve() {
    let (env, client, admin) = setup_test_env();

    let admin2 = Address::generate(&env);
    let outsider = Address::generate(&env);

    let mut new_admins = Vec::new(&env);
    new_admins.push_back(admin2.clone());
    client.add_admins_to_set(&new_admins);

    let proposal_id = client.propose_add_admin(&admin, &Address::generate(&env));

    // Outsider tries to approve
    let res = client.try_approve_admin_change(&outsider, &proposal_id);
    assert_eq!(res, Err(Ok(Error::Unauthorized)));
}

#[test]
fn test_approve_admin_change_invalid_proposal_id() {
    let (env, client, admin) = setup_test_env();

    let admin2 = Address::generate(&env);

    let mut new_admins = Vec::new(&env);
    new_admins.push_back(admin2.clone());
    client.add_admins_to_set(&new_admins);

    // Try to approve non-existent proposal
    let res = client.try_approve_admin_change(&admin, &999);
    assert_eq!(res, Err(Ok(Error::ProposalNotFound)));
}

#[test]
fn test_approve_admin_change_cannot_approve_executed_proposal() {
    let (env, client, admin) = setup_test_env();

    let admin2 = Address::generate(&env);
    let admin3 = Address::generate(&env);

    let mut new_admins = Vec::new(&env);
    new_admins.push_back(admin2.clone());
    client.add_admins_to_set(&new_admins);

    let proposal_id = client.propose_add_admin(&admin, &admin3);

    // Execute by getting majority approval
    client.approve_admin_change(&admin2, &proposal_id);

    // Proposal is already executed, cannot approve again
    let res = client.try_approve_admin_change(&admin3, &proposal_id);
    assert_eq!(res, Err(Ok(Error::ProposalAlreadyExecuted)));
}

// ─── Majority Calculation Tests ──────────────────────────────────────────────

#[test]
fn test_majority_calculation_2_of_2() {
    let (env, client, admin) = setup_test_env();

    let admin2 = Address::generate(&env);
    let admin3 = Address::generate(&env);

    let mut new_admins = Vec::new(&env);
    new_admins.push_back(admin2.clone());
    client.add_admins_to_set(&new_admins);

    // With 2 admins, need 2 (majority of 2 is 2)
    let proposal_id = client.propose_add_admin(&admin, &admin3);

    let proposal = client.get_admin_proposal(&proposal_id).unwrap();
    assert!(!proposal.executed, "Should not execute with 1 of 2");

    client.approve_admin_change(&admin2, &proposal_id);

    let updated_proposal = client.get_admin_proposal(&proposal_id).unwrap();
    assert!(updated_proposal.executed, "Should execute with 2 of 2");
}

#[test]
fn test_majority_calculation_3_of_5() {
    let (env, client, admin) = setup_test_env();

    let admin2 = Address::generate(&env);
    let admin3 = Address::generate(&env);
    let admin4 = Address::generate(&env);
    let admin5 = Address::generate(&env);
    let admin6 = Address::generate(&env);

    let mut new_admins = Vec::new(&env);
    new_admins.push_back(admin2.clone());
    new_admins.push_back(admin3.clone());
    new_admins.push_back(admin4.clone());
    new_admins.push_back(admin5.clone());
    client.add_admins_to_set(&new_admins);

    // With 5 admins, need 3 for majority
    let proposal_id = client.propose_add_admin(&admin, &admin6);

    let proposal = client.get_admin_proposal(&proposal_id).unwrap();
    assert!(!proposal.executed, "Should not execute with 1 of 5");

    client.approve_admin_change(&admin2, &proposal_id);
    let proposal = client.get_admin_proposal(&proposal_id).unwrap();
    assert!(!proposal.executed, "Should not execute with 2 of 5");

    client.approve_admin_change(&admin3, &proposal_id);
    let updated_proposal = client.get_admin_proposal(&proposal_id).unwrap();
    assert!(updated_proposal.executed, "Should execute with 3 of 5");
}

// ─── Edge Cases ──────────────────────────────────────────────────────────────

#[test]
fn test_add_admins_to_set_deduplicates() {
    let (env, client, admin) = setup_test_env();

    let admin2 = Address::generate(&env);

    let mut new_admins = Vec::new(&env);
    new_admins.push_back(admin2.clone());
    new_admins.push_back(admin2.clone()); // Duplicate

    client.add_admins_to_set(&new_admins);

    let admin_set = client.get_admin_set().unwrap();
    assert_eq!(admin_set.len(), 2); // admin + admin2 (no duplicate)
}

#[test]
fn test_concurrent_admin_proposals() {
    let (env, client, admin) = setup_test_env();

    let admin2 = Address::generate(&env);
    let admin3 = Address::generate(&env);
    let admin4 = Address::generate(&env);

    let mut new_admins = Vec::new(&env);
    new_admins.push_back(admin2.clone());
    new_admins.push_back(admin3.clone());
    client.add_admins_to_set(&new_admins);

    // Create multiple proposals
    let proposal_id1 = client.propose_add_admin(&admin, &admin4);
    let proposal_id2 = client.propose_remove_admin(&admin2, &admin3);

    assert_ne!(proposal_id1, proposal_id2);

    // Execute both
    client.approve_admin_change(&admin2, &proposal_id1);
    client.approve_admin_change(&admin3, &proposal_id2);

    let admin_set = client.get_admin_set().unwrap();
    assert_eq!(admin_set.len(), 3); // admin, admin2, admin4 (admin3 removed)
    assert!(admin_set.contains(&admin));
    assert!(admin_set.contains(&admin2));
    assert!(admin_set.contains(&admin4));
    assert!(!admin_set.contains(&admin3));
}
