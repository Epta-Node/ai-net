//! Integration suite for upgrade-manager storage and version history (#765):
//! version registration, semver ordering, non-placeholder history records,
//! authorized vs unauthorized upgrades, paused-state behaviour and rollback.

use core::cmp::Ordering;
use soroban_sdk::{
    testutils::{Address as _, Ledger as _, MockAuth, MockAuthInvoke},
    Address, BytesN, Env, IntoVal, InvokeError, String, Vec,
};
use upgrade_manager::{
    mock_swap_calls, stored_wasm_hash, strutil::compare_versions, ContractVersion, MigrationPlan,
    ProposalStatus, UpgradeError, UpgradeManager, UpgradeManagerClient, DEFAULT_TIMELOCK_DELAY,
    MAX_VERSION_HISTORY, ROLLBACK_WINDOW_LEDGERS,
};

// ── fixture ─────────────────────────────────────────────────────────────────

struct Mgr {
    env: Env,
    client: UpgradeManagerClient<'static>,
    admin: Address,
}

fn hash(env: &Env, seed: u8) -> BytesN<32> {
    let mut bytes = [0u8; 32];
    bytes[0] = seed;
    bytes[31] = seed.wrapping_mul(7).wrapping_add(1);
    BytesN::from_array(env, &bytes)
}

fn s(env: &Env, v: &str) -> String {
    String::from_str(env, v)
}

fn plan(env: &Env) -> MigrationPlan {
    MigrationPlan {
        pre_migration_checks: Vec::new(env),
        data_transformations: Vec::new(env),
        post_migration_validations: Vec::new(env),
        estimated_items: 0,
    }
}

fn setup(initial: &str) -> Mgr {
    let env = Env::default();
    env.mock_all_auths();
    env.ledger().set_sequence_number(100);
    env.ledger().set_timestamp(1_000_000);
    let id = env.register(UpgradeManager, ());
    let client = UpgradeManagerClient::new(&env, &id);
    let admin = Address::generate(&env);
    client.initialize(&admin, &s(&env, initial), &hash(&env, 1));
    Mgr { env, client, admin }
}

impl Mgr {
    fn propose(&self, version: &str, seed: u8) -> u64 {
        self.client.propose_upgrade(
            &self.admin,
            &s(&self.env, version),
            &hash(&self.env, seed),
            &s(&self.env, &format!("upgrade to {version}")),
            &plan(&self.env),
        )
    }

    fn pass_timelock(&self, id: u64) {
        let eta = self.client.get_proposal(&id).unwrap().eta;
        self.env.ledger().set_timestamp(eta);
    }

    /// Propose → validate → wait out the timelock → execute.
    fn upgrade(&self, version: &str, seed: u8) -> u64 {
        let id = self.propose(version, seed);
        self.client.validate_proposal(&self.admin, &id);
        self.pass_timelock(id);
        self.env.ledger().with_mut(|l| l.sequence_number += 10);
        self.client.execute_upgrade(&self.admin, &id);
        id
    }

    fn swaps(&self) -> Vec<BytesN<32>> {
        self.env
            .as_contract(&self.client.address, || mock_swap_calls(&self.env))
    }

    fn running_hash(&self) -> Option<BytesN<32>> {
        self.env
            .as_contract(&self.client.address, || stored_wasm_hash(&self.env))
    }
}

fn contract_err<T, I>(result: Result<T, Result<UpgradeError, I>>) -> UpgradeError {
    match result {
        Err(Ok(err)) => err,
        Err(Err(_)) => panic!("expected contract error, got host error"),
        Ok(_) => panic!("expected contract error, call succeeded"),
    }
}

fn is_auth_abort<T, E>(result: Result<T, Result<E, InvokeError>>) -> bool {
    matches!(result, Err(Err(InvokeError::Abort)))
}

/// Tiny deterministic PRNG (xorshift64*) so the property test is reproducible
/// without an external crate.
struct Rng(u64);

impl Rng {
    fn next(&mut self) -> u64 {
        self.0 ^= self.0 >> 12;
        self.0 ^= self.0 << 25;
        self.0 ^= self.0 >> 27;
        self.0.wrapping_mul(0x2545_F491_4F6C_DD1D)
    }

    fn below(&mut self, n: u64) -> u32 {
        (self.next() % n) as u32
    }
}

// ── version registration ────────────────────────────────────────────────────

#[test]
fn initialize_registers_initial_version_with_real_values() {
    let m = setup("1.0.0");
    let expected = ContractVersion {
        version: s(&m.env, "1.0.0"),
        wasm_hash: hash(&m.env, 1),
        upgrade_ledger: 100,
        description: s(&m.env, "Initial deployment"),
        admin: m.admin.clone(),
        rollback_deadline: 0,
    };
    assert_eq!(m.client.get_current_version(), Some(expected.clone()));
    assert_eq!(
        m.client.get_version(&s(&m.env, "1.0.0")),
        Some(expected.clone())
    );
    assert_eq!(
        m.client.get_version_history(),
        Vec::from_array(&m.env, [expected])
    );
    assert_eq!(m.running_hash(), Some(hash(&m.env, 1)));
    assert_eq!(m.swaps().len(), 0);
}

#[test]
fn double_initialize_is_rejected_and_keeps_state() {
    let m = setup("1.0.0");
    let other = Address::generate(&m.env);
    assert_eq!(
        contract_err(
            m.client
                .try_initialize(&other, &s(&m.env, "9.0.0"), &hash(&m.env, 9))
        ),
        UpgradeError::InvalidVersion
    );
    assert_eq!(m.client.get_admin(), Some(m.admin.clone()));
    assert_eq!(m.client.get_version_history().len(), 1);
}

#[test]
fn unknown_version_lookup_is_none() {
    let m = setup("1.0.0");
    assert_eq!(m.client.get_version(&s(&m.env, "2.0.0")), None);
}

// ── semver ordering ─────────────────────────────────────────────────────────

#[test]
fn minor_1_10_is_newer_than_1_9() {
    let m = setup("1.9.0");
    m.upgrade("1.10.0", 2);
    assert_eq!(
        m.client.get_current_version().unwrap().version,
        s(&m.env, "1.10.0")
    );

    // ...and going back to 1.9.x is a downgrade, not a lexicographic "upgrade".
    let m = setup("1.10.0");
    assert_eq!(
        contract_err(m.client.try_propose_upgrade(
            &m.admin,
            &s(&m.env, "1.9.0"),
            &hash(&m.env, 2),
            &s(&m.env, "down"),
            &plan(&m.env),
        )),
        UpgradeError::DowngradeNotAllowed
    );
}

#[test]
fn compare_versions_matches_numeric_tuple_order_property() {
    let env = Env::default();
    let mut rng = Rng(0x9E37_79B9_7F4A_7C15);
    for _ in 0..2_000 {
        // Small ranges make equal components (and full ties) common.
        let a = (rng.below(12), rng.below(12), rng.below(12));
        let b = (rng.below(12), rng.below(12), rng.below(12));
        let va = s(&env, &format!("{}.{}.{}", a.0, a.1, a.2));
        let vb = s(&env, &format!("{}.{}.{}", b.0, b.1, b.2));

        let got = compare_versions(&va, &vb).expect("well-formed tags");
        assert_eq!(got, a.cmp(&b), "{a:?} vs {b:?}");
        // Antisymmetry.
        assert_eq!(compare_versions(&vb, &va), Some(got.reverse()));
    }
}

#[test]
fn compare_versions_is_transitive_over_sorted_sample() {
    let env = Env::default();
    let mut rng = Rng(42);
    let mut tuples: std::vec::Vec<(u32, u32, u32)> = (0..60)
        .map(|_| (rng.below(4), rng.below(25), rng.below(25)))
        .collect();
    tuples.sort();
    tuples.dedup();
    let tags: std::vec::Vec<String> = tuples
        .iter()
        .map(|t| s(&env, &format!("{}.{}.{}", t.0, t.1, t.2)))
        .collect();
    for i in 0..tags.len() {
        for j in 0..tags.len() {
            assert_eq!(compare_versions(&tags[i], &tags[j]), Some(i.cmp(&j)));
        }
    }
}

#[test]
fn propose_accepts_exactly_the_strictly_newer_versions() {
    let mut rng = Rng(7);
    for _ in 0..40 {
        let cur = (rng.below(3), rng.below(11), rng.below(11));
        let next = (rng.below(3), rng.below(11), rng.below(11));
        let m = setup(&format!("{}.{}.{}", cur.0, cur.1, cur.2));
        let result = m.client.try_propose_upgrade(
            &m.admin,
            &s(&m.env, &format!("{}.{}.{}", next.0, next.1, next.2)),
            &hash(&m.env, 2),
            &s(&m.env, "p"),
            &plan(&m.env),
        );
        if next.cmp(&cur) == Ordering::Greater {
            assert!(result.is_ok(), "{cur:?} -> {next:?} should be accepted");
        } else {
            assert_eq!(
                contract_err(result),
                UpgradeError::DowngradeNotAllowed,
                "{cur:?} -> {next:?}"
            );
        }
    }
}

#[test]
fn prerelease_sorts_below_release_and_malformed_is_rejected() {
    let env = Env::default();
    assert_eq!(
        compare_versions(&s(&env, "1.0.0-rc.1"), &s(&env, "1.0.0")),
        Some(Ordering::Less)
    );
    assert_eq!(compare_versions(&s(&env, "1.x.0"), &s(&env, "1.0.0")), None);

    let m = setup("1.0.0");
    for bad in ["", "1.x.0", "v2.0.0"] {
        assert_eq!(
            contract_err(m.client.try_propose_upgrade(
                &m.admin,
                &s(&m.env, bad),
                &hash(&m.env, 2),
                &s(&m.env, "bad"),
                &plan(&m.env),
            )),
            UpgradeError::MalformedVersion,
            "{bad:?}"
        );
    }
}

// ── history recording ───────────────────────────────────────────────────────

#[test]
fn executed_upgrades_record_real_history_entries_newest_first() {
    let m = setup("1.0.0");
    let id2 = m.upgrade("1.9.0", 2);
    let seq2 = m.env.ledger().sequence();
    let id3 = m.upgrade("1.10.0", 3);
    let seq3 = m.env.ledger().sequence();

    let history = m.client.get_version_history();
    assert_eq!(history.len(), 3);

    let newest = history.get_unchecked(0);
    assert_eq!(
        newest,
        ContractVersion {
            version: s(&m.env, "1.10.0"),
            wasm_hash: hash(&m.env, 3),
            upgrade_ledger: seq3,
            description: s(&m.env, "upgrade to 1.10.0"),
            admin: m.admin.clone(),
            rollback_deadline: seq3 + ROLLBACK_WINDOW_LEDGERS,
        }
    );
    let middle = history.get_unchecked(1);
    assert_eq!(middle.version, s(&m.env, "1.9.0"));
    assert_eq!(middle.wasm_hash, hash(&m.env, 2));
    assert_eq!(middle.upgrade_ledger, seq2);
    assert_eq!(middle.rollback_deadline, seq2 + ROLLBACK_WINDOW_LEDGERS);
    assert_eq!(history.get_unchecked(2).version, s(&m.env, "1.0.0"));

    // No placeholder values anywhere in the recorded history.
    let zero = BytesN::from_array(&m.env, &[0u8; 32]);
    for v in history.iter() {
        assert_ne!(v.wasm_hash, zero);
        assert!(v.upgrade_ledger > 0);
        assert!(!v.version.is_empty());
        assert!(!v.description.is_empty());
        assert_eq!(m.client.get_version(&v.version), Some(v.clone()));
    }

    // Each proposal captured the real outgoing version for rollback.
    let p2 = m.client.get_proposal(&id2).unwrap();
    assert_eq!(p2.previous_version, s(&m.env, "1.0.0"));
    assert_eq!(p2.previous_wasm_hash, hash(&m.env, 1));
    assert_eq!(p2.executed_ledger, seq2);
    let p3 = m.client.get_proposal(&id3).unwrap();
    assert_eq!(p3.previous_version, s(&m.env, "1.9.0"));
    assert_eq!(p3.previous_wasm_hash, hash(&m.env, 2));

    assert_eq!(
        m.swaps(),
        Vec::from_array(&m.env, [hash(&m.env, 2), hash(&m.env, 3)])
    );
    assert_eq!(m.running_hash(), Some(hash(&m.env, 3)));
}

#[test]
fn proposals_do_not_touch_history_until_executed() {
    let m = setup("1.0.0");
    let id = m.propose("2.0.0", 2);
    m.client.validate_proposal(&m.admin, &id);
    assert_eq!(m.client.get_version_history().len(), 1);
    assert_eq!(m.client.get_version(&s(&m.env, "2.0.0")), None);
    assert_eq!(m.swaps().len(), 0);
}

#[test]
fn version_history_is_bounded() {
    let m = setup("0.0.1");
    let extra = MAX_VERSION_HISTORY + 2;
    for minor in 1..=extra {
        m.upgrade(&format!("0.{minor}.0"), (minor % 250) as u8 + 2);
    }
    let history = m.client.get_version_history();
    assert_eq!(history.len(), MAX_VERSION_HISTORY);
    assert_eq!(
        history.get_unchecked(0).version,
        s(&m.env, &format!("0.{extra}.0"))
    );
    // The oldest tags were evicted from the index.
    let oldest_kept = history.get_unchecked(MAX_VERSION_HISTORY - 1).version;
    assert_eq!(
        oldest_kept,
        s(&m.env, &format!("0.{}.0", extra - MAX_VERSION_HISTORY + 1))
    );
}

// ── authorized vs unauthorized upgrade ──────────────────────────────────────

#[test]
fn non_member_cannot_propose_validate_execute_or_rollback() {
    let m = setup("1.0.0");
    let id = m.propose("2.0.0", 2);
    m.client.validate_proposal(&m.admin, &id);
    m.pass_timelock(id);
    let outsider = Address::generate(&m.env);

    assert_eq!(
        contract_err(m.client.try_propose_upgrade(
            &outsider,
            &s(&m.env, "3.0.0"),
            &hash(&m.env, 3),
            &s(&m.env, "x"),
            &plan(&m.env),
        )),
        UpgradeError::Unauthorized
    );
    assert_eq!(
        contract_err(m.client.try_approve_upgrade(&outsider, &id)),
        UpgradeError::Unauthorized
    );
    assert_eq!(
        contract_err(m.client.try_validate_proposal(&outsider, &id)),
        UpgradeError::Unauthorized
    );
    assert_eq!(
        contract_err(m.client.try_execute_upgrade(&outsider, &id)),
        UpgradeError::Unauthorized
    );
    assert_eq!(
        m.client.get_current_version().unwrap().version,
        s(&m.env, "1.0.0")
    );

    m.client.execute_upgrade(&m.admin, &id);
    assert_eq!(
        contract_err(m.client.try_rollback_upgrade(&outsider, &id)),
        UpgradeError::Unauthorized
    );
    assert_eq!(
        m.client.get_current_version().unwrap().version,
        s(&m.env, "2.0.0")
    );
}

#[test]
fn member_without_signature_cannot_upgrade() {
    let m = setup("1.0.0");
    let id = m.propose("2.0.0", 2);
    m.client.validate_proposal(&m.admin, &id);
    m.pass_timelock(id);

    m.env.mock_auths(&[]);
    assert!(is_auth_abort(m.client.try_execute_upgrade(&m.admin, &id)));
    assert!(is_auth_abort(
        m.client.try_set_admin(&Address::generate(&m.env))
    ));
    assert!(is_auth_abort(m.client.try_pause()));

    m.env.mock_all_auths();
    assert_eq!(
        m.client.get_current_version().unwrap().version,
        s(&m.env, "1.0.0")
    );
    assert_eq!(m.swaps().len(), 0);
}

#[test]
fn signature_from_wrong_address_does_not_authorize_member() {
    let m = setup("1.0.0");
    let id = m.propose("2.0.0", 2);
    m.client.validate_proposal(&m.admin, &id);
    m.pass_timelock(id);
    let intruder = Address::generate(&m.env);
    m.env.mock_auths(&[MockAuth {
        address: &intruder,
        invoke: &MockAuthInvoke {
            contract: &m.client.address,
            fn_name: "execute_upgrade",
            args: (m.admin.clone(), id).into_val(&m.env),
            sub_invokes: &[],
        },
    }]);
    assert!(is_auth_abort(m.client.try_execute_upgrade(&m.admin, &id)));
}

#[test]
fn multisig_member_upgrade_requires_threshold_and_timelock() {
    let m = setup("1.0.0");
    let a2 = Address::generate(&m.env);
    let a3 = Address::generate(&m.env);
    let admins = Vec::from_array(&m.env, [m.admin.clone(), a2.clone(), a3.clone()]);
    m.client
        .set_multisig_config(&admins, &2, &DEFAULT_TIMELOCK_DELAY);

    let id = m.client.propose_upgrade(
        &a2,
        &s(&m.env, "2.0.0"),
        &hash(&m.env, 2),
        &s(&m.env, "msig"),
        &plan(&m.env),
    );
    m.client.validate_proposal(&a2, &id);
    assert_eq!(
        contract_err(m.client.try_execute_upgrade(&a2, &id)),
        UpgradeError::InsufficientApprovals
    );

    m.client.approve_upgrade(&a3, &id);
    assert_eq!(
        contract_err(m.client.try_approve_upgrade(&a3, &id)),
        UpgradeError::AlreadyApproved
    );
    assert_eq!(
        contract_err(m.client.try_execute_upgrade(&a3, &id)),
        UpgradeError::TimelockNotElapsed
    );

    m.pass_timelock(id);
    assert_eq!(
        m.client.get_proposal(&id).unwrap().status,
        ProposalStatus::Ready
    );
    m.client.execute_upgrade(&a3, &id);

    let current = m.client.get_current_version().unwrap();
    assert_eq!(current.version, s(&m.env, "2.0.0"));
    // History records who actually executed the upgrade.
    assert_eq!(current.admin, a3);
}

// ── paused-state behaviour ──────────────────────────────────────────────────

#[test]
fn pause_blocks_every_upgrade_mutation_and_unpause_restores() {
    let m = setup("1.0.0");
    let executed = m.upgrade("2.0.0", 2);
    let pending = m.propose("3.0.0", 3);
    m.client.validate_proposal(&m.admin, &pending);
    m.pass_timelock(pending);

    m.client.pause();
    assert!(m.client.is_paused());
    let paused = UpgradeError::ContractPaused;
    let other = Address::generate(&m.env);

    assert_eq!(
        contract_err(m.client.try_propose_upgrade(
            &m.admin,
            &s(&m.env, "4.0.0"),
            &hash(&m.env, 4),
            &s(&m.env, "x"),
            &plan(&m.env),
        )),
        paused
    );
    assert_eq!(
        contract_err(m.client.try_approve_upgrade(&m.admin, &pending)),
        paused
    );
    assert_eq!(
        contract_err(m.client.try_validate_proposal(&m.admin, &pending)),
        paused
    );
    assert_eq!(
        contract_err(m.client.try_execute_upgrade(&m.admin, &pending)),
        paused
    );
    assert_eq!(
        contract_err(m.client.try_rollback_upgrade(&m.admin, &executed)),
        paused
    );
    assert_eq!(contract_err(m.client.try_set_admin(&other)), paused);
    assert_eq!(
        contract_err(m.client.try_set_multisig_config(
            &Vec::from_array(&m.env, [other.clone()]),
            &1,
            &DEFAULT_TIMELOCK_DELAY,
        )),
        paused
    );

    // Nothing moved while paused; reads still work.
    assert_eq!(
        m.client.get_current_version().unwrap().version,
        s(&m.env, "2.0.0")
    );
    assert_eq!(m.client.get_version_history().len(), 2);
    assert_eq!(m.swaps().len(), 1);

    m.client.unpause();
    assert!(!m.client.is_paused());
    m.client.execute_upgrade(&m.admin, &pending);
    assert_eq!(
        m.client.get_current_version().unwrap().version,
        s(&m.env, "3.0.0")
    );
}

#[test]
fn pause_and_unpause_require_admin_signature() {
    let m = setup("1.0.0");
    m.env.mock_auths(&[]);
    assert!(is_auth_abort(m.client.try_pause()));
    m.env.mock_all_auths();
    m.client.pause();
    m.env.mock_auths(&[]);
    assert!(is_auth_abort(m.client.try_unpause()));
    m.env.mock_all_auths();
    assert!(m.client.is_paused());
}

// ── rollback ────────────────────────────────────────────────────────────────

#[test]
fn rollback_restores_previous_version_and_hash_once() {
    let m = setup("1.0.0");
    let id = m.upgrade("2.0.0", 2);
    assert!(m.client.can_rollback(&id));
    let record = m.client.get_rollback_info(&id).unwrap();
    assert_eq!(record.previous_version.version, s(&m.env, "1.0.0"));
    assert_eq!(record.previous_version.wasm_hash, hash(&m.env, 1));

    m.client.rollback_upgrade(&m.admin, &id);

    let current = m.client.get_current_version().unwrap();
    assert_eq!(current.version, s(&m.env, "1.0.0"));
    assert_eq!(current.wasm_hash, hash(&m.env, 1));
    assert_eq!(m.running_hash(), Some(hash(&m.env, 1)));
    assert_eq!(
        m.swaps(),
        Vec::from_array(&m.env, [hash(&m.env, 2), hash(&m.env, 1)])
    );
    assert_eq!(
        m.client.get_proposal(&id).unwrap().status,
        ProposalStatus::RolledBack
    );

    // Single use.
    assert!(!m.client.can_rollback(&id));
    assert_eq!(m.client.get_rollback_info(&id), None);
    assert_eq!(
        contract_err(m.client.try_rollback_upgrade(&m.admin, &id)),
        UpgradeError::NoRollbackAvailable
    );
    // History keeps the rolled-back release on record.
    assert_eq!(
        m.client.get_version(&s(&m.env, "2.0.0")).unwrap().wasm_hash,
        hash(&m.env, 2)
    );
}

#[test]
fn rollback_window_boundary() {
    let m = setup("1.0.0");
    let id = m.upgrade("2.0.0", 2);
    let deadline = m.client.get_rollback_info(&id).unwrap().rollback_deadline;

    m.env.ledger().set_sequence_number(deadline + 1);
    assert!(!m.client.can_rollback(&id));
    assert_eq!(
        contract_err(m.client.try_rollback_upgrade(&m.admin, &id)),
        UpgradeError::RollbackDeadlineExpired
    );

    m.env.ledger().set_sequence_number(deadline);
    assert!(m.client.can_rollback(&id));
    m.client.rollback_upgrade(&m.admin, &id);
}

#[test]
fn rollback_of_unexecuted_proposal_is_unavailable() {
    let m = setup("1.0.0");
    let id = m.propose("2.0.0", 2);
    assert!(!m.client.can_rollback(&id));
    assert_eq!(
        contract_err(m.client.try_rollback_upgrade(&m.admin, &id)),
        UpgradeError::NoRollbackAvailable
    );
    assert_eq!(
        contract_err(m.client.try_rollback_upgrade(&m.admin, &999)),
        UpgradeError::NoProposal
    );
}
