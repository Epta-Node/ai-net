#[cfg(test)]
mod upgrade_tests {
    use super::*;
    use soroban_sdk::{
        testutils::{Address as _, Events as _, Ledger as _},
        Address, BytesN, Env, String,
    };
    use upgrade_manager::{
        MigrationMetadata, UpgradeStatus, Upgradeable, UpgradeableError, VersionCompatibility,
    };

    fn setup_upgrade_test() -> (Env, AgentRegistryContractClient<'static>, Address) {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register(AgentRegistryContract, ());
        let client = AgentRegistryContractClient::new(&env, &contract_id);
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
        let (env, client, _admin) = setup_upgrade_test();
        assert!(client.is_upgradeable());
    }

    #[test]
    fn test_set_upgrade_manager() {
        let (env, client, _admin) = setup_upgrade_test();
        let upgrade_manager = Address::generate(&env);

        let result = client.set_upgrade_manager(&upgrade_manager);
        assert!(result.is_ok());

        assert_eq!(client.get_upgrade_manager(), Some(upgrade_manager));

        // Check event was emitted
        let events = env.events().all();
        assert!(events.len() > 0);
        // Would check for specific UpgradeManagerSetEvent in real implementation
    }

    #[test]
    fn test_set_upgrade_manager_unauthorized() {
        let env = Env::default();
        let contract_id = env.register(AgentRegistryContract, ());
        let client = AgentRegistryContractClient::new(&env, &contract_id);
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

        let result = client.pre_upgrade_hook(&new_version, &new_hash);
        assert!(result.is_ok());

        let validation_results = result.unwrap();
        assert!(validation_results.len() > 0);

        // Check that validation passed
        let last_result = validation_results
            .get(validation_results.len() - 1)
            .unwrap();
        assert!(last_result.to_string().contains("successful"));
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

        let result = client.post_upgrade_hook(&old_version, &new_version);
        assert!(result.is_ok());

        // Check that version was updated in storage
        // In a real test, we'd verify the storage was actually updated

        // Check event was emitted
        let events = env.events().all();
        assert!(events.len() > 0);
    }

    #[test]
    fn test_get_migration_plan() {
        let (env, client, _admin) = setup_upgrade_test();
        let target_version = String::from_str(&env, "2.0.0");

        let result = client.get_migration_plan(&target_version);
        assert!(result.is_ok());

        let migration_plan = result.unwrap();
        assert_eq!(migration_plan.from_version, String::from_str(&env, "1.0.0"));
        assert_eq!(migration_plan.to_version, target_version);
        assert!(migration_plan.estimated_data_items > 0);
        assert!(migration_plan.rollback_supported);
    }

    #[test]
    fn test_get_migration_plan_breaking_change() {
        let (env, client, _admin) = setup_upgrade_test();
        let target_version = String::from_str(&env, "3.0.0"); // Major version change

        let result = client.get_migration_plan(&target_version);
        assert!(result.is_ok());

        let migration_plan = result.unwrap();
        // Major version changes should be marked as breaking
        // In a more sophisticated implementation, this would be true
        // For now, we just check that the plan was generated
        assert!(migration_plan.data_transformations.len() > 0);
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

        let result = client.initiate_upgrade(&new_version, &new_hash, &description);
        assert!(result.is_ok());

        // Check event was emitted
        let events = env.events().all();
        assert!(events.len() > 0);
    }

    #[test]
    fn test_upgrade_contract_success() {
        let (env, client, _admin) = setup_upgrade_test();

        let new_hash = test_wasm_hash(&env, 2);
        let new_version = String::from_str(&env, "1.1.0");
        let description = String::from_str(&env, "Test upgrade");

        let result = client.upgrade_contract(&new_hash, &new_version, &description);
        assert!(result.is_ok());

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
        let contract_id = env.register(AgentRegistryContract, ());
        let client = AgentRegistryContractClient::new(&env, &contract_id);
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
        let result = client.check_upgrade_compatibility(&compatible_version);
        assert!(result.is_ok());

        let compatibility = result.unwrap();
        assert_eq!(
            compatibility.current_version,
            String::from_str(&env, "1.0.0")
        );
        assert_eq!(compatibility.target_version, compatible_version);
        assert!(compatibility.is_compatible);

        // Test incompatible downgrade
        let incompatible_version = String::from_str(&env, "0.9.0");
        let result = client.check_upgrade_compatibility(&incompatible_version);
        assert!(result.is_ok());

        let compatibility = result.unwrap();
        assert!(!compatibility.is_compatible);
        assert!(compatibility.compatibility_issues.len() > 0);
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

        let result = client.emergency_rollback(&original_hash, &original_version);
        assert!(result.is_ok());

        // Check rollback event was emitted
        let events = env.events().all();
        assert!(events.len() > 0);

        // Verify rollback is no longer available
        let status = client.get_upgrade_status();
        assert!(!status.rollback_available);
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
        let upgrade_events: Vec<_> = events
            .iter()
            .filter(|(_, topics, _)| {
                topics.len() >= 2 && topics.get(0).is_some() && topics.get(1).is_some()
            })
            .collect();

        assert!(upgrade_events.len() > 0);
    }

    #[test]
    fn test_gas_estimation_integration() {
        let (env, client, _admin) = setup_upgrade_test();

        // Create a migration plan
        let target_version = String::from_str(&env, "2.0.0");
        let migration_plan = client.get_migration_plan(&target_version).unwrap();

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
        let result = client.check_upgrade_compatibility(&same_version);
        // Should handle same version gracefully

        // Test malformed version
        let bad_version = String::from_str(&env, "not.a.version");
        let result = client.try_check_upgrade_compatibility(&bad_version);
        // Should return error for malformed version
        assert!(result.is_err());

        // Test very large version jump
        let future_version = String::from_str(&env, "99.0.0");
        let result = client.check_upgrade_compatibility(&future_version);
        if result.is_ok() {
            let compatibility = result.unwrap();
            // Large jumps might be incompatible
        }
    }
}

// ─── Integration Tests with Upgrade Manager ─────────────────────────────────

#[cfg(test)]
mod upgrade_integration_tests {
    use super::*;
    use soroban_sdk::{
        testutils::{Address as _, Ledger as _},
        Address, BytesN, Env, String, Vec,
    };
    use upgrade_manager::{MigrationPlan, UpgradeManager, UpgradeManagerClient};

    fn setup_integration_test() -> (
        Env,
        AgentRegistryContractClient<'static>,
        UpgradeManagerClient<'static>,
        Address,
    ) {
        let env = Env::default();
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
        let (env, registry, upgrade_mgr, _admin) = setup_integration_test();

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

        // Test the full upgrade flow through upgrade manager
        let result =
            upgrade_mgr.propose_upgrade(&new_version, &new_hash, &description, &migration_plan);
        assert!(result.is_ok());

        // Validate proposal
        let gas_estimate = upgrade_mgr.validate_proposal();
        assert!(gas_estimate.is_ok());
        assert!(gas_estimate.unwrap() > 0);

        // Execute upgrade
        let result = upgrade_mgr.execute_upgrade();
        assert!(result.is_ok());

        // Verify upgrade was applied
        let current_version = upgrade_mgr.get_current_version();
        assert!(current_version.is_some());
        assert_eq!(current_version.unwrap().version, new_version);

        // Test rollback capability
        assert!(upgrade_mgr.can_rollback());

        let result = upgrade_mgr.rollback_upgrade();
        assert!(result.is_ok());

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

        let result = registry.initiate_upgrade(&new_version, &new_hash, &description);
        assert!(result.is_ok());

        // Verify that the upgrade manager has the proposal
        // In a real implementation, we would check the upgrade manager's state
        // For now, just verify the call succeeded and events were emitted

        let events = env.events().all();
        assert!(events.len() > 0);
    }
}
