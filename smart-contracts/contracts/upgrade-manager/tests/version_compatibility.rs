//! Unit tests for upgrade-manager version compatibility checks (issue #945).
//!
//! Tests version comparison logic and upgrade validation rules:
//! - Upgrade from current version  
//! - Upgrade from older version (should work)
//! - Upgrade from newer version (should reject)
//! - Version format validation
//! - Version comparison logic

use soroban_sdk::{
    testutils::{Address as _, Ledger as _},
    Address, BytesN, Env, String, Vec,
};
use upgrade_manager::{
    strutil::compare_versions, MigrationPlan, UpgradeError, UpgradeManager,
    UpgradeManagerClient,
};

// ── Helper Functions ────────────────────────────────────────────────────────

fn setup(initial_version: &str) -> (Env, UpgradeManagerClient<'static>, Address) {
    let env = Env::default();
    env.mock_all_auths();
    env.ledger().set_sequence_number(100);
    env.ledger().set_timestamp(1_000_000);

    let contract_id = env.register(UpgradeManager, ());
    let client = UpgradeManagerClient::new(&env, &contract_id);
    let admin = Address::generate(&env);

    let initial_hash = BytesN::from_array(&env, &[1u8; 32]);
    client.initialize(&admin, &s(&env, initial_version), &initial_hash);

    (env, client, admin)
}

fn s(env: &Env, text: &str) -> String {
    String::from_str(env, text)
}

fn hash(env: &Env, seed: u8) -> BytesN<32> {
    let mut bytes = [0u8; 32];
    bytes[0] = seed;
    bytes[31] = seed.wrapping_mul(7).wrapping_add(1);
    BytesN::from_array(env, &bytes)
}

fn empty_plan(env: &Env) -> MigrationPlan {
    MigrationPlan {
        pre_migration_checks: Vec::new(env),
        data_transformations: Vec::new(env),
        post_migration_validations: Vec::new(env),
        estimated_items: 0,
    }
}

fn contract_err<T>(result: Result<T, Result<UpgradeError, _>>) -> UpgradeError {
    match result {
        Err(Ok(err)) => err,
        Err(Err(_)) => panic!("expected contract error, got host error"),
        Ok(_) => panic!("expected contract error, call succeeded"),
    }
}

// ── Test: Upgrade from Current Version ──────────────────────────────────────

#[test]
fn test_upgrade_from_current_version_to_newer() {
    let (env, client, admin) = setup("1.0.0");

    // Attempting to upgrade from 1.0.0 to 1.0.0 should be rejected (not newer)
    let result = client.try_propose_upgrade(
        &admin,
        &s(&env, "1.0.0"),
        &hash(&env, 2),
        &s(&env, "Same version"),
        &empty_plan(&env),
    );
    assert_eq!(
        contract_err(result),
        UpgradeError::DowngradeNotAllowed,
        "Same version should be rejected"
    );

    // Upgrading to 1.0.1 (patch bump) should succeed
    let result = client.try_propose_upgrade(
        &admin,
        &s(&env, "1.0.1"),
        &hash(&env, 2),
        &s(&env, "Patch upgrade"),
        &empty_plan(&env),
    );
    assert!(
        result.is_ok(),
        "Upgrading to newer patch version should succeed"
    );

    // Verify proposal was created
    let proposal_id = result.unwrap();
    let proposal = client.get_proposal(&proposal_id);
    assert_eq!(proposal.new_version, s(&env, "1.0.1"));
}

#[test]
fn test_upgrade_from_current_version_minor_and_major_bumps() {
    let (env, client, admin) = setup("1.5.3");

    // Minor version bump: 1.5.3 -> 1.6.0
    let result = client.try_propose_upgrade(
        &admin,
        &s(&env, "1.6.0"),
        &hash(&env, 2),
        &s(&env, "Minor bump"),
        &empty_plan(&env),
    );
    assert!(result.is_ok(), "Minor version bump should succeed");

    // Reset for major version test
    let (env, client, admin) = setup("1.5.3");

    // Major version bump: 1.5.3 -> 2.0.0
    let result = client.try_propose_upgrade(
        &admin,
        &s(&env, "2.0.0"),
        &hash(&env, 3),
        &s(&env, "Major bump"),
        &empty_plan(&env),
    );
    assert!(result.is_ok(), "Major version bump should succeed");
}

// ── Test: Upgrade from Older Version (should work) ──────────────────────────

#[test]
fn test_upgrade_from_older_version_should_work() {
    let (env, client, admin) = setup("1.0.0");

    // Upgrading from 1.0.0 to 2.5.7 should work (much newer)
    let result = client.try_propose_upgrade(
        &admin,
        &s(&env, "2.5.7"),
        &hash(&env, 2),
        &s(&env, "Big jump forward"),
        &empty_plan(&env),
    );
    assert!(
        result.is_ok(),
        "Upgrading from older version should succeed"
    );

    let proposal_id = result.unwrap();
    let proposal = client.get_proposal(&proposal_id);
    assert_eq!(proposal.new_version, s(&env, "2.5.7"));
    assert_eq!(proposal.previous_version, s(&env, ""));
}

#[test]
fn test_upgrade_path_from_very_old_version() {
    let (env, client, admin) = setup("0.1.0");

    // Upgrade to 1.0.0 (major version 1)
    let result = client.try_propose_upgrade(
        &admin,
        &s(&env, "1.0.0"),
        &hash(&env, 2),
        &s(&env, "To v1"),
        &empty_plan(&env),
    );
    assert!(result.is_ok(), "Should accept v1 from v0");
}

// ── Test: Upgrade from Newer Version (should reject) ────────────────────────

#[test]
fn test_upgrade_from_newer_version_should_reject() {
    let (env, client, admin) = setup("2.0.0");

    // Attempting to "upgrade" from 2.0.0 to 1.9.9 should be rejected (downgrade)
    let result = client.try_propose_upgrade(
        &admin,
        &s(&env, "1.9.9"),
        &hash(&env, 2),
        &s(&env, "Attempted downgrade"),
        &empty_plan(&env),
    );
    assert_eq!(
        contract_err(result),
        UpgradeError::DowngradeNotAllowed,
        "Downgrade should be rejected"
    );
}

#[test]
fn test_downgrade_minor_version_rejected() {
    let (env, client, admin) = setup("1.5.0");

    // 1.5.0 -> 1.4.9 (minor downgrade)
    let result = client.try_propose_upgrade(
        &admin,
        &s(&env, "1.4.9"),
        &hash(&env, 2),
        &s(&env, "Minor downgrade"),
        &empty_plan(&env),
    );
    assert_eq!(
        contract_err(result),
        UpgradeError::DowngradeNotAllowed,
        "Minor downgrade should be rejected"
    );
}

#[test]
fn test_downgrade_patch_version_rejected() {
    let (env, client, admin) = setup("1.0.5");

    // 1.0.5 -> 1.0.4 (patch downgrade)
    let result = client.try_propose_upgrade(
        &admin,
        &s(&env, "1.0.4"),
        &hash(&env, 2),
        &s(&env, "Patch downgrade"),
        &empty_plan(&env),
    );
    assert_eq!(
        contract_err(result),
        UpgradeError::DowngradeNotAllowed,
        "Patch downgrade should be rejected"
    );
}

// ── Test: Version Format Validation ─────────────────────────────────────────

#[test]
fn test_version_format_validation_malformed() {
    let (env, client, admin) = setup("1.0.0");

    // Invalid format: no dots
    let result = client.try_propose_upgrade(
        &admin,
        &s(&env, "200"),
        &hash(&env, 2),
        &s(&env, "Bad format"),
        &empty_plan(&env),
    );
    assert_eq!(
        contract_err(result),
        UpgradeError::MalformedVersion,
        "Version without dots should be rejected"
    );

    // Invalid format: contains letters in numeric part
    let result = client.try_propose_upgrade(
        &admin,
        &s(&env, "1.x.0"),
        &hash(&env, 2),
        &s(&env, "Bad format"),
        &empty_plan(&env),
    );
    assert_eq!(
        contract_err(result),
        UpgradeError::MalformedVersion,
        "Version with letters in numbers should be rejected"
    );

    // Invalid format: v prefix
    let result = client.try_propose_upgrade(
        &admin,
        &s(&env, "v2.0.0"),
        &hash(&env, 2),
        &s(&env, "With v prefix"),
        &empty_plan(&env),
    );
    assert_eq!(
        contract_err(result),
        UpgradeError::MalformedVersion,
        "Version with 'v' prefix should be rejected"
    );

    // Invalid format: empty string
    let result = client.try_propose_upgrade(
        &admin,
        &s(&env, ""),
        &hash(&env, 2),
        &s(&env, "Empty"),
        &empty_plan(&env),
    );
    assert_eq!(
        contract_err(result),
        UpgradeError::MalformedVersion,
        "Empty version string should be rejected"
    );
}

#[test]
fn test_version_format_validation_valid_semver() {
    let (env, client, admin) = setup("1.0.0");

    // Valid: standard semver
    let result = client.try_propose_upgrade(
        &admin,
        &s(&env, "1.0.1"),
        &hash(&env, 2),
        &s(&env, "Valid semver"),
        &empty_plan(&env),
    );
    assert!(result.is_ok(), "Standard semver should be accepted");
}

#[test]
fn test_version_format_prerelease_and_build() {
    let (env, client, admin) = setup("1.0.0");

    // Valid: prerelease
    let result = client.try_propose_upgrade(
        &admin,
        &s(&env, "1.0.1-rc.1"),
        &hash(&env, 2),
        &s(&env, "Prerelease"),
        &empty_plan(&env),
    );
    assert!(result.is_ok(), "Prerelease version should be accepted");

    let (env, client, admin) = setup("1.0.0");

    // Valid: build metadata
    let result = client.try_propose_upgrade(
        &admin,
        &s(&env, "1.0.1+build.123"),
        &hash(&env, 2),
        &s(&env, "Build metadata"),
        &empty_plan(&env),
    );
    assert!(result.is_ok(), "Build metadata should be accepted");
}

// ── Test: Version Comparison Logic ──────────────────────────────────────────

#[test]
fn test_version_comparison_major_versions() {
    let env = Env::default();

    // 2.0.0 > 1.9.9
    assert_eq!(
        compare_versions(&s(&env, "2.0.0"), &s(&env, "1.9.9")),
        Some(core::cmp::Ordering::Greater)
    );

    // 1.0.0 < 2.0.0
    assert_eq!(
        compare_versions(&s(&env, "1.0.0"), &s(&env, "2.0.0")),
        Some(core::cmp::Ordering::Less)
    );

    // 3.0.0 == 3.0.0
    assert_eq!(
        compare_versions(&s(&env, "3.0.0"), &s(&env, "3.0.0")),
        Some(core::cmp::Ordering::Equal)
    );
}

#[test]
fn test_version_comparison_minor_versions() {
    let env = Env::default();

    // 1.10.0 > 1.9.0 (lexicographic would be wrong!)
    assert_eq!(
        compare_versions(&s(&env, "1.10.0"), &s(&env, "1.9.0")),
        Some(core::cmp::Ordering::Greater),
        "1.10.0 should be greater than 1.9.0 (not lexicographic)"
    );

    // 1.2.0 < 1.10.0
    assert_eq!(
        compare_versions(&s(&env, "1.2.0"), &s(&env, "1.10.0")),
        Some(core::cmp::Ordering::Less)
    );

    // 1.100.0 > 1.99.0
    assert_eq!(
        compare_versions(&s(&env, "1.100.0"), &s(&env, "1.99.0")),
        Some(core::cmp::Ordering::Greater),
        "Three-digit minor versions should compare numerically"
    );
}

#[test]
fn test_version_comparison_patch_versions() {
    let env = Env::default();

    // 1.0.10 > 1.0.9
    assert_eq!(
        compare_versions(&s(&env, "1.0.10"), &s(&env, "1.0.9")),
        Some(core::cmp::Ordering::Greater)
    );

    // 1.0.5 < 1.0.15
    assert_eq!(
        compare_versions(&s(&env, "1.0.5"), &s(&env, "1.0.15")),
        Some(core::cmp::Ordering::Less)
    );
}

#[test]
fn test_version_comparison_prerelease() {
    let env = Env::default();

    // 1.0.0-rc.1 < 1.0.0 (prerelease sorts below release)
    assert_eq!(
        compare_versions(&s(&env, "1.0.0-rc.1"), &s(&env, "1.0.0")),
        Some(core::cmp::Ordering::Less),
        "Prerelease should sort below release"
    );

    // 1.0.0 > 1.0.0-alpha
    assert_eq!(
        compare_versions(&s(&env, "1.0.0"), &s(&env, "1.0.0-alpha")),
        Some(core::cmp::Ordering::Greater)
    );
}

#[test]
fn test_version_comparison_malformed_returns_none() {
    let env = Env::default();

    // Malformed versions should return None
    assert_eq!(compare_versions(&s(&env, "1.x.0"), &s(&env, "1.0.0")), None);
    assert_eq!(compare_versions(&s(&env, "1.0.0"), &s(&env, "v2.0.0")), None);
    assert_eq!(compare_versions(&s(&env, ""), &s(&env, "1.0.0")), None);
    assert_eq!(compare_versions(&s(&env, "abc"), &s(&env, "1.0.0")), None);
}

#[test]
fn test_version_comparison_edge_cases() {
    let env = Env::default();

    // Leading zeros should be handled
    assert_eq!(
        compare_versions(&s(&env, "1.01.0"), &s(&env, "1.1.0")),
        Some(core::cmp::Ordering::Equal),
        "Leading zeros in minor version"
    );

    // Large version numbers
    assert_eq!(
        compare_versions(&s(&env, "999.999.999"), &s(&env, "1000.0.0")),
        Some(core::cmp::Ordering::Less)
    );
}

// ── Test: Integration - Upgrade Workflow with Version Checks ────────────────

#[test]
fn test_upgrade_workflow_version_checks() {
    let (env, client, admin) = setup("1.0.0");

    // Step 1: Propose valid upgrade
    let proposal_id = client.propose_upgrade(
        &admin,
        &s(&env, "1.1.0"),
        &hash(&env, 2),
        &s(&env, "Minor upgrade"),
        &empty_plan(&env),
    );

    // Step 2: Validate proposal
    client.validate_proposal(&admin, &proposal_id);

    let proposal = client.get_proposal(&proposal_id);
    assert!(proposal.validated);

    // Step 3: Wait for timelock
    env.ledger().set_timestamp(proposal.eta);

    // Step 4: Execute upgrade
    env.ledger().with_mut(|l| l.sequence_number += 10);
    client.execute_upgrade(&admin, &proposal_id);

    // Verify current version updated
    let current = client.get_current_version().unwrap();
    assert_eq!(current.version, s(&env, "1.1.0"));

    // Step 5: Try to downgrade (should fail)
    let downgrade_result = client.try_propose_upgrade(
        &admin,
        &s(&env, "1.0.0"),
        &hash(&env, 3),
        &s(&env, "Attempted downgrade"),
        &empty_plan(&env),
    );
    assert_eq!(
        contract_err(downgrade_result),
        UpgradeError::DowngradeNotAllowed
    );
}
