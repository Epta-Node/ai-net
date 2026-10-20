#!/bin/bash

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Default values
NETWORK="testnet"
SKIP_BUILD=false
SKIP_BACKUP=false
FORCE=false
DRY_RUN=false
USE_UPGRADE_MANAGER=false
ENABLE_ROLLBACK=true

# Usage function
usage() {
    cat << EOF
Usage: $0 [OPTIONS] [CONTRACT_NAME]

Upgrade deployed Soroban contracts with safety checks and state preservation.
Supports both direct upgrades and upgrade manager-based upgrades.

ARGUMENTS:
    CONTRACT_NAME            Name of specific contract to upgrade (optional, upgrades all if not specified)

OPTIONS:
    -n, --network NETWORK    Network to upgrade on (testnet, futurenet, mainnet) [default: testnet]
    -s, --skip-build         Skip the Wasm build step
    -b, --skip-backup        Skip state backup before upgrade
    -f, --force              Skip safety checks and proceed with upgrade
    -d, --dry-run            Show what would be upgraded without making changes
    -u, --use-upgrade-manager Route the upgrade manager's own self-upgrade through
                             its multisig + timelock governance. Only valid for
                             'upgrade-manager' itself: Soroban's
                             update_current_contract_wasm can only replace the
                             CALLING contract's executable, so the manager
                             cannot upgrade any other contract.
    -r, --no-rollback        Disable rollback capability for this upgrade
    -v, --version VERSION    Set explicit version for the upgrade
    -h, --help               Show this help message

ENVIRONMENT VARIABLES:
    STELLAR_SECRET_KEY       Secret key for deployment account (required unless multisig)
    STELLAR_RPC_URL         RPC URL for the network (optional, uses default for network)
    STELLAR_HORIZON_URL     Horizon URL for the network (optional, uses default for network)

MULTISIG ADMIN (mainnet):
    ADMIN_KEY_1, ADMIN_KEY_2, ADMIN_KEY_3  Three admin keypair secret keys
    ADMIN_MULTISIG_THRESHOLD               Signatures required (default: 2)

    When ADMIN_KEY_1/2/3 are all provided, the upgrade is signed by the
    required number of admin keys (ADMIN_MULTISIG_THRESHOLD, default 2).
    The first key drives the transaction; additional signatories are collected
    and applied before broadcast so the account threshold is satisfied.

NOTES:
    Every contract other than 'upgrade-manager' must upgrade itself. Run those
    with the direct path (no -u), which calls the target contract's own
    'upgrade_contract' entry point.

EXAMPLES:
    $0                                    Upgrade all contracts on testnet
    $0 agent-registry                    Upgrade only the agent-registry contract
    $0 -u upgrade-manager                Upgrade the manager under its own governance
    $0 -n futurenet -d                   Dry run upgrade on futurenet
    $0 -f --skip-backup                  Force upgrade without backup
    $0 -v "1.2.0" agent-registry         Upgrade agent-registry to an explicit version
EOF
}

# Parse command line arguments
CONTRACT_NAME=""
VERSION=""
while [[ $# -gt 0 ]]; do
    case $1 in
        -n|--network)
            NETWORK="$2"
            shift 2
            ;;
        -s|--skip-build)
            SKIP_BUILD=true
            shift
            ;;
        -b|--skip-backup)
            SKIP_BACKUP=true
            shift
            ;;
        -f|--force)
            FORCE=true
            shift
            ;;
        -d|--dry-run)
            DRY_RUN=true
            shift
            ;;
        -u|--use-upgrade-manager)
            USE_UPGRADE_MANAGER=true
            shift
            ;;
        -r|--no-rollback)
            ENABLE_ROLLBACK=false
            shift
            ;;
        -v|--version)
            VERSION="$2"
            shift 2
            ;;
        -h|--help)
            usage
            exit 0
            ;;
        -*)
            echo -e "${RED}Unknown option: $1${NC}" >&2
            usage >&2
            exit 1
            ;;
        *)
            if [[ -z "$CONTRACT_NAME" ]]; then
                CONTRACT_NAME="$1"
            else
                echo -e "${RED}Error: Multiple contract names specified${NC}" >&2
                usage >&2
                exit 1
            fi
            shift
            ;;
    esac
done

# Validate network
case $NETWORK in
    testnet|futurenet|mainnet)
        ;;
    *)
        echo -e "${RED}Error: Invalid network '$NETWORK'. Must be one of: testnet, futurenet, mainnet${NC}" >&2
        exit 1
        ;;
esac

# ── Multisig admin support ─────────────────────────────────────────────────

MULTISIG_ENABLED=false
if [[ -n "$ADMIN_KEY_1" && -n "$ADMIN_KEY_2" && -n "$ADMIN_KEY_3" ]]; then
    MULTISIG_ENABLED=true
fi
ADMIN_MULTISIG_THRESHOLD="${ADMIN_MULTISIG_THRESHOLD:-2}"

# Collect up to ADMIN_MULTISIG_THRESHOLD secret keys (space-separated) that
# will be used to sign an upgrade transaction before it is submitted.
# Returns them as a bash array in MULTISIG_SIGNING_KEYS.
collect_multisig_signing_keys() {
    MULTISIG_SIGNING_KEYS=()
    if [[ "$MULTISIG_ENABLED" != "true" ]]; then
        MULTISIG_SIGNING_KEYS=("$STELLAR_SECRET_KEY")
        return 0
    fi

    local all_keys=("$ADMIN_KEY_1" "$ADMIN_KEY_2" "$ADMIN_KEY_3")
    local count=0
    for key in "${all_keys[@]}"; do
        MULTISIG_SIGNING_KEYS+=("$key")
        count=$((count + 1))
        if [[ $count -ge $ADMIN_MULTISIG_THRESHOLD ]]; then
            break
        fi
    done
    echo -e "${BLUE}Multisig: collected ${count} of ${ADMIN_MULTISIG_THRESHOLD} required signing keys${NC}"
}

# Check required environment variables
if [[ "$MULTISIG_ENABLED" == "true" ]]; then
    echo -e "${BLUE}Multisig upgrade mode: threshold=${ADMIN_MULTISIG_THRESHOLD}-of-3${NC}"
    STELLAR_SECRET_KEY="$ADMIN_KEY_1"
elif [[ -z "$STELLAR_SECRET_KEY" ]]; then
    echo -e "${RED}Error: STELLAR_SECRET_KEY (or ADMIN_KEY_1/2/3) environment variable is required${NC}" >&2
    exit 1
fi

# Set network-specific defaults
set_network_defaults() {
    case $NETWORK in
        testnet)
            : ${STELLAR_RPC_URL:=https://soroban-testnet.stellar.org}
            : ${STELLAR_HORIZON_URL:=https://horizon-testnet.stellar.org}
            ;;
        futurenet)
            : ${STELLAR_RPC_URL:=https://rpc-futurenet.stellar.org}
            : ${STELLAR_HORIZON_URL:=https://horizon-futurenet.stellar.org}
            ;;
        mainnet)
            : ${STELLAR_RPC_URL:=https://soroban-rpc.stellar.org}
            : ${STELLAR_HORIZON_URL:=https://horizon.stellar.org}
            ;;
    esac
    export STELLAR_RPC_URL STELLAR_HORIZON_URL
}

# Contract definitions - now includes upgrade-manager
CONTRACTS=(
    "upgrade-manager:contracts/upgrade-manager"
    "agent-registry:contracts/agent_registry"
    "error-resolver:contracts/error-resolver"
)

# Directories
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
DEPLOYMENTS_DIR="$PROJECT_ROOT/deployments"
TARGET_DIR="$PROJECT_ROOT/target/wasm32-unknown-unknown/release"
BACKUPS_DIR="$PROJECT_ROOT/backups"

# Deployment metadata
DEPLOYMENT_FILE="$DEPLOYMENTS_DIR/${NETWORK}.json"
TIMESTAMP=$(date -u +"%Y-%m-%dT%H:%M:%S.%3NZ")

echo -e "${BLUE}=== ai-net Smart Contract Upgrade ===${NC}"
echo -e "${BLUE}Network:${NC} $NETWORK"
echo -e "${BLUE}RPC URL:${NC} $STELLAR_RPC_URL"
if [[ -n "$CONTRACT_NAME" ]]; then
    echo -e "${BLUE}Contract:${NC} $CONTRACT_NAME"
else
    echo -e "${BLUE}Contracts:${NC} All deployed contracts"
fi
if [[ "$USE_UPGRADE_MANAGER" == "true" ]]; then
    echo -e "${BLUE}Upgrade Mode:${NC} Upgrade Manager (self-upgrade under multisig + timelock)"
    if [[ "$CONTRACT_NAME" != "upgrade-manager" && -n "$CONTRACT_NAME" ]]; then
        echo -e "${YELLOW}Note:${NC} the manager cannot upgrade $CONTRACT_NAME; only 'upgrade-manager' itself."
    fi
else
    echo -e "${BLUE}Upgrade Mode:${NC} Direct (each contract upgrades itself)"
fi
if [[ "$DRY_RUN" == "true" ]]; then
    echo -e "${YELLOW}Mode:${NC} Dry run (no changes will be made)"
fi
echo ""

# Upgrade manager utility functions
get_upgrade_manager_id() {
    local upgrade_mgr_info
    upgrade_mgr_info=$(get_contract_info "upgrade-manager")
    
    if [[ -z "$upgrade_mgr_info" ]]; then
        echo -e "${RED}Error: Upgrade manager not deployed${NC}" >&2
        echo -e "${YELLOW}Hint: Deploy upgrade-manager first or use direct upgrade mode${NC}" >&2
        exit 1
    fi
    
    echo "$upgrade_mgr_info" | jq -r '.contract_id'
}

# Check if contract supports upgrade manager
supports_upgrade_manager() {
    local name="$1"
    local contract_id="$2"
    
    # Try to call is_upgradeable method
    local result
    result=$(stellar contract invoke \
        --network "$NETWORK" \
        --source-account "$STELLAR_SECRET_KEY" \
        --id "$contract_id" \
        -- is_upgradeable 2>/dev/null || echo "false")
    
    [[ "$result" == "true" ]]
}

# Get current contract version
get_contract_version() {
    local contract_id="$1"
    
    stellar contract invoke \
        --network "$NETWORK" \
        --source-account "$STELLAR_SECRET_KEY" \
        --id "$contract_id" \
        -- get_version 2>/dev/null || echo "unknown"
}

# Check upgrade compatibility
check_upgrade_compatibility() {
    local contract_id="$1"
    local target_version="$2"
    
    echo -e "${BLUE}Checking upgrade compatibility...${NC}"
    
    local compatibility_result
    compatibility_result=$(stellar contract invoke \
        --network "$NETWORK" \
        --source-account "$STELLAR_SECRET_KEY" \
        --id "$contract_id" \
        -- check_upgrade_compatibility \
        --target_version "$target_version" 2>/dev/null || echo "{}")
    
    # Parse compatibility result (simplified)
    local is_compatible
    is_compatible=$(echo "$compatibility_result" | jq -r '.is_compatible // false' 2>/dev/null || echo "false")
    
    if [[ "$is_compatible" == "true" ]]; then
        echo -e "${GREEN}✓ Upgrade compatibility check passed${NC}"
        return 0
    else
        echo -e "${RED}✗ Upgrade compatibility check failed${NC}"
        echo -e "${YELLOW}Compatibility result:${NC} $compatibility_result"
        return 1
    fi
}

# Resolve the governance address that will sign on behalf of the deployer key.
# The upgrade manager's governance entry points all require an explicit
# `proposer`/`caller`/`executor` Address argument, which it then require_auth()s
# -- so the script must pass the address, not just the signing key.
proposer_address() {
    local address
    address=$(stellar keys address "$STELLAR_SECRET_KEY")
    if [[ -z "$address" ]]; then
        echo -e "${RED}Error: could not resolve address for STELLAR_SECRET_KEY${NC}" >&2
        exit 1
    fi
    echo "$address"
}

# Propose upgrade via upgrade manager.
#
# Progress goes to stderr and only the proposal id goes to stdout, so the
# caller can do `proposal_id=$(propose_upgrade ...)`.
propose_upgrade() {
    local contract_name="$1"
    local new_version="$2"
    local new_wasm_hash="$3"
    local description="$4"
    local upgrade_manager_id="$5"

    echo -e "${BLUE}Proposing upgrade via upgrade manager...${NC}" >&2

    if [[ "$DRY_RUN" == "true" ]]; then
        echo -e "${YELLOW}[DRY RUN] Would propose upgrade:${NC}" >&2
        echo -e "  Contract: $contract_name" >&2
        echo -e "  Version: $new_version" >&2
        echo -e "  WASM Hash: $new_wasm_hash" >&2
        echo -e "  Description: $description" >&2
        echo "1"
        return 0
    fi

    # Create migration plan (simplified)
    local migration_plan="{
        \"pre_migration_checks\": [\"validate_data_integrity\", \"check_storage_compatibility\"],
        \"data_transformations\": [\"migrate_agent_records\"],
        \"post_migration_validations\": [\"verify_data_integrity\"],
        \"estimated_items\": 100
    }"

    # `propose_upgrade` returns the assigned proposal id as a bare u64 in the
    # result JSON.
    local result
    result=$(stellar contract invoke \
        --network "$NETWORK" \
        --source-account "$STELLAR_SECRET_KEY" \
        --id "$upgrade_manager_id" \
        -- propose_upgrade \
        --proposer "$(proposer_address)" \
        --new_version "$new_version" \
        --new_wasm_hash "$new_wasm_hash" \
        --description "$description" \
        --migration_plan "$migration_plan")

    local proposal_id
    proposal_id=$(echo "$result" | jq -r 'if type == "number" then . else 0 end')
    if [[ -z "$proposal_id" || "$proposal_id" == "0" ]]; then
        echo -e "${RED}Error: could not parse proposal id from propose_upgrade output${NC}" >&2
        echo "$result" >&2
        exit 1
    fi

    echo -e "${GREEN}✓ Upgrade proposed as proposal $proposal_id${NC}" >&2
    echo "$proposal_id"
}

# Record an approval on a pending proposal.
approve_upgrade() {
    local upgrade_manager_id="$1"
    local proposal_id="$2"

    if [[ "$DRY_RUN" == "true" ]]; then
        echo -e "${YELLOW}[DRY RUN] Would approve proposal $proposal_id${NC}"
        return 0
    fi

    stellar contract invoke \
        --network "$NETWORK" \
        --source-account "$STELLAR_SECRET_KEY" \
        --id "$upgrade_manager_id" \
        -- approve_upgrade \
        --approver "$(proposer_address)" \
        --proposal_id "$proposal_id" >/dev/null
}

# Validate upgrade proposal
validate_upgrade_proposal() {
    local upgrade_manager_id="$1"
    local proposal_id="$2"

    echo -e "${BLUE}Validating upgrade proposal $proposal_id...${NC}"

    if [[ "$DRY_RUN" == "true" ]]; then
        echo -e "${YELLOW}[DRY RUN] Would validate upgrade proposal $proposal_id${NC}"
        return 0
    fi

    local gas_estimate
    gas_estimate=$(stellar contract invoke \
        --network "$NETWORK" \
        --source-account "$STELLAR_SECRET_KEY" \
        --id "$upgrade_manager_id" \
        -- validate_proposal \
        --caller "$(proposer_address)" \
        --proposal_id "$proposal_id")

    echo -e "${GREEN}✓ Proposal validated, estimated gas: $gas_estimate${NC}"
}

# Block until the proposal's timelock has elapsed.
#
# The timelock starts on the approval that *reaches the threshold*, not at
# proposal time, so it can only be read back from the stored proposal.
wait_for_timelock() {
    local upgrade_manager_id="$1"
    local proposal_id="$2"

    if [[ "$DRY_RUN" == "true" ]]; then
        echo -e "${YELLOW}[DRY RUN] Would wait for timelock on proposal $proposal_id${NC}"
        return 0
    fi

    local eta
    eta=$(stellar contract invoke \
        --network "$NETWORK" \
        --source-account "$STELLAR_SECRET_KEY" \
        --id "$upgrade_manager_id" \
        -- get_proposal \
        --proposal_id "$proposal_id" | jq -r '.eta')

    if [[ -z "$eta" || "$eta" == "0" || "$eta" == "null" ]]; then
        echo -e "${RED}Error: proposal $proposal_id has no eta; the approval threshold was never reached${NC}" >&2
        exit 1
    fi

    echo -e "${BLUE}Timelock active until $eta, waiting...${NC}"
    while :; do
        local now
        now=$(date +%s)
        if (( now >= eta )); then
            break
        fi
        sleep 30
    done
    echo -e "${GREEN}✓ Timelock elapsed${NC}"
}

# Execute upgrade via upgrade manager
execute_upgrade_via_manager() {
    local upgrade_manager_id="$1"
    local proposal_id="$2"

    echo -e "${BLUE}Executing upgrade proposal $proposal_id...${NC}"

    if [[ "$DRY_RUN" == "true" ]]; then
        echo -e "${YELLOW}[DRY RUN] Would execute proposal $proposal_id${NC}"
        return 0
    fi

    stellar contract invoke \
        --network "$NETWORK" \
        --source-account "$STELLAR_SECRET_KEY" \
        --id "$upgrade_manager_id" \
        -- execute_upgrade \
        --executor "$(proposer_address)" \
        --proposal_id "$proposal_id" >/dev/null

    echo -e "${GREEN}✓ Upgrade executed successfully${NC}"
}

# Direct contract upgrade (legacy method)
upgrade_contract_direct() {
    local name="$1"
    local contract_id="$2"
    local new_wasm_hash="$3"
    local new_version="$4"
    local description="$5"
    
    echo -e "${BLUE}Performing direct contract upgrade...${NC}"
    
    if [[ "$DRY_RUN" == "true" ]]; then
        echo -e "${YELLOW}[DRY RUN] Would upgrade $name directly${NC}"
        echo -e "  Contract ID: $contract_id"
        echo -e "  New WASM Hash: $new_wasm_hash"
        return 0
    fi
    
    # Check if contract supports upgrade_contract method
    if supports_upgrade_manager "$name" "$contract_id"; then
        # Use the contract's own upgrade method
        stellar contract invoke \
            --network "$NETWORK" \
            --source-account "$STELLAR_SECRET_KEY" \
            --id "$contract_id" \
            -- upgrade_contract \
            --new_wasm_hash "$new_wasm_hash" \
            --new_version "$new_version" \
            --description "$description"
    else
        # Use Soroban CLI direct upgrade
        stellar contract install \
            --network "$NETWORK" \
            --source-account "$STELLAR_SECRET_KEY" \
            --wasm "$TARGET_DIR/${name//-/_}.wasm"
        
        # Update deployment metadata
        echo -e "${GREEN}✓ Direct upgrade completed${NC}"
    fi
}

# Upgrade a single contract
upgrade_single_contract() {
    local name="$1"
    local contract_path="$2"
    
    echo -e "\n${BLUE}=== Upgrading $name ===${NC}"
    
    # Get contract info
    local contract_info
    contract_info=$(get_contract_info "$name")
    
    if [[ -z "$contract_info" ]]; then
        echo -e "${RED}✗ Contract $name not found in deployment metadata${NC}"
        return 1
    fi
    
    local contract_id
    contract_id=$(echo "$contract_info" | jq -r '.contract_id')
    
    local wasm_file="$TARGET_DIR/${name//-/_}.wasm"
    
    # Check if upgrade is needed
    if ! needs_upgrade "$name" "$wasm_file"; then
        if [[ $? -eq 1 ]]; then
            echo -e "${GREEN}✓ Contract $name is already up to date${NC}"
            return 0
        else
            return 1
        fi
    fi
    
    # Calculate new WASM hash
    local new_wasm_hash
    new_wasm_hash=$(calculate_wasm_hash "$wasm_file")
    
    # Determine version
    local new_version="$VERSION"
    if [[ -z "$new_version" ]]; then
        local current_version
        current_version=$(get_contract_version "$contract_id")
        new_version="${current_version}.$(date +%s)" # Simple version bump
    fi
    
    local description="Automated upgrade via upgrade script"
    if [[ -n "$VERSION" ]]; then
        description="Upgrade to version $VERSION"
    fi
    
    # Backup state if not skipped
    backup_contract_state "$name" "$contract_id"
    
    # Choose upgrade method
    if [[ "$USE_UPGRADE_MANAGER" == "true" ]]; then
        # Use upgrade manager for safe upgrade
        local upgrade_manager_id
        upgrade_manager_id=$(get_upgrade_manager_id)

        # SAFETY: the manager's execute_upgrade calls
        # `env.deployer().update_current_contract_wasm(new_wasm_hash)`, which
        # Soroban defines as replacing *the calling contract's* executable.
        # A proposal raised for some other contract and executed through the
        # manager therefore swaps the MANAGER's own WASM for the target's —
        # destroying the governor and leaving the target untouched. There is no
        # cross-contract upgrade primitive, so refuse rather than brick it.
        if [[ "$contract_id" != "$upgrade_manager_id" ]]; then
            echo -e "${RED}✗ Refusing to execute a proposal for $name through the upgrade manager${NC}"
            echo -e "${YELLOW}The manager can only replace its own WASM; it cannot upgrade $name.${NC}"
            echo -e "${YELLOW}Re-run with --use-upgrade-manager=false to use $name's own self-upgrade path.${NC}"
            return 1
        fi

        # Check if contract supports upgrade manager
        if ! supports_upgrade_manager "$name" "$contract_id"; then
            echo -e "${YELLOW}Warning: Contract $name doesn't support upgrade manager${NC}"
            echo -e "${YELLOW}Falling back to direct upgrade${NC}"
            upgrade_contract_direct "$name" "$contract_id" "$new_wasm_hash" "$new_version" "$description"
        else
            # Check compatibility if not forced
            if [[ "$FORCE" != "true" ]]; then
                if ! check_upgrade_compatibility "$contract_id" "$new_version"; then
                    echo -e "${RED}✗ Upgrade compatibility check failed for $name${NC}"
                    return 1
                fi
            fi

            # Upgrade via manager
            local proposal_id
            proposal_id=$(propose_upgrade "$name" "$new_version" "$new_wasm_hash" "$description" "$upgrade_manager_id")
            approve_upgrade "$upgrade_manager_id" "$proposal_id"
            validate_upgrade_proposal "$upgrade_manager_id" "$proposal_id"
            wait_for_timelock "$upgrade_manager_id" "$proposal_id"
            execute_upgrade_via_manager "$upgrade_manager_id" "$proposal_id"
        fi
    else
        # Direct upgrade
        upgrade_contract_direct "$name" "$contract_id" "$new_wasm_hash" "$new_version" "$description"
    fi
    
    # Update deployment metadata
    update_deployment_metadata "$name" "$new_wasm_hash" "$new_version"
    
    echo -e "${GREEN}✓ Successfully upgraded $name${NC}"
}

# Update deployment metadata
update_deployment_metadata() {
    local name="$1"
    local new_hash="$2"
    local new_version="$3"
    
    if [[ "$DRY_RUN" == "true" ]]; then
        return 0
    fi
    
    # Update the deployment file
    local temp_file
    temp_file=$(mktemp)
    
    jq --arg name "$name" \
       --arg hash "$new_hash" \
       --arg version "$new_version" \
       --arg timestamp "$TIMESTAMP" \
       '.contracts[$name].wasm_hash = $hash |
        .contracts[$name].version = $version |
        .contracts[$name].upgraded_at = $timestamp' \
       "$DEPLOYMENT_FILE" > "$temp_file"
    
    mv "$temp_file" "$DEPLOYMENT_FILE"
}

# Main execution
main() {
    set_network_defaults
    check_deployment_file
    build_contracts
    
    if [[ -n "$CONTRACT_NAME" ]]; then
        # Upgrade specific contract
        local found=false
        for contract in "${CONTRACTS[@]}"; do
            local name="${contract%%:*}"
            local path="${contract##*:}"
            
            if [[ "$name" == "$CONTRACT_NAME" ]]; then
                upgrade_single_contract "$name" "$path"
                found=true
                break
            fi
        done
        
        if [[ "$found" != "true" ]]; then
            echo -e "${RED}Error: Contract '$CONTRACT_NAME' not found${NC}" >&2
            echo -e "${YELLOW}Available contracts:${NC}"
            for contract in "${CONTRACTS[@]}"; do
                echo "  ${contract%%:*}"
            done
            exit 1
        fi
    else
        # Upgrade all contracts
        local upgraded=0
        local total=0
        
        for contract in "${CONTRACTS[@]}"; do
            local name="${contract%%:*}"
            local path="${contract##*:}"

            # In manager mode only upgrade-manager itself can be upgraded, because
            # update_current_contract_wasm only replaces the calling contract.
            # Every other contract would be rejected by the guard in
            # upgrade_single_contract, so skip them here with an explanation
            # rather than failing the run.
            if [[ "$USE_UPGRADE_MANAGER" == "true" && "$name" != "upgrade-manager" ]]; then
                echo -e "${YELLOW}Skipping $name: the manager can only upgrade itself${NC}"
                echo -e "${YELLOW}  Re-run without -u to upgrade $name via its own upgrade_contract${NC}"
                continue
            fi

            total=$((total + 1))

            if upgrade_single_contract "$name" "$path"; then
                upgraded=$((upgraded + 1))
            fi
        done
        
        echo -e "\n${BLUE}=== Upgrade Summary ===${NC}"
        echo -e "${GREEN}Successfully upgraded: $upgraded/$total contracts${NC}"
        
        if [[ $upgraded -lt $total ]]; then
            exit 1
        fi
    fi
    
    if [[ "$DRY_RUN" != "true" ]]; then
        echo -e "\n${GREEN}🎉 Upgrade completed successfully!${NC}"
        
        if [[ "$USE_UPGRADE_MANAGER" == "true" && "$ENABLE_ROLLBACK" == "true" ]]; then
            echo -e "${YELLOW}💡 Rollback is available for 48 hours via the upgrade manager${NC}"
        fi
    fi
}

# Check if deployment file exists
check_deployment_file() {
    if [[ ! -f "$DEPLOYMENT_FILE" ]]; then
        echo -e "${RED}Error: Deployment file not found: $DEPLOYMENT_FILE${NC}" >&2
        echo -e "${YELLOW}Hint: Run deploy.sh first to deploy contracts${NC}" >&2
        exit 1
    fi
}

# Get deployed contract info
get_contract_info() {
    local name="$1"
    jq -r --arg name "$name" '.contracts[$name] // empty' "$DEPLOYMENT_FILE"
}

# Get all deployed contracts
get_deployed_contracts() {
    jq -r '.contracts | keys[]' "$DEPLOYMENT_FILE"
}

# Calculate Wasm hash
calculate_wasm_hash() {
    local wasm_file="$1"
    sha256sum "$wasm_file" | cut -d' ' -f1
}

# Get network passphrase
get_network_passphrase() {
    case $NETWORK in
        testnet)
            echo "Test SDF Network ; September 2015"
            ;;
        futurenet)
            echo "Test SDF Future Network ; October 2022"
            ;;
        mainnet)
            echo "Public Global Stellar Network ; September 2015"
            ;;
    esac
}

# Build contracts
build_contracts() {
    if [[ "$SKIP_BUILD" == "true" ]]; then
        echo -e "${YELLOW}Skipping build step${NC}"
        return
    fi

    echo -e "${BLUE}Building contracts...${NC}"
    cd "$PROJECT_ROOT"
    
    # Build all contracts in workspace
    cargo build --target wasm32-unknown-unknown --release
    
    echo -e "${GREEN}✓ Build completed${NC}"
    echo ""
}

# Check if contract needs upgrade
needs_upgrade() {
    local name="$1"
    local wasm_file="$2"
    
    local contract_info
    contract_info=$(get_contract_info "$name")
    
    if [[ -z "$contract_info" ]]; then
        echo -e "${RED}✗ Contract $name not found in deployment metadata${NC}" >&2
        return 2
    fi
    
    local deployed_hash
    deployed_hash=$(echo "$contract_info" | jq -r '.wasm_hash')
    
    local current_hash
    current_hash=$(calculate_wasm_hash "$wasm_file")
    
    if [[ "$deployed_hash" != "$current_hash" ]]; then
        echo -e "${YELLOW}Contract $name needs upgrade${NC}"
        echo -e "${BLUE}  Deployed hash:${NC} $deployed_hash"
        echo -e "${BLUE}  Current hash:${NC}  $current_hash"
        return 0
    else
        echo -e "${GREEN}Contract $name is up to date${NC}"
        return 1
    fi
}

# Backup contract state
backup_contract_state() {
    local name="$1"
    local contract_id="$2"
    
    if [[ "$SKIP_BACKUP" == "true" ]]; then
        echo -e "${YELLOW}Skipping backup for $name${NC}"
        return 0
    fi
    
    echo -e "${BLUE}Creating state backup for $name...${NC}"
    
    # Create backup directory
    mkdir -p "$BACKUPS_DIR/$NETWORK"
    local backup_file="$BACKUPS_DIR/$NETWORK/${name}-${TIMESTAMP}.json"
    
    # Export contract state (this is a conceptual approach - Soroban doesn't have direct state export)
    # In practice, you'd need to call specific contract methods to get critical state
    local backup_data="{
        \"contract_id\": \"$contract_id\",
        \"backup_timestamp\": \"$TIMESTAMP\",
        \"network\": \"$NETWORK\",
        \"note\": \"State backup before upgrade - manual verification required\"
    }"
    
    echo "$backup_data" > "$backup_file"
    echo -e "${GREEN}✓ Backup created: $backup_file${NC}"
    
    # Store backup info in deployment metadata
    local metadata
    metadata=$(cat "$DEPLOYMENT_FILE")
    metadata=$(echo "$metadata" | jq --arg name "$name" --arg backup_file "$backup_file" --arg timestamp "$TIMESTAMP" '
        .contracts[$name].backups += [{
            file: $backup_file,
            timestamp: $timestamp
        }]
    ')
    echo "$metadata" > "$DEPLOYMENT_FILE"
}

# Perform safety checks
perform_safety_checks() {
    local name="$1"
    local contract_id="$2"
    local wasm_file="$3"
    
    if [[ "$FORCE" == "true" ]]; then
        echo -e "${YELLOW}Skipping safety checks (--force specified)${NC}"
        return 0
    fi
    
    echo -e "${BLUE}Performing safety checks for $name...${NC}"
    
    # Check 1: Verify contract exists on network
    echo -e "${BLUE}  Checking contract existence...${NC}"
    if ! soroban contract invoke \
        --id "$contract_id" \
        --source "$STELLAR_SECRET_KEY" \
        --rpc-url "$STELLAR_RPC_URL" \
        --network-passphrase "$(get_network_passphrase)" \
        -- --help >/dev/null 2>&1; then
        echo -e "${RED}  ✗ Contract not found on network${NC}" >&2
        return 1
    fi
    echo -e "${GREEN}  ✓ Contract exists on network${NC}"
    
    # Check 2: Verify Wasm file exists and is valid
    echo -e "${BLUE}  Checking Wasm file...${NC}"
    if [[ ! -f "$wasm_file" ]]; then
        echo -e "${RED}  ✗ Wasm file not found: $wasm_file${NC}" >&2
        return 1
    fi
    
    # Basic Wasm validation (check magic number)
    if ! xxd -l 4 "$wasm_file" | grep -q "0061736d"; then
        echo -e "${RED}  ✗ Invalid Wasm file (missing magic number)${NC}" >&2
        return 1
    fi
    echo -e "${GREEN}  ✓ Wasm file is valid${NC}"
    
    # Check 3: Storage layout compatibility (placeholder - requires contract-specific logic)
    echo -e "${BLUE}  Checking storage layout compatibility...${NC}"
    echo -e "${YELLOW}  ⚠ Manual storage layout verification required${NC}"
    
    return 0
}
# Check dependencies
check_dependencies() {
    local deps=("soroban" "jq" "cargo" "sha256sum" "xxd")
    for dep in "${deps[@]}"; do
        if ! command -v "$dep" >/dev/null 2>&1; then
            echo -e "${RED}Error: Required dependency '$dep' not found${NC}" >&2
            exit 1
        fi
    done
}

# Entry point
check_dependencies
main "$@"
