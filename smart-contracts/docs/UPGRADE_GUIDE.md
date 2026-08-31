# Smart Contract Upgrade Guide

This guide explains how to safely upgrade ai-net smart contracts using the comprehensive upgrade mechanism with data migration, version tracking, and rollback capabilities.

## Overview

The ai-net smart contracts support two upgrade methods:

1. **Upgrade Manager** (Recommended): Safe upgrades with validation, migration hooks, and rollback support
2. **Direct Upgrade**: Traditional upgrade method for compatibility

> 📖 **Operator Runbook:** For step-by-step testnet deployment, migration verification, and emergency rollback commands, see the [Testnet Contract Upgrade Runbook](TESTNET_UPGRADE_RUNBOOK.md).

## Upgrade Manager Architecture

### Components

- **Upgrade Manager Contract**: Central coordinator for safe upgrades
- **Upgradeable Trait**: Interface implemented by upgradeable contracts
- **Migration Hooks**: Pre and post-upgrade data validation and transformation
- **Version Tracking**: Semantic versioning with compatibility checking
- **Rollback Mechanism**: 48-hour window for emergency rollbacks
- **Event System**: Comprehensive upgrade tracking and monitoring

### Safety Features

- ✅ **Pre-upgrade validation** - Ensures compatibility before upgrade
- ✅ **Data migration hooks** - Safely transform data during upgrades
- ✅ **Version compatibility checking** - Prevents incompatible upgrades
- ✅ **Gas budget estimation** - Estimates migration costs
- ✅ **Rollback support** - 48-hour emergency rollback window
- ✅ **Event tracking** - Complete audit trail of upgrades
- ✅ **Admin controls** - Only authorized admins can upgrade

## Quick Start

### Prerequisites

1. Contracts deployed on target network
2. `STELLAR_SECRET_KEY` environment variable set
3. Upgrade manager deployed and configured

### Basic Upgrade

```bash
# Upgrade all contracts using upgrade manager (safe)
./scripts/upgrade.sh -u

# Upgrade specific contract
./scripts/upgrade.sh -u agent-registry

# Upgrade to specific version
./scripts/upgrade.sh -u -v "1.2.0" agent-registry

# Dry run to see what would be upgraded
./scripts/upgrade.sh -u -d
```

### Direct Upgrade (Legacy)

```bash
# Direct upgrade without upgrade manager
./scripts/upgrade.sh agent-registry

# Force upgrade skipping safety checks
./scripts/upgrade.sh -f agent-registry
```

## Upgrade Procedures

### 1. Upgrade Manager Setup

First, deploy the upgrade manager if not already deployed:

```bash
# Deploy upgrade manager
./scripts/deploy.sh upgrade-manager

# Initialize upgrade manager
stellar contract invoke \
  --network testnet \
  --source-account $STELLAR_SECRET_KEY \
  --id $UPGRADE_MANAGER_ID \
  -- initialize \
  --admin $ADMIN_ADDRESS \
  --initial_version "1.0.0" \
  --initial_wasm_hash $INITIAL_WASM_HASH
```

### 2. Configure Contracts

Connect contracts to the upgrade manager:

```bash
# Set upgrade manager for agent registry
stellar contract invoke \
  --network testnet \
  --source-account $STELLAR_SECRET_KEY \
  --id $AGENT_REGISTRY_ID \
  -- set_upgrade_manager \
  --upgrade_manager $UPGRADE_MANAGER_ID
```

### 3. Safe Upgrade Process

#### Step 1: Check Current Status

```bash
# Check current version
stellar contract invoke \
  --network testnet \
  --source-account $STELLAR_SECRET_KEY \
  --id $CONTRACT_ID \
  -- get_version

# Get upgrade status
stellar contract invoke \
  --network testnet \
  --source-account $STELLAR_SECRET_KEY \
  --id $CONTRACT_ID \
  -- get_upgrade_status
```

#### Step 2: Test Compatibility

```bash
# Check upgrade compatibility
stellar contract invoke \
  --network testnet \
  --source-account $STELLAR_SECRET_KEY \
  --id $CONTRACT_ID \
  -- check_upgrade_compatibility \
  --target_version "1.1.0"
```

#### Step 3: Perform Upgrade

```bash
# Upgrade using script (recommended)
./scripts/upgrade.sh -u -v "1.1.0" agent-registry

# Or manually via upgrade manager
stellar contract invoke \
  --network testnet \
  --source-account $STELLAR_SECRET_KEY \
  --id $UPGRADE_MANAGER_ID \
  -- propose_upgrade \
  --new_version "1.1.0" \
  --new_wasm_hash $NEW_WASM_HASH \
  --description "Upgrade to version 1.1.0" \
  --migration_plan $MIGRATION_PLAN

stellar contract invoke \
  --network testnet \
  --source-account $STELLAR_SECRET_KEY \
  --id $UPGRADE_MANAGER_ID \
  -- validate_proposal

stellar contract invoke \
  --network testnet \
  --source-account $STELLAR_SECRET_KEY \
  --id $UPGRADE_MANAGER_ID \
  -- execute_upgrade
```

#### Step 4: Verify Upgrade

```bash
# Check new version
stellar contract invoke \
  --network testnet \
  --source-account $STELLAR_SECRET_KEY \
  --id $CONTRACT_ID \
  -- get_version

# Verify contract functionality
stellar contract invoke \
  --network testnet \
  --source-account $STELLAR_SECRET_KEY \
  --id $CONTRACT_ID \
  -- lookup_agents \
  --capability research
```

### 4. Emergency Rollback

If issues are discovered within 48 hours:

```bash
# Check rollback availability
stellar contract invoke \
  --network testnet \
  --source-account $STELLAR_SECRET_KEY \
  --id $UPGRADE_MANAGER_ID \
  -- can_rollback

# Perform rollback
stellar contract invoke \
  --network testnet \
  --source-account $STELLAR_SECRET_KEY \
  --id $UPGRADE_MANAGER_ID \
  -- rollback_upgrade

# Or via contract directly
stellar contract invoke \
  --network testnet \
  --source-account $STELLAR_SECRET_KEY \
  --id $CONTRACT_ID \
  -- emergency_rollback \
  --rollback_wasm_hash $PREVIOUS_WASM_HASH \
  --rollback_version "1.0.0"
```

## Migration Guide

### Data Migration Hooks

Contracts implement migration hooks for safe data transformation:

#### Pre-upgrade Hook
- Validates data integrity
- Checks storage format compatibility  
- Estimates migration gas costs
- Verifies admin permissions

#### Post-upgrade Hook
- Migrates data to new formats
- Updates storage keys if needed
- Rebuilds indexes
- Validates migration results

### Migration Planning

Create migration plans for complex upgrades:

```json
{
  "pre_migration_checks": [
    "validate_data_integrity",
    "check_storage_compatibility",
    "verify_admin_access"
  ],
  "data_transformations": [
    "migrate_agent_records",
    "update_storage_keys",
    "convert_metadata_format"
  ],
  "post_migration_validations": [
    "verify_data_integrity",
    "validate_indexes",
    "check_functionality"
  ],
  "estimated_items": 100
}
```

### Version Compatibility

The system enforces semantic versioning rules:

- ✅ **Patch upgrades** (1.0.0 → 1.0.1): Minimal migration
- ✅ **Minor upgrades** (1.0.0 → 1.1.0): Selective migration  
- ✅ **Major upgrades** (1.0.0 → 2.0.0): Full migration required
- ❌ **Downgrades**: Blocked (use rollback instead)

## Monitoring and Events

### Upgrade Events

Monitor upgrade progress via events:

- `UpgradeProposed`: New upgrade proposed
- `UpgradeValidated`: Proposal validation complete
- `UpgradeApplied`: Upgrade successfully applied
- `UpgradeRolledBack`: Upgrade rolled back
- `MigrationProgress`: Migration step progress
- `MigrationComplete`: Migration finished

### Event Filtering

```bash
# Monitor upgrade events
stellar events --network testnet \
  --start-ledger $START_LEDGER \
  --contract $UPGRADE_MANAGER_ID \
  --topic upgrade

# Monitor specific contract upgrades
stellar events --network testnet \
  --start-ledger $START_LEDGER \
  --contract $CONTRACT_ID \
  --topic registry upgraded
```

## Troubleshooting

### Common Issues

#### Upgrade Compatibility Fails
```bash
# Check specific compatibility issues
stellar contract invoke \
  --network testnet \
  --source-account $STELLAR_SECRET_KEY \
  --id $CONTRACT_ID \
  -- check_upgrade_compatibility \
  --target_version "2.0.0"

# Review compatibility report and migration requirements
```

#### Migration Fails
```bash
# Check migration plan
stellar contract invoke \
  --network testnet \
  --source-account $STELLAR_SECRET_KEY \
  --id $CONTRACT_ID \
  -- get_migration_plan \
  --target_version "2.0.0"

# Estimate gas requirements
stellar contract invoke \
  --network testnet \
  --source-account $STELLAR_SECRET_KEY \
  --id $UPGRADE_MANAGER_ID \
  -- estimate_migration_gas \
  --migration_plan $MIGRATION_PLAN
```

#### Rollback Needed
```bash
# Check rollback window
stellar contract invoke \
  --network testnet \
  --source-account $STELLAR_SECRET_KEY \
  --id $CONTRACT_ID \
  -- get_upgrade_status

# Perform emergency rollback if within 48h window
./scripts/upgrade.sh --rollback agent-registry
```

### Recovery Procedures

#### State Backup
Upgrade scripts automatically backup state before upgrades:

```bash
# Manual state backup
mkdir -p backups/$NETWORK
stellar contract invoke \
  --network testnet \
  --source-account $STELLAR_SECRET_KEY \
  --id $CONTRACT_ID \
  -- get_upgrade_status > "backups/$NETWORK/status-$(date -u +%Y%m%d_%H%M%S).json"
```

#### Failed Upgrade Recovery
If an upgrade fails partially:

1. Check upgrade status and events
2. Identify failure point from logs
3. Use rollback if within 48h window
4. Otherwise, prepare recovery upgrade
5. Test recovery on testnet first

## Best Practices

### Pre-Upgrade Checklist

- [ ] Test upgrade on testnet first
- [ ] Backup critical state data
- [ ] Verify migration plan completeness
- [ ] Check gas budget estimates
- [ ] Confirm admin access
- [ ] Plan rollback strategy
- [ ] Notify stakeholders

### During Upgrade

- [ ] Monitor events for progress
- [ ] Watch for error conditions
- [ ] Verify each step completes
- [ ] Test basic functionality after upgrade
- [ ] Document any issues encountered

### Post-Upgrade

- [ ] Verify all functionality works
- [ ] Check data integrity
- [ ] Monitor performance metrics
- [ ] Update documentation
- [ ] Plan next upgrade cycle

### Security Considerations

- 🔒 **Admin Keys**: Secure admin private keys properly
- 🔒 **Multi-sig**: Consider multi-signature for production upgrades
- 🔒 **Time Windows**: Use rollback window appropriately
- 🔒 **Testing**: Always test upgrades on testnet first
- 🔒 **Monitoring**: Set up alerts for upgrade events
- 🔒 **Validation**: Never skip pre-upgrade validation

## Script Reference

### upgrade.sh Options

```bash
Usage: ./scripts/upgrade.sh [OPTIONS] [CONTRACT_NAME]

Options:
  -n, --network NETWORK     Network (testnet|futurenet|mainnet)
  -s, --skip-build         Skip Wasm build step
  -b, --skip-backup        Skip state backup
  -f, --force              Skip safety checks
  -d, --dry-run            Show changes without applying
  -u, --use-upgrade-manager Use upgrade manager (recommended)
  -r, --no-rollback        Disable rollback capability
  -v, --version VERSION    Set explicit version
  -h, --help               Show help
```

### Environment Variables

```bash
# Required
export STELLAR_SECRET_KEY="SXXX..."

# Optional (uses network defaults if not set)
export STELLAR_RPC_URL="https://soroban-testnet.stellar.org"
export STELLAR_HORIZON_URL="https://horizon-testnet.stellar.org"
```

## Network-Specific Notes

### Testnet
- Use for testing upgrades before production
- Friendbot available for funding
- Reset periodically, don't rely for permanent storage

### Futurenet  
- Latest Soroban features available
- May have breaking changes
- Use for testing new capabilities

### Mainnet
- Production environment
- Real XLM costs for transactions
- Extra caution required
- Consider multi-sig for admin operations

## Support

For upgrade-related issues:

1. Check the troubleshooting section above
2. Review upgrade events and logs
3. Test recovery procedures on testnet
4. Contact the development team with specific error details

## Changelog

### v1.0.0
- Initial upgrade mechanism implementation
- Basic version tracking and rollback support
- Pre/post migration hooks
- Comprehensive event system
- Safe upgrade scripts and documentation