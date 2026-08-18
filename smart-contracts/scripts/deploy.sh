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
VERIFY=false

# Usage function
usage() {
    cat << EOF
Usage: $0 [OPTIONS]

Deploy Soroban contracts to the specified network.

OPTIONS:
    -n, --network NETWORK     Network to deploy to (testnet, futurenet, mainnet) [default: testnet]
    -s, --skip-build         Skip the Wasm build step
    -v, --verify             Verify deployment after completion
    -h, --help               Show this help message

ENVIRONMENT VARIABLES:
    STELLAR_SECRET_KEY       Secret key for deployment account (required)
    STELLAR_RPC_URL         RPC URL for the network (optional, uses default for network)
    STELLAR_HORIZON_URL     Horizon URL for the network (optional, uses default for network)

EXAMPLES:
    $0                       Deploy to testnet
    $0 -n futurenet         Deploy to futurenet
    $0 -s -v               Skip build and verify deployment
EOF
}

# Parse command line arguments
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
        -v|--verify)
            VERIFY=true
            shift
            ;;
        -h|--help)
            usage
            exit 0
            ;;
        *)
            echo -e "${RED}Unknown option: $1${NC}" >&2
            usage >&2
            exit 1
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

# Contract names and paths
CONTRACTS=(
    "agent-registry:contracts/agent_registry"
    "error-resolver:contracts/error-resolver"
)

# Directories
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
DEPLOYMENTS_DIR="$PROJECT_ROOT/deployments"
TARGET_DIR="$PROJECT_ROOT/target/wasm32-unknown-unknown/release"

# Deployment metadata
DEPLOYMENT_FILE="$DEPLOYMENTS_DIR/${NETWORK}.json"
TIMESTAMP=$(date -u +"%Y-%m-%dT%H:%M:%S.%3NZ")

echo -e "${BLUE}=== ai-net Smart Contract Deployment ===${NC}"
echo -e "${BLUE}Network:${NC} $NETWORK"
echo -e "${BLUE}RPC URL:${NC} $STELLAR_RPC_URL"
echo -e "${BLUE}Deployment file:${NC} $DEPLOYMENT_FILE"
echo ""

# Initialize deployment metadata
init_deployment_metadata() {
    local metadata
    if [[ -f "$DEPLOYMENT_FILE" ]]; then
        metadata=$(cat "$DEPLOYMENT_FILE")
    else
        metadata='{}'
    fi
    
    # Update metadata with deployment info
    metadata=$(echo "$metadata" | jq --arg network "$NETWORK" --arg timestamp "$TIMESTAMP" --arg rpc_url "$STELLAR_RPC_URL" --arg horizon_url "$STELLAR_HORIZON_URL" '
        {
            network: $network,
            rpc_url: $rpc_url,
            horizon_url: $horizon_url,
            deployed_at: $timestamp,
            contracts: (.contracts // {}),
            deployment_history: (.deployment_history // [])
        }
    ')
    echo "$metadata" > "$DEPLOYMENT_FILE"
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
    
    # Optimize Wasm files
    for contract_info in "${CONTRACTS[@]}"; do
        IFS=':' read -r name path <<< "$contract_info"
        wasm_file="$TARGET_DIR/${name//-/_}.wasm"
        
        if [[ -f "$wasm_file" ]]; then
            echo -e "${GREEN}✓ Built $name${NC}"
        else
            echo -e "${RED}✗ Failed to build $name (expected: $wasm_file)${NC}" >&2
            exit 1
        fi
    done
    
    echo ""
}

# Calculate Wasm hash
calculate_wasm_hash() {
    local wasm_file="$1"
    sha256sum "$wasm_file" | cut -d' ' -f1
}

# Deploy a single contract
deploy_contract() {
    local name="$1"
    local wasm_file="$2"
    
    echo -e "${BLUE}Deploying $name...${NC}"
    
    # Calculate Wasm hash for verification
    local wasm_hash
    wasm_hash=$(calculate_wasm_hash "$wasm_file")
    
    # Deploy the contract
    local contract_id
    contract_id=$(soroban contract deploy \
        --wasm "$wasm_file" \
        --source "$STELLAR_SECRET_KEY" \
        --rpc-url "$STELLAR_RPC_URL" \
        --network-passphrase "$(get_network_passphrase)" \
        2>/dev/null | grep -o 'C[A-Z0-9]\{55\}' | head -1)
    
    if [[ -z "$contract_id" ]]; then
        echo -e "${RED}✗ Failed to deploy $name${NC}" >&2
        return 1
    fi
    
    echo -e "${GREEN}✓ Deployed $name${NC}"
    echo -e "${BLUE}  Contract ID:${NC} $contract_id"
    echo -e "${BLUE}  Wasm Hash:${NC} $wasm_hash"
    
    # Update deployment metadata
    local metadata
    metadata=$(cat "$DEPLOYMENT_FILE")
    metadata=$(echo "$metadata" | jq --arg name "$name" --arg contract_id "$contract_id" --arg wasm_hash "$wasm_hash" --arg timestamp "$TIMESTAMP" '
        .contracts[$name] = {
            contract_id: $contract_id,
            wasm_hash: $wasm_hash,
            deployed_at: $timestamp
        }
    ')
    echo "$metadata" > "$DEPLOYMENT_FILE"
    
    return 0
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

# Verify deployment
verify_deployment() {
    if [[ "$VERIFY" != "true" ]]; then
        return
    fi
    
    echo -e "${BLUE}Verifying deployment...${NC}"
    cd "$SCRIPT_DIR"
    ./verify.sh --network "$NETWORK" --deployment-file "$DEPLOYMENT_FILE"
}

# Main execution
main() {
    set_network_defaults
    init_deployment_metadata
    build_contracts
    
    echo -e "${BLUE}Deploying contracts to $NETWORK...${NC}"
    echo ""
    
    local deployment_success=true
    for contract_info in "${CONTRACTS[@]}"; do
        IFS=':' read -r name path <<< "$contract_info"
        wasm_file="$TARGET_DIR/${name//-/_}.wasm"
        
        if ! deploy_contract "$name" "$wasm_file"; then
            deployment_success=false
        fi
        echo ""
    done
    
    if [[ "$deployment_success" == "true" ]]; then
        echo -e "${GREEN}=== Deployment completed successfully ===${NC}"
        echo -e "${BLUE}Deployment metadata saved to:${NC} $DEPLOYMENT_FILE"
        
        # Add to deployment history
        local metadata
        metadata=$(cat "$DEPLOYMENT_FILE")
        metadata=$(echo "$metadata" | jq --arg timestamp "$TIMESTAMP" --arg action "deploy" '
            .deployment_history += [{
                action: $action,
                timestamp: $timestamp,
                network: .network,
                contracts: (.contracts | keys)
            }]
        ')
        echo "$metadata" > "$DEPLOYMENT_FILE"
        
        verify_deployment
    else
        echo -e "${RED}=== Deployment failed ===${NC}" >&2
        exit 1
    fi
}

# Check dependencies
check_dependencies() {
    local deps=("soroban" "jq" "cargo" "sha256sum")
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
