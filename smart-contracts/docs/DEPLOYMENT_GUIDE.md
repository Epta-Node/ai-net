# Smart Contract Deployment and Upgrade Guide

This guide covers the complete deployment and upgrade workflow for ai-net smart contracts built on Soroban.

## Quick Start

### Initial Setup

```bash
# Initialize the deployment environment
cd smart-contracts
./scripts/manage.sh init

# Edit environment configuration
cp .env.example .env
# Fill in STELLAR_SECRET_KEY and VENICE_API_KEY
```

### Deploy Contracts

```bash
# Deploy to testnet
./scripts/manage.sh deploy -n testnet

# Check deployment status
./scripts/manage.sh status -n testnet
```

### Upgrade Contracts

```bash
# Always do dry-run first
./scripts/upgrade.sh --network testnet --dry-run

# Perform upgrade if dry-run succeeds
./scripts/upgrade.sh --network testnet
```

## Architecture Overview

The upgrade mechanism consists of several key components:

### Scripts Directory Structure

```
smart-contracts/scripts/
├── deploy.sh          # Initial contract deployment
├── upgrade.sh         # Contract upgrades with safety checks
├── verify.sh          # Deployment verification
└── manage.sh          # High-level management interface
```

### Deployment Metadata

```
smart-contracts/deployments/
├── testnet.json       # Testnet deployment metadata
├── futurenet.json     # Futurenet deployment metadata
├── mainnet.json       # Mainnet deployment metadata
└── *.json.template    # Templates for new networks
```

### Backup Storage

```
smart-contracts/backups/
├── testnet/           # Testnet backups
├── futurenet/         # Futurenet backups
└── mainnet/           # Mainnet backups
```

## Detailed Workflows

### Deployment Process

1. **Environment Check**: Validates dependencies and configuration
2. **Contract Build**: Compiles Rust contracts to optimized Wasm
3. **Hash Calculation**: Generates reproducible Wasm hashes
4. **Network Deployment**: Deploys contracts using Soroban CLI
5. **Metadata Storage**: Saves deployment info to version-controlled JSON
6. **Verification**: Optionally verifies deployment integrity

```bash
# Full deployment with verification
./scripts/deploy.sh --network testnet --verify

# Skip build step (use existing Wasm)
./scripts/deploy.sh --network testnet --skip-build
```

### Upgrade Process

1. **Build Check**: Ensures latest Wasm artifacts exist
2. **Upgrade Detection**: Compares deployed vs local Wasm hashes
3. **Safety Checks**: Validates contract exists and Wasm integrity
4. **State Backup**: Creates state snapshots before upgrade
5. **Upgrade Execution**: Uses Soroban contract upgrade command
6. **Metadata Update**: Records upgrade in deployment history

```bash
# Dry-run to see what would be upgraded
./scripts/upgrade.sh --network testnet --dry-run

# Upgrade specific contract
./scripts/upgrade.sh --network testnet agent-registry

# Force upgrade (skip safety checks)
./scripts/upgrade.sh --network testnet --force
```

### Verification Process

1. **Hash Verification**: Compares stored vs calculated Wasm hashes
2. **Health Checks**: Tests contract responsiveness
3. **Integrity Validation**: Verifies Wasm file format
4. **Report Generation**: Creates detailed verification report

```bash
# Verify all contracts
./scripts/verify.sh --network testnet

# Rebuild before verification
./scripts/verify.sh --network testnet --rebuild

# Use custom deployment file
./scripts/verify.sh --deployment-file custom.json
```

## Deployment Metadata Format

Each network has a deployment metadata file tracking contract state:

```json
{
  "network": "testnet",
  "rpc_url": "https://soroban-testnet.stellar.org",
  "horizon_url": "https://horizon-testnet.stellar.org",
  "deployed_at": "2024-07-18T15:30:00.000Z",
  "contracts": {
    "agent-registry": {
      "contract_id": "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      "wasm_hash": "abc123...",
      "deployed_at": "2024-07-18T15:30:00.000Z",
      "upgraded_at": "2024-07-18T16:00:00.000Z",
      "backups": [
        {
          "file": "backups/testnet/agent-registry-20240718-160000.json",
          "timestamp": "2024-07-18T16:00:00.000Z"
        }
      ]
    }
  },
  "deployment_history": [
    {
      "action": "deploy",
      "timestamp": "2024-07-18T15:30:00.000Z",
      "network": "testnet",
      "contracts": ["agent-registry", "error-resolver"]
    },
    {
      "action": "upgrade",
      "timestamp": "2024-07-18T16:00:00.000Z",
      "network": "testnet"
    }
  ]
}
```

## Safety Features

### Pre-Upgrade Checks

- **Contract Existence**: Verifies contract is accessible on network
- **Wasm Validation**: Checks file format and integrity
- **Hash Comparison**: Detects if upgrade is needed
- **Storage Layout**: Warns about potential compatibility issues

### State Backup

Before each upgrade, the system creates:

- Deployment metadata snapshots
- Contract state descriptions
- Rollback instructions

### Dry-Run Mode

All upgrade operations support dry-run mode:

```bash
# See what would be upgraded
./scripts/upgrade.sh --dry-run

# Preview changes without execution
./scripts/manage.sh upgrade --network testnet  # Interactive dry-run
```

## Network Configuration

### Testnet (Default)

- **RPC URL**: `https://soroban-testnet.stellar.org`
- **Horizon URL**: `https://horizon-testnet.stellar.org`
- **Network Passphrase**: `Test SDF Network ; September 2015`

### Futurenet

- **RPC URL**: `https://rpc-futurenet.stellar.org`
- **Horizon URL**: `https://horizon-futurenet.stellar.org`
- **Network Passphrase**: `Test SDF Future Network ; October 2022`

### Mainnet

- **RPC URL**: `https://soroban-rpc.stellar.org`
- **Horizon URL**: `https://horizon.stellar.org`
- **Network Passphrase**: `Public Global Stellar Network ; September 2015`

## CI/CD Integration

### GitHub Actions Workflow

The repository includes a comprehensive CI workflow (`.github/workflows/smart-contracts.yml`):

- **Reproducible Builds**: Ensures deterministic Wasm compilation
- **Automated Testing**: Runs unit and integration tests
- **Security Audits**: Checks for known vulnerabilities
- **Artifact Publishing**: Creates release artifacts with build reports

### Build Reproducibility

Each build generates a report with:

```json
{
  "build_info": {
    "timestamp": "2024-07-18T15:30:00.000Z",
    "rust_version": "1.74.0",
    "soroban_cli_version": "22.0.11",
    "git_commit": "abc123...",
    "git_ref": "refs/heads/main",
    "runner_os": "Linux"
  },
  "contracts": {
    "agent_registry": {
      "wasm_hash": "def456...",
      "file_size": 234567,
      "file_path": "target/wasm32-unknown-unknown/release/agent_registry.wasm"
    }
  }
}
```

## Storage Migration

For breaking changes that affect storage layout, see [STORAGE_MIGRATION.md](STORAGE_MIGRATION.md):

- Migration strategies
- Compatibility guidelines  
- Testing procedures
- Emergency rollback

## Troubleshooting

### Common Issues

**"Contract not found on network"**
```bash
# Verify deployment file matches network
./scripts/manage.sh status -n testnet

# Re-verify contract existence
./scripts/verify.sh -n testnet
```

**"Hash verification failed"**
```bash
# Rebuild contracts and check again
./scripts/verify.sh -n testnet --rebuild

# Check if contract was upgraded outside of scripts
soroban contract invoke --id CONTRACT_ID --help
```

**"Upgrade safety checks failed"**
```bash
# Use dry-run to see specific issues
./scripts/upgrade.sh --dry-run

# Force upgrade if checks are overly cautious
./scripts/upgrade.sh --force
```

### Recovery Procedures

**Rollback Upgrade**
```bash
# Get previous Wasm hash from deployment metadata
OLD_HASH=$(cat deployments/testnet.json | grep -A 5 "agent-registry" | grep "wasm_hash")

# Manual rollback using Soroban CLI
soroban contract upgrade \
  --contract-id CONTRACT_ID \
  --wasm-hash $OLD_HASH \
  --source $STELLAR_SECRET_KEY \
  --rpc-url $STELLAR_RPC_URL
```

**Restore from Backup**
```bash
# List available backups
ls -la backups/testnet/

# Restore deployment metadata
cp backups/testnet/deployment-20240718-160000.json deployments/testnet.json
```

## Environment Variables

### Required

- `STELLAR_SECRET_KEY`: Secret key for deployment account
- `VENICE_API_KEY`: API key for Venice AI (used in tests)

### Optional

- `STELLAR_RPC_URL`: Override default RPC URL
- `STELLAR_HORIZON_URL`: Override default Horizon URL
- `RUN_STELLAR_E2E_TESTS`: Enable E2E tests (default: false)

### Security Notes

- Never commit `.env` files to version control
- Use separate keys for different networks
- Rotate keys regularly for production deployments
- Consider using hardware wallets for mainnet operations

## Support and Resources

- [Soroban Documentation](https://soroban.stellar.org/docs)
- [Stellar Developer Discord](https://discord.gg/stellardev)
- [Repository Issues](../../issues)
- [STORAGE_MIGRATION.md](STORAGE_MIGRATION.md) for advanced migration scenarios
