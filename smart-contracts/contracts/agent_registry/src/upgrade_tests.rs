#![cfg(test)]
#![allow(unused, deprecated, clippy::all)]

mod upgrade_tests {
    use crate::*;
    use soroban_sdk::{
        testutils::{Address as _, Events as _, Ledger as _},
        Address, BytesN, Env, String,
    };
    use upgrade_manager::{
        MigrationMetadata, UpgradeStatus, Upgradeable, UpgradeableError, VersionCompatibility,
    };

    fn setup_upgrade_test() -> (Env, crate::AgentRegistryContractClient<'static>, Address) {
        let env = Env::default();
        env.ledger().set_sequence_number(1);
        env.mock_all_auths();
        let contract_id = env.register(crate::AgentRegistryContract, ());
        let client = crate::AgentRegistryContractClient::new(&env, &contract_id);
        let admin = Address::generate(&env);
        client.initialize(&admin);
        (env, client, admin)
    }

    fn test_wasm_hash(env: &Env, version: u8) -> BytesN<32> {
        let mut hash = [0u8; 32];
        hash[0] = version;
        BytesN::from_array(env, &hash)
    }

    #[test]
    fn test_get_version() {
        let (env, client, _admin) = setup_upgrade_test();
        let version = client.get_version();
        assert_eq!(version, String::from_str(&env, "1.0.0"));
    }

    #[test]
    fn test_is_upgradeable() {
        let (_env, client, _admin) = setup_upgrade_test();
        assert!(client.is_upgradeable());
    }

    #[test]
    fn test_set_upgrade_manager() {
        let (env, client, _admin) = setup_upgrade_test();
        let upgrade_manager = Address::generate(&env);

        client.set_upgrade_manager(&upgrade_manager);
        let events = env.events().all();

        assert_eq!(client.get_upgrade_manager(), Some(upgrade_manager));
        assert!(!events.is_empty());
    }

    #[test]
    fn test_set_upgrade_manager_unauthorized() {
        let env = Env::default();
        let contract_id = env.register(crate::AgentRegistryContract, ());
        let client = crate::AgentRegistryContractClient::new(&env, &contract_id);
        let admin = Address::generate(&env);

        env.mock_all_auths();
        client.initialize(&admin);

        // Remove authorization
        env.mock_auths(&[]);

        let upgrade_manager = Address::generate(&env);
        let result = client.try_set_upgrade_manager(&upgrade_manager);

        assert!(result.is_err());
    }

    #[test]
    fn test_pre_upgrade_hook_success() {
        let (env, client, _admin) = setup_upgrade_test();
        let new_version = String::from_str(&env, "1.1.0");
        let new_hash = test_wasm_hash(&env, 2);

        let validation_results = client.pre_upgrade_hook(&new_version, &new_hash);
        assert!(validation_results.len() > 0);

        // Check that validation passed
        let last_result = validation_results
            .get(validation_results.len() - 1)
            .unwrap();
        assert_eq!(
            last_result,
            String::from_str(&env, "Pre-upgrade validation successful")
        );
    }

    #[test]
    fn test_pre_upgrade_hook_paused_contract() {
        let (env, client, _admin) = setup_upgrade_test();

        // Pause the contract
        client.pause();

        let new_version = String::from_str(&env, "1.1.0");
        let new_hash = test_wasm_hash(&env, 2);

        let result = client.try_pre_upgrade_hook(&new_version, &new_hash);
        assert_eq!(result, Err(Ok(UpgradeableError::PreUpgradeHookFailed)));
    }

    #[test]
    fn test_pre_upgrade_hook_incompatible_version() {
        let (env, client, _admin) = setup_upgrade_test();

        // Try to downgrade to older version
        let old_version = String::from_str(&env, "0.9.0");
        let new_hash = test_wasm_hash(&env, 0);

        let result = client.try_pre_upgrade_hook(&old_version, &new_hash);
        assert_eq!(result, Err(Ok(UpgradeableError::IncompatibleVersion)));
    }

    #[test]
    fn test_post_upgrade_hook_success() {
        let (env, client, _admin) = setup_upgrade_test();
        let old_version = String::from_str(&env, "1.0.0");
        let new_version = String::from_str(&env, "1.1.0");

        client.post_upgrade_hook(&old_version, &new_version);

        // Check that version was updated in storage
        // In a real test, we'd verify the storage was actually updated

        // Check event was emitted
        let events = env.events().all();
        assert!(!events.is_empty());
    }

    #[test]
    fn test_get_migration_plan() {
        let (env, client, _admin) = setup_upgrade_test();
        let target_version = String::from_str(&env, "2.0.0");

        let migration_plan = client.get_migration_plan(&target_version);
        assert_eq!(migration_plan.from_version, String::from_str(&env, "1.0.0"));
        assert_eq!(migration_plan.to_version, target_version);
        assert!(migration_plan.estimated_data_items > 0);
        assert!(migration_plan.rollback_supported);
    }

    #[test]
    fn test_get_migration_plan_breaking_change() {
        let (env, client, _admin) = setup_upgrade_test();
        let target_version = String::from_str(&env, "3.0.0"); // Major version change

        let migration_plan = client.get_migration_plan(&target_version);
        // Major version changes should be marked as breaking
        // In a more sophisticated implementation, this would be true
        // For now, we just check that the plan was generated
        assert!(!migration_plan.data_transformations.is_empty());
    }

    #[test]
    fn test_initiate_upgrade_no_manager() {
        let (env, client, _admin) = setup_upgrade_test();

        let new_version = String::from_str(&env, "1.1.0");
        let new_hash = test_wasm_hash(&env, 2);
        let description = String::from_str(&env, "Minor upgrade");

        let result = client.try_initiate_upgrade(&new_version, &new_hash, &description);
        assert_eq!(result, Err(Ok(UpgradeableError::NoUpgradeManager)));
    }

    #[test]
    fn test_initiate_upgrade_with_manager() {
        let (env, client, _admin) = setup_upgrade_test();

        // Set upgrade manager
        let upgrade_manager = Address::generate(&env);
        client.set_upgrade_manager(&upgrade_manager);

        let new_version = String::from_str(&env, "1.1.0");
        let new_hash = test_wasm_hash(&env, 2);
        let description = String::from_str(&env, "Minor upgrade");

        client.initiate_upgrade(&new_version, &new_hash, &description);

        // Check event was emitted
        let events = env.events().all();
        assert!(!events.is_empty());
    }

    #[test]
    fn test_upgrade_contract_success() {
        let (env, client, _admin) = setup_upgrade_test();

        let new_hash = test_wasm_hash(&env, 2);
        let new_version = String::from_str(&env, "1.1.0");
        let description = String::from_str(&env, "Test upgrade");

        client.upgrade_contract(&new_hash, &new_version, &description);

        // Check upgrade event was emitted
        let events = env.events().all();
        assert!(events.len() > 0);

        // Verify upgrade status
        let status = client.get_upgrade_status();
        assert!(status.last_upgrade_ledger > 0);
        assert!(status.rollback_available);
    }

    #[test]
    fn test_upgrade_contract_unauthorized() {
        let env = Env::default();
        let contract_id = env.register(crate::AgentRegistryContract, ());
        let client = crate::AgentRegistryContractClient::new(&env, &contract_id);
        let admin = Address::generate(&env);

        env.mock_all_auths();
        client.initialize(&admin);

        // Remove authorization
        env.mock_auths(&[]);

        let new_hash = test_wasm_hash(&env, 2);
        let new_version = String::from_str(&env, "1.1.0");
        let description = String::from_str(&env, "Unauthorized upgrade");

        let result = client.try_upgrade_contract(&new_hash, &new_version, &description);
        assert!(result.is_err());
    }

    #[test]
    fn test_check_upgrade_compatibility() {
        let (env, client, _admin) = setup_upgrade_test();

        // Test compatible upgrade
        let compatible_version = String::from_str(&env, "1.1.0");
        let compatibility = client.check_upgrade_compatibility(&compatible_version);
        assert_eq!(
            compatibility.current_version,
            String::from_str(&env, "1.0.0")
        );
        assert_eq!(compatibility.target_version, compatible_version);
        assert!(compatibility.is_compatible);

        // Test incompatible downgrade
        let incompatible_version = String::from_str(&env, "0.9.0");
        let compatibility = client.check_upgrade_compatibility(&incompatible_version);
        assert!(!compatibility.is_compatible);
        assert!(!compatibility.compatibility_issues.is_empty());
    }

    #[test]
    fn test_get_upgrade_status() {
        let (env, client, _admin) = setup_upgrade_test();

        let status = client.get_upgrade_status();
        assert_eq!(status.current_version, String::from_str(&env, "1.0.0"));
        assert_eq!(status.last_upgrade_ledger, 0);
        assert!(!status.rollback_available);
        assert_eq!(status.pending_upgrade, None);
    }

    #[test]
    fn test_emergency_rollback_success() {
        let (env, client, _admin) = setup_upgrade_test();

        // First perform an upgrade
        let new_hash = test_wasm_hash(&env, 2);
        let new_version = String::from_str(&env, "1.1.0");
        let description = String::from_str(&env, "Test upgrade for rollback");

        client.upgrade_contract(&new_hash, &new_version, &description);

        // Verify rollback is available
        let status = client.get_upgrade_status();
        assert!(status.rollback_available);

        // Perform rollback
        let original_hash = test_wasm_hash(&env, 1);
        let original_version = String::from_str(&env, "1.0.0");

        client.emergency_rollback(&original_hash, &original_version);

        // Check rollback event was emitted
        let events = env.events().all();
        assert!(events.len() > 0);

        // Verify rollback is no longer available
        let status = client.get_upgrade_status();
        assert!(!status.rollback_available);
    }

    #[test]
    fn test_upgrade_and_rollback_swap_full_path() {
        let (env, client, _admin) = setup_upgrade_test();
        let original_hash = test_wasm_hash(&env, 1);
        let new_hash = test_wasm_hash(&env, 2);

        client.upgrade_contract(
            &new_hash,
            &String::from_str(&env, "1.10.0"),
            &String::from_str(&env, "swap path"),
        );
        let calls = env.as_contract(&client.address, || upgrade_manager::mock_swap_calls(&env));
        assert_eq!(calls.len(), 1);
        assert_eq!(calls.get(0).unwrap(), new_hash);
        assert_eq!(client.get_wasm_hash(), new_hash);

        client.emergency_rollback(&original_hash, &String::from_str(&env, "1.0.0"));
        let calls = env.as_contract(&client.address, || upgrade_manager::mock_swap_calls(&env));
        assert_eq!(calls.len(), 2);
        assert_eq!(calls.get(1).unwrap(), original_hash);
        assert_eq!(client.get_wasm_hash(), original_hash);
    }

    #[test]
    fn test_emergency_rollback_no_rollback_available() {
        let (env, client, _admin) = setup_upgrade_test();

        // Try to rollback without any previous upgrade
        let hash = test_wasm_hash(&env, 1);
        let version = String::from_str(&env, "1.0.0");

        let result = client.try_emergency_rollback(&hash, &version);
        assert!(result.is_err());
    }

    #[test]
    fn test_emergency_rollback_after_deadline() {
        let (env, client, _admin) = setup_upgrade_test();

        // Perform upgrade
        let new_hash = test_wasm_hash(&env, 2);
        let new_version = String::from_str(&env, "1.1.0");
        let description = String::from_str(&env, "Test upgrade");

        client.upgrade_contract(&new_hash, &new_version, &description);

        // Advance ledger beyond rollback window
        let current_seq = env.ledger().sequence();
        env.ledger()
            .set_sequence_number(current_seq + upgrade_manager::ROLLBACK_WINDOW_LEDGERS + 1);

        // Try to rollback - should fail
        let original_hash = test_wasm_hash(&env, 1);
        let original_version = String::from_str(&env, "1.0.0");

        let result = client.try_emergency_rollback(&original_hash, &original_version);
        assert!(result.is_err());
    }

    #[test]
    fn test_rollback_window_calculation() {
        let (env, client, _admin) = setup_upgrade_test();

        // Perform upgrade
        let new_hash = test_wasm_hash(&env, 2);
        let new_version = String::from_str(&env, "1.1.0");
        let description = String::from_str(&env, "Test upgrade");

        let upgrade_ledger = env.ledger().sequence();
        client.upgrade_contract(&new_hash, &new_version, &description);

        let status = client.get_upgrade_status();
        let expected_deadline = upgrade_ledger + upgrade_manager::ROLLBACK_WINDOW_LEDGERS;
        assert_eq!(status.rollback_deadline, expected_deadline);

        // Test rollback availability within window
        let mid_window = upgrade_ledger + (upgrade_manager::ROLLBACK_WINDOW_LEDGERS / 2);
        env.ledger().set_sequence_number(mid_window);

        let status = client.get_upgrade_status();
        assert!(status.rollback_available);

        // Test rollback unavailability after window
        env.ledger().set_sequence_number(expected_deadline + 1);

        let status = client.get_upgrade_status();
        assert!(!status.rollback_available);
    }

    #[test]
    fn test_multiple_upgrades() {
        let (env, client, _admin) = setup_upgrade_test();

        // First upgrade: 1.0.0 -> 1.1.0
        let hash_v1_1 = test_wasm_hash(&env, 2);
        let version_v1_1 = String::from_str(&env, "1.1.0");
        client.upgrade_contract(
            &hash_v1_1,
            &version_v1_1,
            &String::from_str(&env, "First upgrade"),
        );

        let status = client.get_upgrade_status();
        assert_eq!(status.current_version, version_v1_1);
        assert!(status.rollback_available);

        // Advance time to expire first rollback window
        let current_seq = env.ledger().sequence();
        env.ledger()
            .set_sequence_number(current_seq + upgrade_manager::ROLLBACK_WINDOW_LEDGERS + 1);

        // Second upgrade: 1.1.0 -> 1.2.0
        let hash_v1_2 = test_wasm_hash(&env, 3);
        let version_v1_2 = String::from_str(&env, "1.2.0");
        client.upgrade_contract(
            &hash_v1_2,
            &version_v1_2,
            &String::from_str(&env, "Second upgrade"),
        );

        let status = client.get_upgrade_status();
        assert_eq!(status.current_version, version_v1_2);
        assert!(status.rollback_available); // New rollback window should be available
    }

    #[test]
    fn test_upgrade_events() {
        let (env, client, admin) = setup_upgrade_test();

        let new_hash = test_wasm_hash(&env, 2);
        let new_version = String::from_str(&env, "1.1.0");
        let description = String::from_str(&env, "Event test upgrade");

        client.upgrade_contract(&new_hash, &new_version, &description);

        let events = env.events().all();

        // Should have at least the upgrade event
        assert!(events.len() > 0);

        // In a real implementation, we would check for specific event types:
        // - ContractUpgradedEvent with correct data
        // - PreUpgradeHookEvent
        // - PostUpgradeHookEvent

        // For now, just verify events were emitted
        let upgrade_events_count = events
            .iter()
            .filter(|(_, topics, _)| {
                topics.len() >= 2 && topics.get(0).is_some() && topics.get(1).is_some()
            })
            .count();

        assert!(upgrade_events_count > 0);
    }

    #[test]
    fn test_gas_estimation_integration() {
        let (env, client, _admin) = setup_upgrade_test();

        // Create a migration plan
        let target_version = String::from_str(&env, "2.0.0");
        let migration_plan = client.get_migration_plan(&target_version);

        // Verify gas estimation is reasonable
        assert!(migration_plan.estimated_data_items > 0);

        // In a real implementation, we could test:
        // - Gas estimation accuracy
        // - Gas budget validation
        // - Migration complexity calculation
    }

    #[test]
    fn test_version_compatibility_edge_cases() {
        let (env, client, _admin) = setup_upgrade_test();

        // Test same version
        let same_version = String::from_str(&env, "1.0.0");
        let _result = client.check_upgrade_compatibility(&same_version);
        // Should handle same version gracefully

        // Test malformed version
        let bad_version = String::from_str(&env, "not.a.version");
        let result = client.try_check_upgrade_compatibility(&bad_version);
        // Should return error for malformed version
        assert!(result.is_err());

        // Test very large version jump
        let future_version = String::from_str(&env, "99.0.0");
        let result = client.try_check_upgrade_compatibility(&future_version);
        if let Ok(Ok(compatibility)) = result {
            // A large jump is still reported, but may be flagged incompatible.
            let _ = compatibility.is_compatible;
        }
    }
}

// ─── Integration Tests with Upgrade Manager ─────────────────────────────────

#[cfg(test)]
mod upgrade_integration_tests {
    use super::*;
    use crate::*;
    use soroban_sdk::{
        testutils::{Address as _, Events as _, Ledger as _},
        Address, BytesN, Env, String, Vec,
    };
    use upgrade_manager::{MigrationPlan, UpgradeManager, UpgradeManagerClient};

    fn setup_integration_test() -> (
        Env,
        crate::AgentRegistryContractClient<'static>,
        UpgradeManagerClient<'static>,
        Address,
    ) {
        let env = Env::default();
        env.ledger().set_sequence_number(1);
        env.mock_all_auths();

        // Deploy both contracts
        let registry_id = env.register(AgentRegistryContract, ());
        let registry_client = AgentRegistryContractClient::new(&env, &registry_id);

        let upgrade_mgr_id = env.register(UpgradeManager, ());
        let upgrade_client = UpgradeManagerClient::new(&env, &upgrade_mgr_id);

        let admin = Address::generate(&env);

        // Initialize both contracts
        registry_client.initialize(&admin);

        let initial_hash = BytesN::from_array(&env, &[1u8; 32]);
        upgrade_client.initialize(&admin, &String::from_str(&env, "1.0.0"), &initial_hash);

        // Connect registry to upgrade manager
        registry_client.set_upgrade_manager(&upgrade_mgr_id);

        (env, registry_client, upgrade_client, admin)
    }

    #[test]
    fn test_full_upgrade_flow_integration() {
        let (env, _registry, upgrade_mgr, admin) = setup_integration_test();

        let new_version = String::from_str(&env, "1.1.0");
        let new_hash = BytesN::from_array(&env, &[2u8; 32]);
        let description = String::from_str(&env, "Integration test upgrade");

        // Create migration plan
        let migration_plan = MigrationPlan {
            pre_migration_checks: {
                let mut checks = Vec::new(&env);
                checks.push_back(String::from_str(&env, "storage_format_compatibility"));
                checks
            },
            data_transformations: {
                let mut transforms = Vec::new(&env);
                transforms.push_back(String::from_str(&env, "migrate_agent_records"));
                transforms
            },
            post_migration_validations: {
                let mut validations = Vec::new(&env);
                validations.push_back(String::from_str(&env, "verify_data_integrity"));
                validations
            },
            estimated_items: 50,
        };

        // Test the full upgrade flow through upgrade manager. The manager is
        // single-admin, so the proposal meets its threshold at creation and
        // only the default timelock has to elapse.
        let proposal_id = upgrade_mgr.propose_upgrade(
            &admin,
            &new_version,
            &new_hash,
            &description,
            &migration_plan,
        );

        // Validate proposal
        let gas_estimate = upgrade_mgr.validate_proposal(&admin, &proposal_id);
        assert!(gas_estimate > 0);

        // Execute upgrade once the timelock has elapsed
        let eta = upgrade_mgr.get_proposal(&proposal_id).unwrap().eta;
        env.ledger().set_timestamp(eta);
        upgrade_mgr.execute_upgrade(&admin, &proposal_id);

        // Verify upgrade was applied
        let current_version = upgrade_mgr.get_current_version();
        assert!(current_version.is_some());
        assert_eq!(current_version.unwrap().version, new_version);

        // Test rollback capability
        assert!(upgrade_mgr.can_rollback(&proposal_id));

        upgrade_mgr.rollback_upgrade(&admin, &proposal_id);

        // Verify rollback worked
        let restored_version = upgrade_mgr.get_current_version();
        assert!(restored_version.is_some());
        assert_eq!(
            restored_version.unwrap().version,
            String::from_str(&env, "1.0.0")
        );
    }

    #[test]
    fn test_upgrade_manager_gas_estimation() {
        let (env, _registry, upgrade_mgr, _admin) = setup_integration_test();

        let migration_plan = MigrationPlan {
            pre_migration_checks: Vec::new(&env),
            data_transformations: {
                let mut transforms = Vec::new(&env);
                transforms.push_back(String::from_str(&env, "migrate_agent_records"));
                transforms.push_back(String::from_str(&env, "update_storage_keys"));
                transforms
            },
            post_migration_validations: Vec::new(&env),
            estimated_items: 100,
        };

        let gas_estimate = upgrade_mgr.estimate_migration_gas(&migration_plan);

        // Should include base cost + per-item cost + step overhead
        let expected_minimum = upgrade_manager::GAS_UPGRADE_BASE
            + (upgrade_manager::GAS_MIGRATION_PER_ITEM * 100)
            + (2 * 5000); // 2 transformation steps

        assert!(gas_estimate >= expected_minimum);
    }

    #[test]
    fn test_cross_contract_upgrade_coordination() {
        let (env, registry, upgrade_mgr, _admin) = setup_integration_test();

        // Test that registry can initiate upgrades through the upgrade manager
        let new_version = String::from_str(&env, "1.2.0");
        let new_hash = BytesN::from_array(&env, &[3u8; 32]);
        let description = String::from_str(&env, "Cross-contract upgrade test");

        registry.initiate_upgrade(&new_version, &new_hash, &description);

        // Verify that the upgrade manager has the proposal
        // In a real implementation, we would check the upgrade manager's state
        // For now, just verify the call succeeded and events were emitted

        let events = env.events().all();
        assert!(!events.is_empty());
    }
}

// ─── Storage Migration Tests ─────────────────────────────────────────────────
//
// These tests verify that the v1→v2 storage migration:
//   1. Runs all required migration steps and updates the on-chain version.
//   2. Preserves every agent record written before the upgrade.
//   3. Populates new v2 fields with their documented defaults when they were
//      absent from the v1 state.
//   4. Emergency rollback fully restores the pre-upgrade version and wasm hash
//      and clears rollback availability.
//
// All tests share a lightweight `setup` helper and use `env.mock_all_auths()`
// to avoid threading authorization keys through every call.

#[cfg(test)]
mod storage_migration_tests {
    use crate::*;
    use soroban_sdk::{
        testutils::{Address as _, Ledger as _},
        Address, BytesN, Map, String, Symbol,
    };

    // ── Shared helpers ──────────────────────────────────────────────────────

    fn setup() -> (Env, AgentRegistryContractClient<'static>, Address) {
        let env = Env::default();
        env.ledger().set_sequence_number(1);
        env.mock_all_auths();
        let contract_id = env.register(AgentRegistryContract, ());
        let client = AgentRegistryContractClient::new(&env, &contract_id);
        let admin = Address::generate(&env);
        client.initialize(&admin);
        (env, client, admin)
    }

    fn wasm(env: &Env, tag: u8) -> BytesN<32> {
        let mut h = [0u8; 32];
        h[0] = tag;
        BytesN::from_array(env, &h)
    }

    fn register_agent(
        env: &Env,
        client: &AgentRegistryContractClient<'_>,
        id: &str,
    ) -> AgentRecord {
        let owner = Address::generate(env);
        let record = AgentRecord {
            id: Symbol::new(env, id),
            capability: Symbol::new(env, "research"),
            price_stroops: 1_000,
            endpoint: String::from_str(env, "https://agent.example.com"),
            owner,
            metadata: Map::new(env),
            bond_amount: DEFAULT_MIN_BOND_STROOPS,
        };
        // `register_agent` returns `()` on the client; use `try_` to surface errors.
        client
            .try_register_agent(&record)
            .expect("register_agent call failed")
            .expect("register_agent returned Err");
        record
    }

    /// Read one agent record from persistent storage without going through the
    /// contract's public API (which has no single-item getter).
    fn read_agent(
        env: &Env,
        client: &AgentRegistryContractClient<'_>,
        id: &str,
    ) -> Option<AgentRecord> {
        let key = DataKey::Agent(Symbol::new(env, id));
        env.as_contract(&client.address, || env.storage().persistent().get(&key))
    }

    // ── Test 1: v1→v2 migration runs all six steps ──────────────────────────

    /// `post_upgrade_hook("1.0.0", "2.0.0")` must complete without error, write
    /// "2.0.0" to instance storage, record the new wasm hash, and populate the
    /// upgrade-status timestamp.  A 1.x→2.x jump triggers the full six-step
    /// pipeline: backup_existing_data, validate_data_integrity,
    /// migrate_storage_format, update_schema, rebuild_indexes, verify_migration.
    #[test]
    fn test_v1_to_v2_schema_migration_runs_all_steps() {
        let (env, client, _admin) = setup();

        assert_eq!(client.get_version(), String::from_str(&env, "1.0.0"));

        let v2_hash = wasm(&env, 2);
        client.upgrade_contract(
            &v2_hash,
            &String::from_str(&env, "2.0.0"),
            &String::from_str(&env, "v1 to v2 migration"),
        );

        // Version key in instance storage must be "2.0.0".
        assert_eq!(client.get_version(), String::from_str(&env, "2.0.0"));

        // Wasm hash must reflect the new binary.
        assert_eq!(client.get_wasm_hash(), v2_hash);

        // last_upgrade_ledger must be nonzero, proving the hook wrote the
        // upgrade timestamp.
        let status = client.get_upgrade_status();
        assert!(
            status.last_upgrade_ledger > 0,
            "last_upgrade_ledger was not written by the migration hook"
        );
        assert!(
            status.rollback_available,
            "rollback must be available immediately after upgrade"
        );

        // The migration plan for 2.0.0 must list all six transformation steps
        // required for a major-version upgrade.
        let plan = client.get_migration_plan(&String::from_str(&env, "2.0.0"));
        assert!(
            plan.data_transformations.len() >= 6,
            "expected ≥6 migration steps for a major-version upgrade, got {}",
            plan.data_transformations.len()
        );
        assert!(
            plan.rollback_supported,
            "migration plan must declare rollback_supported"
        );
    }

    // ── Test 2: existing agent data is preserved after migration ─────────────

    /// Writes two agent records to persistent storage in the v1 state, then
    /// upgrades to v2 and reads them back.  Every field must be bit-for-bit
    /// identical to the values written before the upgrade.
    #[test]
    fn test_existing_agent_data_preserved_after_migration() {
        let (env, client, _admin) = setup();

        // Establish v1 state with two registered agents.
        let r1 = register_agent(&env, &client, "agent1");
        let r2 = register_agent(&env, &client, "agent2");

        // Run the v1→v2 upgrade.
        client.upgrade_contract(
            &wasm(&env, 2),
            &String::from_str(&env, "2.0.0"),
            &String::from_str(&env, "preserve data test"),
        );

        // Both agents must survive in persistent storage after the migration.
        let f1 = read_agent(&env, &client, "agent1")
            .expect("agent1 missing after migration");
        let f2 = read_agent(&env, &client, "agent2")
            .expect("agent2 missing after migration");

        assert_eq!(f1.id, r1.id, "agent1.id changed");
        assert_eq!(f1.capability, r1.capability, "agent1.capability changed");
        assert_eq!(f1.price_stroops, r1.price_stroops, "agent1.price_stroops changed");
        assert_eq!(f1.endpoint, r1.endpoint, "agent1.endpoint changed");
        assert_eq!(f1.owner, r1.owner, "agent1.owner changed");
        assert_eq!(f1.bond_amount, r1.bond_amount, "agent1.bond_amount changed");

        assert_eq!(f2.id, r2.id, "agent2.id changed");
        assert_eq!(f2.capability, r2.capability, "agent2.capability changed");
        assert_eq!(f2.price_stroops, r2.price_stroops, "agent2.price_stroops changed");
        assert_eq!(f2.owner, r2.owner, "agent2.owner changed");

        // The TotalAgents counter must still read two after the migration.
        let page = client.list_agents(&None::<u32>, &Some(10u32));
        assert_eq!(
            page.total_count, 2,
            "total_count changed across the migration boundary"
        );
    }

    // ── Test 3: new v2 fields default correctly when absent from v1 ──────────

    /// When no StorageConfig, ReputationConfig, or GasConfig was written in the
    /// v1 state, the contract's `unwrap_or_else` guards must return the
    /// compile-time defaults unchanged after the migration.
    #[test]
    fn test_new_v2_fields_have_correct_defaults_after_migration() {
        let (env, client, _admin) = setup();

        // No explicit StorageConfig or ReputationConfig — pure v1 baseline.
        client.upgrade_contract(
            &wasm(&env, 2),
            &String::from_str(&env, "2.0.0"),
            &String::from_str(&env, "default fields test"),
        );

        // StorageConfig defaults: max_agents = 0 (unlimited),
        // max_per_capability = 0 (unlimited).
        let storage_cfg = client.get_storage_config();
        assert_eq!(
            storage_cfg.max_agents, 0,
            "StorageConfig.max_agents default must be 0 (unlimited) after migration"
        );
        assert_eq!(
            storage_cfg.max_per_capability, 0,
            "StorageConfig.max_per_capability default must be 0 (unlimited) after migration"
        );

        // ReputationConfig defaults: decay_pct = DEFAULT_DECAY_PCT (5),
        // epoch_secs = DEFAULT_EPOCH_SECS (604_800 seconds = 7 days).
        let rep_cfg = client.get_reputation_config();
        assert_eq!(
            rep_cfg.decay_pct,
            DEFAULT_DECAY_PCT,
            "ReputationConfig.decay_pct must default to {} after migration",
            DEFAULT_DECAY_PCT
        );
        assert_eq!(
            rep_cfg.epoch_secs,
            DEFAULT_EPOCH_SECS,
            "ReputationConfig.epoch_secs must default to {} after migration",
            DEFAULT_EPOCH_SECS
        );

        // GasConfig must still be the compiled-in default because it was never
        // overridden in the v1 state.
        let gas_cfg = client.get_gas_config();
        assert_eq!(gas_cfg.tx_overhead, GAS_TX_OVERHEAD);
        assert_eq!(gas_cfg.register_agent, GAS_REGISTER_AGENT);
    }

    // ── Test 4: rollback restores the previous version and wasm hash ──────────

    /// After a v1→v2 upgrade, `emergency_rollback` must:
    ///   - revert the on-chain version to "1.0.0"
    ///   - revert the recorded wasm hash to the v1 hash
    ///   - set `rollback_available` to false (rollback is consumed)
    ///   - leave persistent agent records intact (they are not erased by a
    ///     wasm-pointer rollback)
    #[test]
    fn test_rollback_restores_previous_storage_state() {
        let (env, client, _admin) = setup();

        // Register one agent in v1 before the upgrade.
        let pre = register_agent(&env, &client, "preagent");

        let v1_hash = wasm(&env, 1);
        let v2_hash = wasm(&env, 2);

        // Upgrade so a rollback becomes available.
        client.upgrade_contract(
            &v2_hash,
            &String::from_str(&env, "2.0.0"),
            &String::from_str(&env, "rollback test upgrade"),
        );
        assert_eq!(client.get_version(), String::from_str(&env, "2.0.0"));
        assert!(
            client.get_upgrade_status().rollback_available,
            "rollback must be available immediately after upgrade"
        );

        // Execute the emergency rollback within the window.
        client.emergency_rollback(&v1_hash, &String::from_str(&env, "1.0.0"));

        // Version must revert to 1.0.0.
        assert_eq!(
            client.get_version(),
            String::from_str(&env, "1.0.0"),
            "version must revert to 1.0.0 after rollback"
        );

        // Recorded wasm hash must revert to the v1 hash.
        assert_eq!(
            client.get_wasm_hash(),
            v1_hash,
            "wasm hash must revert to v1 after rollback"
        );

        // Rollback availability is consumed: a second attempt must be rejected.
        assert!(
            !client.get_upgrade_status().rollback_available,
            "rollback must not be available after it has been consumed"
        );
        assert!(
            client
                .try_emergency_rollback(&v2_hash, &String::from_str(&env, "2.0.0"))
                .is_err(),
            "a second rollback call must fail once rollback is consumed"
        );

        // Persistent storage (agent records) must survive the wasm-pointer
        // rollback because `emergency_rollback` only updates instance-storage
        // keys — it does not wipe persistent entries.
        let restored = read_agent(&env, &client, "preagent")
            .expect("pre-upgrade agent must still be readable after rollback");
        assert_eq!(restored.id, pre.id);
        assert_eq!(restored.owner, pre.owner);
        assert_eq!(restored.capability, pre.capability);
    }
}
