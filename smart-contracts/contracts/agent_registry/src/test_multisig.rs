#![cfg(test)]

use crate::{
    AdminAction, AgentRegistryContract, AgentRegistryContractClient, Error,
    DEFAULT_PROPOSAL_EXPIRY, DEFAULT_TIMELOCK_DELAY,
};
use soroban_sdk::{
    testutils::{Address as _, Ledger},
    Address, Env, Vec,
};

fn setup_test_env() -> (
    Env,
    AgentRegistryContractClient<'static>,
    Address,
    Address,
    Address,
) {
    let env = Env::default();
    env.mock_all_auths();

    let contract_id = env.register(AgentRegistryContract, ());
    let client = AgentRegistryContractClient::new(&env, &contract_id);

    let admin1 = Address::generate(&env);
    let admin2 = Address::generate(&env);
    let admin3 = Address::generate(&env);

    client.initialize(&admin1);

    (env, client, admin1, admin2, admin3)
}

#[test]
fn test_multisig_config_and_proposal_creation() {
    let (env, client, admin1, admin2, admin3) = setup_test_env();

    let mut admins = Vec::new(&env);
    admins.push_back(admin1.clone());
    admins.push_back(admin2.clone());
    admins.push_back(admin3.clone());

    // Config: 2-of-3 multisig with 24h timelock delay
    client.set_multisig_config(&admin1, &admins, &2, &DEFAULT_TIMELOCK_DELAY);

    let config = client.get_multisig_config().unwrap();
    assert_eq!(config.threshold, 2);
    assert_eq!(config.timelock_delay, DEFAULT_TIMELOCK_DELAY);
    assert_eq!(config.admins.len(), 3);

    // Propose Pause operation
    let proposal_id = client.propose_operation(&admin1, &AdminAction::Pause, &None);
    assert_eq!(proposal_id, 1);

    let proposal = client.get_proposal(&1);
    assert_eq!(proposal.proposer, admin1);
    assert_eq!(proposal.action, AdminAction::Pause);
    assert_eq!(proposal.approvals.len(), 1);
    assert!(!proposal.executed);
    assert!(!proposal.cancelled);
    assert_eq!(proposal.eta, proposal.created_at + DEFAULT_TIMELOCK_DELAY);
    assert_eq!(
        proposal.expires_at,
        proposal.created_at + DEFAULT_PROPOSAL_EXPIRY
    );
}

#[test]
fn test_proposal_approval_and_threshold() {
    let (env, client, admin1, admin2, admin3) = setup_test_env();

    let mut admins = Vec::new(&env);
    admins.push_back(admin1.clone());
    admins.push_back(admin2.clone());
    admins.push_back(admin3.clone());

    client.set_multisig_config(&admin1, &admins, &2, &DEFAULT_TIMELOCK_DELAY);

    let proposal_id = client.propose_operation(&admin1, &AdminAction::Pause, &None);

    // Approve by admin2
    client.approve_operation(&admin2, &proposal_id);

    let proposal = client.get_proposal(&proposal_id);
    assert_eq!(proposal.approvals.len(), 2);
    assert!(proposal.approvals.contains(&admin1));
    assert!(proposal.approvals.contains(&admin2));

    // Duplicate approval should fail
    let res = client.try_approve_operation(&admin2, &proposal_id);
    assert_eq!(res, Err(Ok(Error::AlreadyApproved)));
}

#[test]
fn test_timelock_enforcement_and_execution() {
    let (env, client, admin1, admin2, admin3) = setup_test_env();

    let mut admins = Vec::new(&env);
    admins.push_back(admin1.clone());
    admins.push_back(admin2.clone());
    admins.push_back(admin3.clone());

    client.set_multisig_config(&admin1, &admins, &2, &DEFAULT_TIMELOCK_DELAY);

    let proposal_id = client.propose_operation(&admin1, &AdminAction::Pause, &None);
    client.approve_operation(&admin2, &proposal_id);

    // Trying to execute before timelock elapses should fail
    let res_before = client.try_execute_operation(&admin1, &proposal_id);
    assert_eq!(res_before, Err(Ok(Error::TimelockNotElapsed)));

    // Advance timestamp past timelock
    let proposal = client.get_proposal(&proposal_id);
    env.ledger().set_timestamp(proposal.eta + 1);

    // Execute proposal
    client.execute_operation(&admin1, &proposal_id);

    assert!(client.is_paused());

    let updated_proposal = client.get_proposal(&proposal_id);
    assert!(updated_proposal.executed);

    // Re-execution should fail
    let res_after = client.try_execute_operation(&admin1, &proposal_id);
    assert_eq!(res_after, Err(Ok(Error::ProposalAlreadyExecuted)));
}

#[test]
fn test_proposal_expiry() {
    let (env, client, admin1, admin2, admin3) = setup_test_env();

    let mut admins = Vec::new(&env);
    admins.push_back(admin1.clone());
    admins.push_back(admin2.clone());
    admins.push_back(admin3.clone());

    client.set_multisig_config(&admin1, &admins, &2, &DEFAULT_TIMELOCK_DELAY);

    let proposal_id = client.propose_operation(&admin1, &AdminAction::Pause, &Some(3600));
    client.approve_operation(&admin2, &proposal_id);

    let proposal = client.get_proposal(&proposal_id);
    // Advance timestamp past expiry
    env.ledger().set_timestamp(proposal.expires_at + 1);

    let res = client.try_execute_operation(&admin1, &proposal_id);
    assert_eq!(res, Err(Ok(Error::ProposalExpired)));
}

#[test]
fn test_proposal_cancellation() {
    let (env, client, admin1, admin2, admin3) = setup_test_env();

    let mut admins = Vec::new(&env);
    admins.push_back(admin1.clone());
    admins.push_back(admin2.clone());
    admins.push_back(admin3.clone());

    client.set_multisig_config(&admin1, &admins, &2, &DEFAULT_TIMELOCK_DELAY);

    let proposal_id = client.propose_operation(&admin1, &AdminAction::Pause, &None);

    // Cancel proposal by proposer
    client.cancel_operation(&admin1, &proposal_id);

    let proposal = client.get_proposal(&proposal_id);
    assert!(proposal.cancelled);

    let res = client.try_execute_operation(&admin1, &proposal_id);
    assert_eq!(res, Err(Ok(Error::ProposalAlreadyCancelled)));
}

#[test]
fn test_admin_set_via_multisig() {
    let (env, client, admin1, admin2, admin3) = setup_test_env();

    let new_admin = Address::generate(&env);
    let mut admins = Vec::new(&env);
    admins.push_back(admin1.clone());
    admins.push_back(admin2.clone());
    admins.push_back(admin3.clone());

    client.set_multisig_config(&admin1, &admins, &2, &DEFAULT_TIMELOCK_DELAY);

    // Single-signature set_admin should fail when multi-sig is configured
    let direct_res = client.try_set_admin(&new_admin);
    assert_eq!(direct_res, Err(Ok(Error::Unauthorized)));

    // Propose SetAdmin via multi-sig
    let proposal_id =
        client.propose_operation(&admin1, &AdminAction::SetAdmin(new_admin.clone()), &None);
    client.approve_operation(&admin2, &proposal_id);

    let proposal = client.get_proposal(&proposal_id);
    env.ledger().set_timestamp(proposal.eta + 1);

    client.execute_operation(&admin1, &proposal_id);

    assert_eq!(client.get_admin(), Some(new_admin));
}
