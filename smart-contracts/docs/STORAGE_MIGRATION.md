# Storage Layout Migration Guide

This document provides guidance on safely migrating Soroban contract storage layouts when upgrading contracts.

## Overview

Soroban contracts store data in a key-value store where keys are defined by the contract and values are stored on-chain. When upgrading contracts, it's crucial to maintain compatibility with existing storage layouts to prevent data loss.

## Storage Layout Compatibility

### Safe Operations

These changes to your contract **DO NOT** require storage migration:

1. **Adding new storage keys** - New `DataKey` enum variants
2. **Adding new functions** - Contract interface extensions
3. **Modifying function logic** - Internal implementation changes
4. **Changing function parameters** - As long as storage keys remain the same
5. **Adding new fields to structs** - If the struct is not used as a storage key

### Unsafe Operations

These changes **REQUIRE** careful migration planning:

1. **Removing storage keys** - Data will become inaccessible
2. **Changing storage key types** - Existing data won't be readable
3. **Modifying struct layouts** used as storage values
4. **Changing enum discriminants** in `DataKey`
5. **Renaming `DataKey` variants**

## Migration Strategies

### Strategy 1: Additive Changes Only

The safest approach is to only make additive changes:

```rust
// Before
#[derive(Clone)]
#[contracttype]
pub enum DataKey {
    AgentRecord(Symbol),
    AgentIndex(Symbol),
}

// After - Safe addition
#[derive(Clone)]
#[contracttype]
pub enum DataKey {
    AgentRecord(Symbol),
    AgentIndex(Symbol),
    AgentStats(Symbol),    // New key added
}
```

### Strategy 2: Data Migration Pattern

For breaking changes, implement a migration function:

```rust
use soroban_sdk::{contract, contractimpl, Env, Symbol, Vec, Map};

#[contract]
pub struct MigrationContract;

#[contractimpl]
impl MigrationContract {
    /// Migrate data from old format to new format
    pub fn migrate_storage(env: Env, migration_version: u32) -> Result<(), Error> {
        let current_version: u32 = env.storage().instance()
            .get(&DataKey::MigrationVersion)
            .unwrap_or(0);
            
        if current_version >= migration_version {
            return Ok(()); // Already migrated
        }
        
        match migration_version {
            1 => migrate_v0_to_v1(&env)?,
            2 => migrate_v1_to_v2(&env)?,
            _ => return Err(Error::UnsupportedMigrationVersion),
        }
        
        // Update migration version
        env.storage().instance().set(&DataKey::MigrationVersion, &migration_version);
        Ok(())
    }
}

fn migrate_v0_to_v1(env: &Env) -> Result<(), Error> {
    // Example: Convert old AgentRecord format to new format
    let old_records = get_all_old_agent_records(env);
    
    for old_record in old_records {
        let new_record = convert_record_format(old_record);
        env.storage().persistent().set(&DataKey::AgentRecord(new_record.id.clone()), &new_record);
        
        // Remove old format data if necessary
        env.storage().persistent().remove(&DataKey::OldAgentRecord(new_record.id));
    }
    
    Ok(())
}
```

### Strategy 3: Versioned Storage

Use versioned storage keys to maintain backward compatibility:

```rust
#[derive(Clone)]
#[contracttype]
pub enum DataKey {
    // V1 keys (deprecated but still readable)
    AgentRecordV1(Symbol),
    
    // V2 keys (current version)
    AgentRecordV2(Symbol),
    AgentStatsV2(Symbol),
    
    // Metadata
    StorageVersion,
}

#[contractimpl]
impl AgentRegistryContract {
    pub fn get_agent(env: Env, agent_id: Symbol) -> Option<AgentRecord> {
        // Try V2 format first
        if let Some(record) = env.storage().persistent().get(&DataKey::AgentRecordV2(agent_id.clone())) {
            return Some(record);
        }
        
        // Fall back to V1 format and convert
        if let Some(old_record): Option<AgentRecordV1> = env.storage().persistent().get(&DataKey::AgentRecordV1(agent_id)) {
            return Some(convert_v1_to_v2(old_record));
        }
        
        None
    }
}
```

## Pre-Upgrade Checklist

Before performing a storage-incompatible upgrade:

1. **Analyze Storage Changes**
   ```bash
   # Compare storage keys between versions
   git diff HEAD~1 contracts/*/src/lib.rs | grep -A 10 -B 10 "DataKey"
   ```

2. **Test Migration Locally**
   ```bash
   # Deploy old version
   ./scripts/deploy.sh -n testnet
   
   # Add test data
   soroban contract invoke --id CXXX... --source $STELLAR_SECRET_KEY \
     --rpc-url https://soroban-testnet.stellar.org \
     -- register_agent --record '{"id":"test","capability":"research","price":100}'
   
   # Upgrade to new version
   ./scripts/upgrade.sh -n testnet
   
   # Verify data integrity
   soroban contract invoke --id CXXX... --source $STELLAR_SECRET_KEY \
     --rpc-url https://soroban-testnet.stellar.org \
     -- lookup_agents --capability research
   ```

3. **Create Backup Script**
   ```bash
   #!/bin/bash
   # backup-contract-state.sh
   
   CONTRACT_ID="$1"
   BACKUP_FILE="backup-$(date +%Y%m%d-%H%M%S).json"
   
   echo "Backing up contract state for $CONTRACT_ID..."
   
   # Export all agent records (example)
   soroban contract invoke --id "$CONTRACT_ID" \
     --source "$STELLAR_SECRET_KEY" \
     --rpc-url "$STELLAR_RPC_URL" \
     -- export_all_data > "$BACKUP_FILE"
   
   echo "Backup saved to $BACKUP_FILE"
   ```

4. **Document Migration Steps**
   Create a migration plan document:
   ```markdown
   # Migration Plan: Agent Registry v1.2.0
   
   ## Changes
   - Added AgentStats storage key
   - Modified AgentRecord struct to include performance_score field
   
   ## Migration Steps
   1. Deploy new contract version
   2. Call migrate_storage(2) function
   3. Verify all existing agents are accessible
   4. Test new functionality
   
   ## Rollback Plan
   - Keep old contract Wasm hash: abc123...
   - Rollback command: soroban contract upgrade --contract-id CXXX --wasm-hash abc123...
   ```

## Contract-Specific Guidance

### Agent Registry Contract

Current storage keys (as of v0.1.0):
```rust
pub enum DataKey {
    AgentRecord(Symbol),    // Maps agent_id -> AgentRecord
    CapabilityIndex(Symbol), // Maps capability -> Vec<Symbol> (agent IDs)
}
```

Safe additions for future versions:
- `AgentStats(Symbol)` - Performance metrics
- `AgentMetadata(Symbol)` - Extended metadata
- `SystemConfig` - Global configuration

### Error Resolver Contract

The error resolver contract stores:
```rust
// Currently no persistent storage - all data is embedded in Wasm
// Future versions can safely add any storage keys
```

## Testing Migration

### Unit Tests

```rust
#[cfg(test)]
mod migration_tests {
    use super::*;
    
    #[test]
    fn test_v1_to_v2_migration() {
        let env = Env::default();
        let contract_id = env.register_contract(None, AgentRegistryContract);
        let client = AgentRegistryContractClient::new(&env, &contract_id);
        
        // Setup v1 data
        setup_v1_test_data(&env);
        
        // Perform migration
        client.migrate_storage(&2);
        
        // Verify v2 data accessibility
        let agents = client.lookup_agents(&symbol_short!("research"));
        assert_eq!(agents.len(), 2);
    }
}
```

### Integration Tests

```bash
#!/bin/bash
# test-migration-e2e.sh

set -e

# Deploy v1 contract
echo "Deploying v1 contract..."
V1_WASM="target/wasm32-unknown-unknown/release/agent_registry_v1.wasm"
CONTRACT_ID=$(soroban contract deploy --wasm "$V1_WASM" --source "$STELLAR_SECRET_KEY" --rpc-url "$STELLAR_RPC_URL")

# Add test data
echo "Adding test data..."
soroban contract invoke --id "$CONTRACT_ID" --source "$STELLAR_SECRET_KEY" --rpc-url "$STELLAR_RPC_URL" \
  -- register_agent --record '{"id":"test1","capability":"research","price":100}'

# Upgrade to v2
echo "Upgrading to v2..."
V2_WASM="target/wasm32-unknown-unknown/release/agent_registry_v2.wasm"
soroban contract upgrade --contract-id "$CONTRACT_ID" --wasm-hash "$(soroban contract install --wasm "$V2_WASM" --source "$STELLAR_SECRET_KEY" --rpc-url "$STELLAR_RPC_URL")" --source "$STELLAR_SECRET_KEY" --rpc-url "$STELLAR_RPC_URL"

# Run migration
echo "Running migration..."
soroban contract invoke --id "$CONTRACT_ID" --source "$STELLAR_SECRET_KEY" --rpc-url "$STELLAR_RPC_URL" \
  -- migrate_storage --migration_version 2

# Verify data
echo "Verifying migrated data..."
RESULT=$(soroban contract invoke --id "$CONTRACT_ID" --source "$STELLAR_SECRET_KEY" --rpc-url "$STELLAR_RPC_URL" \
  -- lookup_agents --capability research)

if echo "$RESULT" | grep -q "test1"; then
  echo "✓ Migration successful"
else
  echo "✗ Migration failed"
  exit 1
fi
```

## Emergency Procedures

### Rollback Process

If an upgrade fails:

```bash
# 1. Get the previous Wasm hash from deployment metadata
OLD_HASH=$(jq -r '.contracts["agent-registry"].previous_wasm_hash' deployments/testnet.json)

# 2. Rollback to previous version
soroban contract upgrade \
  --contract-id "$CONTRACT_ID" \
  --wasm-hash "$OLD_HASH" \
  --source "$STELLAR_SECRET_KEY" \
  --rpc-url "$STELLAR_RPC_URL"

# 3. Verify rollback
./scripts/verify.sh -n testnet agent-registry
```

### Data Recovery

If data is corrupted:

1. **From Backup**
   ```bash
   # Restore from backup (custom implementation needed)
   soroban contract invoke --id "$CONTRACT_ID" \
     -- restore_from_backup --backup_data "$(cat backup.json)"
   ```

2. **From Horizon History**
   ```bash
   # Query Horizon for contract transactions
   curl "https://horizon-testnet.stellar.org/accounts/$PUBLIC_KEY/transactions?limit=200" \
     | jq '.records[] | select(.memo != null)'
   ```

## Best Practices

1. **Always test migrations on testnet first**
2. **Keep deployment metadata up to date**
3. **Use semantic versioning for storage layout changes**
4. **Document all storage format changes**
5. **Implement comprehensive backup procedures**
6. **Plan migration windows during low-usage periods**
7. **Monitor contract health after upgrades**

## Resources

- [Soroban Documentation](https://soroban.stellar.org/docs)
- [Contract Upgrade Examples](https://github.com/stellar/soroban-examples)
- [Storage Best Practices](https://soroban.stellar.org/docs/fundamentals-and-concepts/storage)
