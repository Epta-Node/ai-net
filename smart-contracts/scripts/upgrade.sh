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

# Usage function
usage() {
    cat << EOF
Usage: $0 [OPTIONS] [CONTRACT_NAME]

Upgrade deployed Soroban contracts with safety checks and state preservation.

ARGUMENTS:
    CONTRACT_NAME            Name of specific contract to upgrade (optional, upgrades all if not specified)

OPTIONS:
    -n, --network NETWORK    Network to upgrade on (testnet, futurenet, mainnet) [default: testnet]
    -s, --skip-build         Skip the Wasm build step
    -b, --skip-backup        Skip state backup before upgrade
    -f, --force              Skip safety checks and proceed with upgrade
    -d, --dry-run            Show what would be upgraded without making changes
    -h, --help               Show this help message

ENVIRONMENT VARIABLES:
    STELLAR_SECRET_KEY       Secret key for deployment account (required)
    STELLAR_RPC_URL         RPC URL for the network (optional, uses default for network)
    STELLAR_HORIZON_URL     Horizon URL for the network (optional, uses default for network)

EXAMPLES:
    $0                       Upgrade all contracts on testnet
    $0 agent-registry       Upgrade only the agent-registry contract
    $0 -n futurenet -d      Dry run upgrade on futurenet
    $0 -f --skip-backup     Force upgrade without backup
EOF
}

# Parse command line arguments
CONTRACT_NAME=""
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

# Check required environment variables
if [[ -z "$STELLAR_SECRET_KEY" ]]; then
    echo -e "${RED}Error: STELLAR_SECRET_KEY environment variable is required${NC}" >&2
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

# Contract definitions
CONTRACTS=(
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
if [[ "$DRY_RUN" == "true" ]]; then
    echo -e "${YELLOW}Mode:${NC} Dry run (no changes will be made)"
fi
echo ""

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

# Upgrade a single contract
upgrade_contract() {
    local name="$1"
    local wasm_file="$2"
    
    echo -e "${BLUE}Processing upgrade for $name...${NC}"
    
    # Get contract info from deployment metadata
    local contract_info
    contract_info=$(get_contract_info "$name")
    
    if [[ -z "$contract_info" ]]; then
        echo -e "${RED}✗ Contract $name not found in deployment metadata${NC}" >&2
        return 1
    fi
    
    local contract_id
    contract_id=$(echo "$contract_info" | jq -r '.contract_id')
    
    # Check if upgrade is needed
    if ! needs_upgrade "$name" "$wasm_file"; then
        local exit_code=$?
        if [[ $exit_code -eq 1 ]]; then
            echo ""
            return 0  # No upgrade needed
        else
            return 1  # Error occurred
        fi
    fi
    
    if [[ "$DRY_RUN" == "true" ]]; then
        echo -e "${YELLOW}Would upgrade $name (dry run)${NC}"
        echo ""
        return 0
    fi
    
    # Perform safety checks
    if ! perform_safety_checks "$name" "$contract_id" "$wasm_file"; then
        echo -e "${RED}✗ Safety checks failed for $name${NC}" >&2
        return 1
    fi
    
    # Backup state
    backup_contract_state "$name" "$contract_id"
    
    # Perform the upgrade
    echo -e "${BLUE}Upgrading $name...${NC}"
    
    local new_wasm_hash
    new_wasm_hash=$(calculate_wasm_hash "$wasm_file")
    
    if soroban contract install \
        --wasm "$wasm_file" \
        --source "$STELLAR_SECRET_KEY" \
        --rpc-url "$STELLAR_RPC_URL" \
        --network-passphrase "$(get_network_passphrase)" >/dev/null 2>&1; then
        
        # Get the new Wasm hash from Soroban
        local install_hash
        install_hash=$(soroban contract install \
            --wasm "$wasm_file" \
            --source "$STELLAR_SECRET_KEY" \
            --rpc-url "$STELLAR_RPC_URL" \
            --network-passphrase "$(get_network_passphrase)" 2>/dev/null | grep -o '[a-f0-9]\{64\}' | head -1)
        
        # Update the contract
        if soroban contract upgrade \
            --contract-id "$contract_id" \
            --wasm-hash "$install_hash" \
            --source "$STELLAR_SECRET_KEY" \
            --rpc-url "$STELLAR_RPC_URL" \
            --network-passphrase "$(get_network_passphrase)" >/dev/null 2>&1; then
            
            echo -e "${GREEN}✓ Successfully upgraded $name${NC}"
            echo -e "${BLUE}  Contract ID:${NC} $contract_id"
            echo -e "${BLUE}  New Wasm Hash:${NC} $new_wasm_hash"
            
            # Update deployment metadata
            local metadata
            metadata=$(cat "$DEPLOYMENT_FILE")
            metadata=$(echo "$metadata" | jq --arg name "$name" --arg wasm_hash "$new_wasm_hash" --arg timestamp "$TIMESTAMP" '
                .contracts[$name].wasm_hash = $wasm_hash |
                .contracts[$name].upgraded_at = $timestamp
            ')
            echo "$metadata" > "$DEPLOYMENT_FILE"
            
        else
            echo -e "${RED}✗ Failed to upgrade contract $name${NC}" >&2
            return 1
        fi
    else
        echo -e "${RED}✗ Failed to install new Wasm for $name${NC}" >&2
        return 1
    fi
    
    echo ""
    return 0
}

# Get contracts to upgrade
get_contracts_to_upgrade() {
    if [[ -n "$CONTRACT_NAME" ]]; then
        # Validate specified contract exists
        local found=false
        for contract_info in "${CONTRACTS[@]}"; do
            IFS=':' read -r name path <<< "$contract_info"
            if [[ "$name" == "$CONTRACT_NAME" ]]; then
                found=true
                break
            fi
        done
        
        if [[ "$found" == "false" ]]; then
            echo -e "${RED}Error: Contract '$CONTRACT_NAME' not found${NC}" >&2
            echo -e "${YELLOW}Available contracts:${NC}"
            for contract_info in "${CONTRACTS[@]}"; do
                IFS=':' read -r name path <<< "$contract_info"
                echo -e "  - $name"
            done
            exit 1
        fi
        
        echo "$CONTRACT_NAME"
    else
        # Get all deployed contracts
        get_deployed_contracts
    fi
}

# Main execution
main() {
    set_network_defaults
    check_deployment_file
    build_contracts
    
    local contracts_to_upgrade
    contracts_to_upgrade=$(get_contracts_to_upgrade)
    
    if [[ -z "$contracts_to_upgrade" ]]; then
        echo -e "${YELLOW}No contracts to upgrade${NC}"
        exit 0
    fi
    
    echo -e "${BLUE}Upgrading contracts on $NETWORK...${NC}"
    echo ""
    
    local upgrade_success=true
    while IFS= read -r contract_name; do
        # Find the corresponding contract path
        local wasm_file=""
        for contract_info in "${CONTRACTS[@]}"; do
            IFS=':' read -r name path <<< "$contract_info"
            if [[ "$name" == "$contract_name" ]]; then
                wasm_file="$TARGET_DIR/${name//-/_}.wasm"
                break
            fi
        done
        
        if [[ -z "$wasm_file" ]]; then
            echo -e "${RED}✗ Wasm file not found for contract $contract_name${NC}" >&2
            upgrade_success=false
            continue
        fi
        
        if ! upgrade_contract "$contract_name" "$wasm_file"; then
            upgrade_success=false
        fi
    done <<< "$contracts_to_upgrade"
    
    if [[ "$upgrade_success" == "true" ]]; then
        if [[ "$DRY_RUN" != "true" ]]; then
            echo -e "${GREEN}=== Upgrade completed successfully ===${NC}"
            
            # Add to deployment history
            local metadata
            metadata=$(cat "$DEPLOYMENT_FILE")
            metadata=$(echo "$metadata" | jq --arg timestamp "$TIMESTAMP" --arg action "upgrade" '
                .deployment_history += [{
                    action: $action,
                    timestamp: $timestamp,
                    network: .network
                }]
            ')
            echo "$metadata" > "$DEPLOYMENT_FILE"
        else
            echo -e "${GREEN}=== Dry run completed ===${NC}"
        fi
    else
        echo -e "${RED}=== Upgrade failed ===${NC}" >&2
        exit 1
    fi
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
