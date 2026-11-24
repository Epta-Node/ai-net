//! Tests for the timelock-governed upgrade manager (issue #488).
//!
//! Structure mirrors `agent_registry::test_multisig` so the two contracts stay
//! idiomatic with each other.
//!
//! IMPORTANT SCOPE NOTE: `update_current_contract_wasm` is gated behind
//! `#[cfg(all(target_arch = "wasm32", not(any(test, feature = "testutils"))))]`.
//! These tests therefore verify **governance bookkeeping only** — they cannot
//! observe a real WASM swap. That is verifiable on-chain, or by confirming the
//! crate builds for `wasm32v1-none`.

#![cfg(test)]

use crate::{
    upgradeable::{mock_swap_calls, stored_wasm_hash},
    DataKey, MigrationPlan, ProposalStatus, UpgradeError, UpgradeManager, UpgradeManagerClient,
    DEFAULT_PROPOSAL_EXPIRY, DEFAULT_THRESHOLD, DEFAULT_TIMELOCK_DELAY, GAS_MIGRATION_PER_ITEM,
    GAS_MIGRATION_STEP_OVERHEAD, GAS_UPGRADE_BASE, ROLLBACK_WINDOW_LEDGERS,
};
use soroban_sdk::{
    symbol_short,
    testutils::{Address as _, Events as _, Ledger as _},
    Address, BytesN, Env, IntoVal, String, Vec,
};

struct Fixture {
    env: Env,
    client: UpgradeManagerClient<'static>,
    admin1: Address,
    admin2: Address,
    admin3: Address,
    initial_hash: BytesN<32>,
}

/// 2-of-3 multisig with the default 24h timelock — the configuration every
/// governance test in this file runs under unless it says otherwise.
fn fixture() -> Fixture {
    let env = Env::default();
    env.mock_all_auths();
    env.ledger().set_timestamp(1_000_000);

    let contract_id = env.register(UpgradeManager, ());
    let client = UpgradeManagerClient::new(&env, &contract_id);

    let admin1 = Address::generate(&env);
    let admin2 = Address::generate(&env);
    let admin3 = Address::generate(&env);
    let initial_hash = test_wasm_hash(&env, 1);

    client.initialize(&admin1, &String::from_str(&env, "1.0.0"), &initial_hash);

    let admins = Vec::from_array(&env, [admin1.clone(), admin2.clone(), admin3.clone()]);
    client.set_multisig_config(&admins, &2, &DEFAULT_TIMELOCK_DELAY);

    Fixture {
        env,
        client,
        admin1,
        admin2,
        admin3,
        initial_hash,
    }
}

fn test_wasm_hash(env: &Env, seed: u8) -> BytesN<32> {
    let mut bytes = [0u8; 32];
    bytes[0] = seed;
    BytesN::from_array(env, &bytes)
}

fn plan(env: &Env, items: u32) -> MigrationPlan {
    MigrationPlan {
        pre_migration_checks: Vec::new(env),
        data_transformations: Vec::new(env),
        post_migration_validations: Vec::new(env),
        estimated_items: items,
    }
}

/// Propose, approve, validate — leaves the proposal in PendingTimelock.
fn propose_and_approve(f: &Fixture) -> (u64, BytesN<32>) {
    let new_hash = test_wasm_hash(&f.env, 2);
    let id = f.client.propose_upgrade(
        &f.admin1,
        &String::from_str(&f.env, "2.0.0"),
        &new_hash,
        &String::from_str(&f.env, "Major upgrade"),
        &plan(&f.env, 10),
    );
    f.client.approve_upgrade(&f.admin2, &id);
    f.client.validate_proposal(&f.admin1, &id);
    (id, new_hash)
}

/// Advance the ledger clock so a pending timelock has elapsed.
fn pass_timelock(f: &Fixture, id: u64) {
    let proposal = f.client.get_proposal(&id).unwrap();
    f.env.ledger().set_timestamp(proposal.eta);
}

// ─── 1. Multisig configuration ───────────────────────────────────────────────

#[test]
fn test_multisig_config_round_trips() {
    let f = fixture();
    let cfg = f.client.get_multisig_config().unwrap();
    assert_eq!(cfg.threshold, 2);
    assert_eq!(cfg.timelock_delay, DEFAULT_TIMELOCK_DELAY);
    assert_eq!(cfg.admins.len(), 3);
}

#[test]
fn test_multisig_config_rejects_invalid_threshold() {
    let f = fixture();
    let admins = Vec::from_array(&f.env, [f.admin1.clone(), f.admin2.clone()]);
    // threshold 0
    assert_eq!(
        f.client
            .try_set_multisig_config(&admins, &0, &DEFAULT_TIMELOCK_DELAY)
            .err(),
        Some(Ok(UpgradeError::InvalidMultisigConfig))
    );
    // threshold above signer count
    assert_eq!(
        f.client
            .try_set_multisig_config(&admins, &5, &DEFAULT_TIMELOCK_DELAY)
            .err(),
        Some(Ok(UpgradeError::InvalidMultisigConfig))
    );
    // zero timelock
    assert_eq!(
        f.client.try_set_multisig_config(&admins, &1, &0).err(),
        Some(Ok(UpgradeError::InvalidMultisigConfig))
    );
}

// ─── 2. Proposal creation and the timelock-at-threshold rule ─────────────────

#[test]
fn test_propose_assigns_incrementing_ids_and_starts_below_threshold() {
    let f = fixture();
    let id = f.client.propose_upgrade(
        &f.admin1,
        &String::from_str(&f.env, "2.0.0"),
        &test_wasm_hash(&f.env, 2),
        &String::from_str(&f.env, "first"),
        &plan(&f.env, 1),
    );
    assert_eq!(id, 1);
    assert_eq!(f.client.next_proposal_id(), 2);

    let p = f.client.get_proposal(&1).unwrap();
    assert_eq!(p.proposer, f.admin1);
    // Proposer is implicitly approved, but the 2-of-3 threshold is not met.
    assert_eq!(p.approvals.len(), 1);
    assert_eq!(p.status, ProposalStatus::Proposed);
    // THE KEY ASSERTION: the clock has not started, so no timelock is running.
    assert_eq!(p.eta, 0);
    assert_eq!(p.expires_at, p.created_at + DEFAULT_PROPOSAL_EXPIRY);
}

#[test]
fn test_timelock_starts_when_threshold_is_reached_not_at_propose() {
    let f = fixture();
    let id = f.client.propose_upgrade(
        &f.admin1,
        &String::from_str(&f.env, "2.0.0"),
        &test_wasm_hash(&f.env, 2),
        &String::from_str(&f.env, "first"),
        &plan(&f.env, 1),
    );

    // Let real time pass with the proposal still below threshold. Two full
    // timelocks elapse — more than enough for `agent_registry`'s
    // `eta = created_at + delay` to already be in the past.
    let created_at = f.client.get_proposal(&id).unwrap().created_at;
    f.env
        .ledger()
        .set_timestamp(created_at + DEFAULT_TIMELOCK_DELAY * 2);

    // The final approval starts the clock *now* — not at `created_at`.
    let before = f.env.ledger().timestamp();
    f.client.approve_upgrade(&f.admin2, &id);

    let p = f.client.get_proposal(&id).unwrap();
    assert_eq!(p.status, ProposalStatus::PendingTimelock);
    assert_eq!(p.eta, before + DEFAULT_TIMELOCK_DELAY);
    // Under the propose-time scheme `eta` would be long past, making the
    // proposal instantly executable. This contract's status is not Ready.
    assert_ne!(p.status, ProposalStatus::Ready);
    assert!(p.eta > created_at + DEFAULT_TIMELOCK_DELAY);
}

#[test]
fn test_single_admin_deployment_still_gets_default_timelock() {
    let env = Env::default();
    env.mock_all_auths();
    env.ledger().set_timestamp(1_000_000);
    let cid = env.register(UpgradeManager, ());
    let client = UpgradeManagerClient::new(&env, &cid);
    let admin = Address::generate(&env);
    client.initialize(
        &admin,
        &String::from_str(&env, "1.0.0"),
        &test_wasm_hash(&env, 1),
    );

    // No multisig configured: threshold collapses to 1, so the proposer's own
    // approval starts the clock immediately — but a 24h delay still applies.
    let id = client.propose_upgrade(
        &admin,
        &String::from_str(&env, "2.0.0"),
        &test_wasm_hash(&env, 2),
        &String::from_str(&env, "solo"),
        &plan(&env, 1),
    );
    let p = client.get_proposal(&id).unwrap();
    assert_eq!(p.status, ProposalStatus::PendingTimelock);
    assert_eq!(p.eta, p.created_at + DEFAULT_TIMELOCK_DELAY);
    assert_eq!(DEFAULT_THRESHOLD, 1);
}

#[test]
fn test_propose_rejects_downgrade() {
    let f = fixture();
    let err = f
        .client
        .try_propose_upgrade(
            &f.admin1,
            &String::from_str(&f.env, "0.9.0"),
            &test_wasm_hash(&f.env, 9),
            &String::from_str(&f.env, "down"),
            &plan(&f.env, 1),
        )
        .err();
    assert_eq!(err, Some(Ok(UpgradeError::DowngradeNotAllowed)));
}

// ─── 3. Approvals ────────────────────────────────────────────────────────────

#[test]
fn test_approval_increments_count_and_rejects_duplicates() {
    let f = fixture();
    let id = f.client.propose_upgrade(
        &f.admin1,
        &String::from_str(&f.env, "2.0.0"),
        &test_wasm_hash(&f.env, 2),
        &String::from_str(&f.env, "first"),
        &plan(&f.env, 1),
    );

    f.client.approve_upgrade(&f.admin2, &id);
    let p = f.client.get_proposal(&id).unwrap();
    assert_eq!(p.approvals.len(), 2);
    assert!(p.approvals.contains(&f.admin1));
    assert!(p.approvals.contains(&f.admin2));

    // Duplicate from the same signer is rejected, count unchanged.
    assert_eq!(
        f.client.try_approve_upgrade(&f.admin2, &id).err(),
        Some(Ok(UpgradeError::AlreadyApproved))
    );
    // Including the implicit proposer approval.
    assert_eq!(
        f.client.try_approve_upgrade(&f.admin1, &id).err(),
        Some(Ok(UpgradeError::AlreadyApproved))
    );
    assert_eq!(f.client.get_proposal(&id).unwrap().approvals.len(), 2);
}

#[test]
fn test_third_approval_keeps_first_eta() {
    let f = fixture();
    let id = f.client.propose_upgrade(
        &f.admin1,
        &String::from_str(&f.env, "2.0.0"),
        &test_wasm_hash(&f.env, 2),
        &String::from_str(&f.env, "first"),
        &plan(&f.env, 1),
    );
    f.client.approve_upgrade(&f.admin2, &id);
    let eta = f.client.get_proposal(&id).unwrap().eta;
    assert!(eta > 0);

    f.env.ledger().set_timestamp(eta + 5);
    f.client.approve_upgrade(&f.admin3, &id);

    let p = f.client.get_proposal(&id).unwrap();
    assert_eq!(p.approvals.len(), 3);
    // Reaching threshold is idempotent with respect to the clock: a late extra
    // approval must not extend or shorten an already-running timelock.
    assert_eq!(p.eta, eta);
}

// ─── 4. Execution gating ─────────────────────────────────────────────────────

#[test]
fn test_execute_blocked_before_timelock_elapses() {
    let f = fixture();
    let (id, _) = propose_and_approve(&f);
    assert_eq!(
        f.client.try_execute_upgrade(&f.admin1, &id).err(),
        Some(Ok(UpgradeError::TimelockNotElapsed))
    );
}

#[test]
fn test_execute_blocked_below_approval_threshold() {
    let f = fixture();
    let id = f.client.propose_upgrade(
        &f.admin1,
        &String::from_str(&f.env, "2.0.0"),
        &test_wasm_hash(&f.env, 2),
        &String::from_str(&f.env, "first"),
        &plan(&f.env, 1),
    );
    // Far from the expiry window, so expiry is not what blocks it — the
    // approval count is.
    assert_eq!(
        f.client.try_execute_upgrade(&f.admin1, &id).err(),
        Some(Ok(UpgradeError::InsufficientApprovals))
    );
}

#[test]
fn test_execute_blocked_when_expired() {
    let f = fixture();
    let (id, _) = propose_and_approve(&f);
    let p = f.client.get_proposal(&id).unwrap();
    f.env.ledger().set_timestamp(p.expires_at + 1);
    assert_eq!(
        f.client.try_execute_upgrade(&f.admin1, &id).err(),
        Some(Ok(UpgradeError::ProposalExpired))
    );
}

#[test]
fn test_execute_blocked_when_not_validated() {
    let f = fixture();
    let id = f.client.propose_upgrade(
        &f.admin1,
        &String::from_str(&f.env, "2.0.0"),
        &test_wasm_hash(&f.env, 2),
        &String::from_str(&f.env, "first"),
        &plan(&f.env, 1),
    );
    f.client.approve_upgrade(&f.admin2, &id);
    pass_timelock(&f, id);
    assert_eq!(
        f.client.try_execute_upgrade(&f.admin1, &id).err(),
        Some(Ok(UpgradeError::ProposalNotValidated))
    );
}

#[test]
fn test_execute_unknown_proposal() {
    let f = fixture();
    assert_eq!(
        f.client.try_execute_upgrade(&f.admin1, &99).err(),
        Some(Ok(UpgradeError::NoProposal))
    );
}

// ─── 5. Happy path + events ──────────────────────────────────────────────────

#[test]
fn test_full_lifecycle_propose_approve_timelock_execute() {
    let f = fixture();
    let (id, new_hash) = propose_and_approve(&f);

    assert_eq!(
        f.client.get_proposal(&id).unwrap().status,
        ProposalStatus::PendingTimelock
    );
    pass_timelock(&f, id);
    assert_eq!(
        f.client.get_proposal(&id).unwrap().status,
        ProposalStatus::Ready
    );

    f.client.execute_upgrade(&f.admin1, &id);
    // `events().all()` only reflects the last invocation (execute_upgrade),
    // which must have emitted the `applied` event.
    let applied = (symbol_short!("upgrade"), symbol_short!("applied")).into_val(&f.env);
    assert!(f
        .env
        .events()
        .all()
        .iter()
        .any(|(_, topics, _)| topics == applied));

    // The test host retains only the most recent invocation's event buffer, so
    // read it before any further contract call. These are the applied event.
    let events = f.env.events().all();
    assert_eq!(
        events.len(),
        1,
        "expected the applied event from execute_upgrade, got {}",
        events.len()
    );

    let v = f.client.get_current_version().unwrap();
    assert_eq!(v.version, String::from_str(&f.env, "2.0.0"));
    assert_eq!(v.wasm_hash, new_hash);

    let p = f.client.get_proposal(&id).unwrap();
    assert_eq!(p.status, ProposalStatus::Executed);
    // Previous state captured for rollback.
    assert_eq!(p.previous_wasm_hash, f.initial_hash);
    assert_eq!(p.previous_version, String::from_str(&f.env, "1.0.0"));

    // Re-execution is refused.
    assert_eq!(
        f.client.try_execute_upgrade(&f.admin1, &id).err(),
        Some(Ok(UpgradeError::ProposalAlreadyExecuted))
    );
}

#[test]
fn test_concurrent_proposals_are_independent() {
    // Guards the per-proposal storage layout: the pre-#488 contract had a
    // single DataKey::Proposal slot, so a second proposal overwrote the first.
    let f = fixture();
    let id1 = f.client.propose_upgrade(
        &f.admin1,
        &String::from_str(&f.env, "2.0.0"),
        &test_wasm_hash(&f.env, 2),
        &String::from_str(&f.env, "first"),
        &plan(&f.env, 1),
    );
    let id2 = f.client.propose_upgrade(
        &f.admin2,
        &String::from_str(&f.env, "3.0.0"),
        &test_wasm_hash(&f.env, 3),
        &String::from_str(&f.env, "second"),
        &plan(&f.env, 1),
    );
    assert_ne!(id1, id2);
    assert_eq!(
        f.client.get_proposal(&id1).unwrap().description,
        String::from_str(&f.env, "first")
    );
    assert_eq!(
        f.client.get_proposal(&id2).unwrap().description,
        String::from_str(&f.env, "second")
    );
}

// ─── 6. Rollback ─────────────────────────────────────────────────────────────

#[test]
fn test_rollback_within_window_restores_previous_version() {
    let f = fixture();
    let (id, _) = propose_and_approve(&f);
    pass_timelock(&f, id);
    f.client.execute_upgrade(&f.admin1, &id);

    assert!(f.client.can_rollback(&id));

    f.client.rollback_upgrade(&f.admin1, &id);

    let v = f.client.get_current_version().unwrap();
    assert_eq!(v.version, String::from_str(&f.env, "1.0.0"));
    assert_eq!(v.wasm_hash, f.initial_hash);
    assert_eq!(
        f.client.get_proposal(&id).unwrap().status,
        ProposalStatus::RolledBack
    );

    // Single-use.
    assert!(!f.client.can_rollback(&id));
    assert_eq!(
        f.client.try_rollback_upgrade(&f.admin1, &id).err(),
        Some(Ok(UpgradeError::NoRollbackAvailable))
    );
}

#[test]
fn test_rollback_after_deadline_is_rejected() {
    let f = fixture();
    let (id, _) = propose_and_approve(&f);
    pass_timelock(&f, id);
    f.client.execute_upgrade(&f.admin1, &id);

    f.env
        .ledger()
        .set_sequence_number(f.env.ledger().sequence() + ROLLBACK_WINDOW_LEDGERS + 1);

    assert_eq!(
        f.client.try_rollback_upgrade(&f.admin1, &id).err(),
        Some(Ok(UpgradeError::RollbackDeadlineExpired))
    );
    // The upgrade stands.
    assert_eq!(
        f.client.get_current_version().unwrap().version,
        String::from_str(&f.env, "2.0.0")
    );
}

#[test]
fn test_rollback_requires_an_executed_proposal() {
    let f = fixture();
    let (id, _) = propose_and_approve(&f);
    pass_timelock(&f, id);
    // Not executed yet -> nothing to roll back.
    assert_eq!(
        f.client.try_rollback_upgrade(&f.admin1, &id).err(),
        Some(Ok(UpgradeError::NoRollbackAvailable))
    );
}

// ─── 7. Non-admin rejection at every gate ────────────────────────────────────

#[test]
fn test_non_governance_member_cannot_propose_approve_execute_or_rollback() {
    let f = fixture();
    let stranger = Address::generate(&f.env);

    let id = f.client.propose_upgrade(
        &f.admin1,
        &String::from_str(&f.env, "2.0.0"),
        &test_wasm_hash(&f.env, 2),
        &String::from_str(&f.env, "first"),
        &plan(&f.env, 1),
    );
    assert_eq!(
        f.client
            .try_propose_upgrade(
                &stranger,
                &String::from_str(&f.env, "9.0.0"),
                &test_wasm_hash(&f.env, 9),
                &String::from_str(&f.env, "hostile"),
                &plan(&f.env, 1)
            )
            .err(),
        Some(Ok(UpgradeError::Unauthorized))
    );
    assert_eq!(
        f.client.try_approve_upgrade(&stranger, &id).err(),
        Some(Ok(UpgradeError::Unauthorized))
    );
    assert_eq!(
        f.client.try_execute_upgrade(&stranger, &id).err(),
        Some(Ok(UpgradeError::Unauthorized))
    );
    assert_eq!(
        f.client.try_rollback_upgrade(&stranger, &id).err(),
        Some(Ok(UpgradeError::Unauthorized))
    );
    assert_eq!(
        f.client.try_validate_proposal(&stranger, &id).err(),
        Some(Ok(UpgradeError::Unauthorized))
    );
    assert_eq!(
        f.client.try_sweep_expired_proposals(&stranger).err(),
        Some(Ok(UpgradeError::Unauthorized))
    );
}

#[test]
fn test_unsigned_caller_cannot_execute() {
    let f = fixture();
    let (id, _) = propose_and_approve(&f);
    pass_timelock(&f, id);

    // Withdraw auths: require_auth() fails, proving the signature is enforced
    // and not merely the membership list.
    f.env.mock_auths(&[]);
    let result = f.client.try_execute_upgrade(&f.admin1, &id);
    f.env.mock_all_auths();
    assert!(result.is_err());
}

#[test]
fn test_unsigned_caller_cannot_change_multisig_or_admin() {
    let f = fixture();
    let admins = Vec::from_array(&f.env, [f.admin1.clone()]);

    f.env.mock_auths(&[]);
    let r1 = f
        .client
        .try_set_multisig_config(&admins, &1, &DEFAULT_TIMELOCK_DELAY);
    let r2 = f.client.try_set_admin(&f.admin2);
    f.env.mock_all_auths();

    assert!(r1.is_err());
    assert!(r2.is_err());
}

#[test]
fn test_pause_blocks_every_governance_entry_point() {
    let f = fixture();
    f.client.pause();

    assert_eq!(
        f.client
            .try_propose_upgrade(
                &f.admin1,
                &String::from_str(&f.env, "2.0.0"),
                &test_wasm_hash(&f.env, 2),
                &String::from_str(&f.env, "p"),
                &plan(&f.env, 1)
            )
            .err(),
        Some(Ok(UpgradeError::ContractPaused))
    );
    assert_eq!(
        f.client.try_approve_upgrade(&f.admin2, &1).err(),
        Some(Ok(UpgradeError::ContractPaused))
    );
    assert_eq!(
        f.client.try_execute_upgrade(&f.admin1, &1).err(),
        Some(Ok(UpgradeError::ContractPaused))
    );
}

// ─── 8. Expiry sweep ─────────────────────────────────────────────────────────

#[test]
fn test_sweep_expired_proposals() {
    let f = fixture();
    let stale = f.client.propose_upgrade(
        &f.admin1,
        &String::from_str(&f.env, "2.0.0"),
        &test_wasm_hash(&f.env, 2),
        &String::from_str(&f.env, "stale"),
        &plan(&f.env, 1),
    );
    let stale_expiry = f.client.get_proposal(&stale).unwrap().expires_at;

    // Age past `stale`'s expiry, then file a proposal that is still live.
    f.env.ledger().set_timestamp(stale_expiry + 1);
    let fresh = f.client.propose_upgrade(
        &f.admin2,
        &String::from_str(&f.env, "3.0.0"),
        &test_wasm_hash(&f.env, 3),
        &String::from_str(&f.env, "fresh"),
        &plan(&f.env, 1),
    );
    assert!(f.client.get_proposal(&fresh).unwrap().expires_at > f.env.ledger().timestamp());

    assert_eq!(f.client.sweep_expired_proposals(&f.admin1), 1);
    assert_eq!(
        f.client.get_proposal(&stale).unwrap().status,
        ProposalStatus::Expired
    );
    assert_eq!(
        f.client.get_proposal(&fresh).unwrap().status,
        ProposalStatus::Proposed
    );

    // A swept proposal can no longer be approved or executed.
    assert_eq!(
        f.client.try_approve_upgrade(&f.admin3, &stale).err(),
        Some(Ok(UpgradeError::ProposalExpired))
    );
    assert_eq!(
        f.client.try_execute_upgrade(&f.admin1, &stale).err(),
        Some(Ok(UpgradeError::ProposalExpired))
    );
}

#[test]
fn test_sweep_leaves_executed_proposals_alone() {
    let f = fixture();
    let (id, _) = propose_and_approve(&f);
    pass_timelock(&f, id);
    f.client.execute_upgrade(&f.admin1, &id);

    let p = f.client.get_proposal(&id).unwrap();
    f.env.ledger().set_timestamp(p.expires_at + 1);

    assert_eq!(f.client.sweep_expired_proposals(&f.admin1), 0);
    assert_eq!(
        f.client.get_proposal(&id).unwrap().status,
        ProposalStatus::Executed
    );
}

// ─── 9. Storage layout ───────────────────────────────────────────────────────

#[test]
fn test_proposals_are_stored_per_id() {
    let f = fixture();
    let id = f.client.propose_upgrade(
        &f.admin1,
        &String::from_str(&f.env, "2.0.0"),
        &test_wasm_hash(&f.env, 2),
        &String::from_str(&f.env, "first"),
        &plan(&f.env, 1),
    );
    f.env.as_contract(&f.client.address, || {
        assert!(f.env.storage().persistent().has(&DataKey::Proposal(id)));
        assert!(!f.env.storage().persistent().has(&DataKey::Proposal(id + 1)));
    });
}

// ─── 10. Gas snapshots (issue #932) ──────────────────────────────────────────
//
// Each governance hot path is measured in isolation (`reset` immediately before
// the call) and compared against `smart-contracts/gas-baselines.json` within the
// file's tolerance. `propose_upgrade` is the entry point that schedules an
// upgrade. Record intentional cost changes with:
//
//     UPDATE_GAS_BASELINES=1 cargo test -p upgrade-manager --lib gas_snapshot

mod gas_snapshot {
    use super::*;
    use contract_test_utils::gas::{assert_snapshot, reset};

    const CONTRACT: &str = "upgrade_manager";

    fn schedule(f: &Fixture) -> u64 {
        f.client.propose_upgrade(
            &f.admin1,
            &String::from_str(&f.env, "2.0.0"),
            &test_wasm_hash(&f.env, 2),
            &String::from_str(&f.env, "Major upgrade"),
            &plan(&f.env, 10),
        )
    }

    #[test]
    fn schedule_upgrade_gas_snapshot() {
        let f = fixture();
        reset(&f.env);
        schedule(&f);
        assert_snapshot(&f.env, CONTRACT, "propose_upgrade");
    }

    #[test]
    fn execute_upgrade_gas_snapshot() {
        let f = fixture();
        let (id, _) = propose_and_approve(&f);
        pass_timelock(&f, id);
        reset(&f.env);
        f.client.execute_upgrade(&f.admin1, &id);
        assert_snapshot(&f.env, CONTRACT, "execute_upgrade");
    }

    #[test]
    fn rollback_upgrade_gas_snapshot() {
        let f = fixture();
        let (id, _) = propose_and_approve(&f);
        pass_timelock(&f, id);
        f.client.execute_upgrade(&f.admin1, &id);
        reset(&f.env);
        f.client.rollback_upgrade(&f.admin1, &id);
        assert_snapshot(&f.env, CONTRACT, "rollback_upgrade");
    }
}
