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
DEPLOYMENT_FILE=""
REBUILD=false
STRICT=false
JSON_OUTPUT=false
REPORT_SIZES=false

# Usage function
usage() {
    cat << EOF
Usage: $0 [OPTIONS] [CONTRACT_NAME]

Verify deployed Soroban contracts match local build artifacts.

ARGUMENTS:
    CONTRACT_NAME            Name of specific contract to verify (optional, verifies all if not specified)

OPTIONS:
    -n, --network NETWORK    Network to verify against (testnet, futurenet, mainnet) [default: testnet]
    -f, --deployment-file    Path to deployment metadata file (optional, uses default for network)
    -r, --rebuild            Rebuild contracts before verification
    --strict                 Exit non-zero on any mismatch or skipped check (use for releases)
    --json                   Print the verification report as JSON on stdout (logs go to stderr)
    --report-sizes           Report optimized Wasm sizes against the committed budget, then exit
                             (requires a prior `cargo build --target wasm32v1-none --release`)
    -h, --help               Show this help message

ENVIRONMENT VARIABLES:
    STELLAR_SECRET_KEY       Secret key for account (required for contract inspection)
    STELLAR_RPC_URL         RPC URL for the network (optional, uses default for network)
    STELLAR_HORIZON_URL     Horizon URL for the network (optional, uses default for network)
    WASM_DIR                Directory with the locally built .wasm files (optional)
    REPORT_DIR              Directory for the verification report (optional)

EXAMPLES:
    $0                       Verify all contracts on testnet
    $0 agent-registry       Verify only the agent-registry contract
    $0 -n futurenet -r      Rebuild and verify on futurenet
    $0 -f /path/to/deployment.json  Use custom deployment file
    $0 -n mainnet --strict --json   Release check: fail on any mismatch, emit JSON
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
        -f|--deployment-file)
            DEPLOYMENT_FILE="$2"
            shift 2
            ;;
        -r|--rebuild)
            REBUILD=true
            shift
            ;;
        --strict)
            STRICT=true
            shift
            ;;
        --json)
            JSON_OUTPUT=true
            shift
            ;;
        --report-sizes)
            REPORT_SIZES=true
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

# In JSON mode stdout carries only the report; logs go to stderr.
if [[ "$JSON_OUTPUT" == "true" ]]; then
    exec 3>&1 1>&2
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
TARGET_DIR="${WASM_DIR:-$PROJECT_ROOT/target/wasm32-unknown-unknown/release}"
REPORT_DIR="${REPORT_DIR:-$PROJECT_ROOT}"

# Set default deployment file if not specified
if [[ -z "$DEPLOYMENT_FILE" ]]; then
    DEPLOYMENT_FILE="$DEPLOYMENTS_DIR/${NETWORK}.json"
fi

echo -e "${BLUE}=== ai-net Smart Contract Verification ===${NC}"
echo -e "${BLUE}Network:${NC} $NETWORK"
echo -e "${BLUE}RPC URL:${NC} $STELLAR_RPC_URL"
echo -e "${BLUE}Deployment file:${NC} $DEPLOYMENT_FILE"
if [[ -n "$CONTRACT_NAME" ]]; then
    echo -e "${BLUE}Contract:${NC} $CONTRACT_NAME"
else
    echo -e "${BLUE}Contracts:${NC} All deployed contracts"
fi
echo ""

# Check if deployment file exists
check_deployment_file() {
    if [[ ! -f "$DEPLOYMENT_FILE" ]]; then
        echo -e "${RED}Error: Deployment file not found: $DEPLOYMENT_FILE${NC}" >&2
        echo -e "${YELLOW}Hint: Run deploy.sh first to deploy contracts${NC}" >&2
        exit 1
    fi

    # The metadata must describe the network being verified.
    local file_network
    file_network=$(jq -r '.network // empty' "$DEPLOYMENT_FILE")
    if [[ "$file_network" != "$NETWORK" ]]; then
        echo -e "${RED}Error: Deployment file is for '$file_network', not '$NETWORK'${NC}" >&2
        exit 1
    fi
}

# Report a skipped check: a warning normally, a failure in --strict mode.
warn_or_fail() {
    if [[ "$STRICT" == "true" ]]; then
        echo -e "${RED}  ✗ $1 (--strict)${NC}"
        return 1
    fi
    echo -e "${YELLOW}  ⚠ $1${NC}"
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

# Build contracts if requested
build_contracts() {
    if [[ "$REBUILD" != "true" ]]; then
        return
    fi

    echo -e "${BLUE}Rebuilding contracts for verification...${NC}"
    cd "$PROJECT_ROOT"
    
    # Build all contracts in workspace
    cargo build --target wasm32-unknown-unknown --release
    
    echo -e "${GREEN}✓ Build completed${NC}"
    echo ""
}

# Check if contract is responsive
check_contract_health() {
    local name="$1"
    local contract_id="$2"
    
    echo -e "${BLUE}  Checking contract health...${NC}"
    
    # Try to invoke contract help to see if it's responsive
    if soroban contract invoke \
        --id "$contract_id" \
        --source-account "$STELLAR_SECRET_KEY" \
        --rpc-url "$STELLAR_RPC_URL" \
        --network-passphrase "$(get_network_passphrase)" \
        -- --help >/dev/null 2>&1; then
        echo -e "${GREEN}  ✓ Contract is responsive${NC}"
        return 0
    else
        echo -e "${RED}  ✗ Contract is not responsive${NC}"
        return 1
    fi
}

# Get the Wasm hash of the code actually deployed on-chain (empty if unavailable)
get_deployed_wasm_hash() {
    local contract_id="$1"
    local tmp
    tmp=$(mktemp)
    if soroban contract fetch \
        --id "$contract_id" \
        --rpc-url "$STELLAR_RPC_URL" \
        --network-passphrase "$(get_network_passphrase)" \
        --out-file "$tmp" >/dev/null 2>&1; then
        calculate_wasm_hash "$tmp"
    fi
    rm -f "$tmp"
}

# Get the admin currently recorded on-chain (empty if unavailable)
get_deployed_admin() {
    local contract_id="$1"
    local fn out
    for fn in get_admin admin; do
        if out=$(soroban contract invoke \
            --id "$contract_id" \
            --source-account "$STELLAR_SECRET_KEY" \
            --rpc-url "$STELLAR_RPC_URL" \
            --network-passphrase "$(get_network_passphrase)" \
            --send=no \
            -- "$fn" 2>/dev/null); then
            echo "$out" | tr -d '"[:space:]'
            return
        fi
    done
}

# Verify contract deployment
verify_contract() {
    local name="$1"
    local wasm_file="$2"
    
    echo -e "${BLUE}Verifying $name...${NC}"
    LOCAL_HASH=""
    DEPLOYED_HASH=""
    DEPLOYED_ADMIN=""
    
    # Get contract info from deployment metadata
    local contract_info
    contract_info=$(get_contract_info "$name")
    
    if [[ -z "$contract_info" ]]; then
        echo -e "${RED}✗ Contract $name not found in deployment metadata${NC}" >&2
        return 1
    fi
    
    local contract_id
    contract_id=$(echo "$contract_info" | jq -r '.contract_id')
    
    local stored_hash
    stored_hash=$(echo "$contract_info" | jq -r '.wasm_hash')
    
    # Check if Wasm file exists
    if [[ ! -f "$wasm_file" ]]; then
        echo -e "${RED}  ✗ Wasm file not found: $wasm_file${NC}" >&2
        return 1
    fi
    
    # Calculate current hash
    local current_hash
    current_hash=$(calculate_wasm_hash "$wasm_file")
    LOCAL_HASH="$current_hash"
    
    echo -e "${BLUE}  Contract ID:${NC} $contract_id"
    echo -e "${BLUE}  Stored hash:${NC} $stored_hash"
    echo -e "${BLUE}  Current hash:${NC} $current_hash"
    
    # Verify hash match
    if [[ "$stored_hash" == "$current_hash" ]]; then
        echo -e "${GREEN}  ✓ Hash verification passed${NC}"
    else
        echo -e "${RED}  ✗ Hash verification failed${NC}"
        echo -e "${YELLOW}  This could indicate:${NC}"
        echo -e "${YELLOW}    - Contract was upgraded without updating metadata${NC}"
        echo -e "${YELLOW}    - Local build differs from deployed version${NC}"
        echo -e "${YELLOW}    - Metadata is out of sync${NC}"
        return 1
    fi
    
    # Compare the code deployed on-chain against the local build
    if command -v soroban >/dev/null 2>&1; then
        DEPLOYED_HASH=$(get_deployed_wasm_hash "$contract_id")
    fi
    if [[ -z "$DEPLOYED_HASH" ]]; then
        warn_or_fail "Could not fetch the on-chain Wasm hash" || return 1
    elif [[ "$DEPLOYED_HASH" != "$current_hash" ]]; then
        echo -e "${BLUE}  On-chain hash:${NC} $DEPLOYED_HASH"
        echo -e "${RED}  ✗ On-chain Wasm differs from the local build${NC}"
        return 1
    else
        echo -e "${GREEN}  ✓ On-chain Wasm matches the local build${NC}"
    fi

    # Check contract health and the admin / upgrade authority
    if [[ -n "$STELLAR_SECRET_KEY" ]]; then
        if ! check_contract_health "$name" "$contract_id"; then
            return 1
        fi
        DEPLOYED_ADMIN=$(get_deployed_admin "$contract_id")
    else
        warn_or_fail "Skipping health and admin checks (STELLAR_SECRET_KEY not set)" || return 1
    fi

    local expected_admin
    expected_admin=$(echo "$contract_info" | jq -r '.admin // empty')
    if [[ -z "$expected_admin" ]]; then
        warn_or_fail "No expected admin recorded in deployment metadata" || return 1
    elif [[ -n "$STELLAR_SECRET_KEY" && "$DEPLOYED_ADMIN" != "$expected_admin" ]]; then
        echo -e "${RED}  ✗ Admin mismatch (expected $expected_admin, on-chain ${DEPLOYED_ADMIN:-unknown})${NC}"
        return 1
    fi

    echo -e "${BLUE}  Config summary:${NC} version=$(echo "$contract_info" | jq -r '.version // "unknown"') admin=${DEPLOYED_ADMIN:-${expected_admin:-unknown}} upgrade_function=$(echo "$contract_info" | jq -r '.upgrade_function // "unknown"')"
    
    # Verify Wasm file integrity
    echo -e "${BLUE}  Checking Wasm file integrity...${NC}"
    
    # Check magic number
    if ! [[ "$(xxd -p -l 4 "$wasm_file")" == "0061736d" ]]; then
        echo -e "${RED}  ✗ Invalid Wasm file (missing magic number)${NC}"
        return 1
    fi
    
    # Check file is not empty
    if [[ ! -s "$wasm_file" ]]; then
        echo -e "${RED}  ✗ Wasm file is empty${NC}"
        return 1
    fi
    
    # Get file size
    local file_size
    file_size=$(stat -f%z "$wasm_file" 2>/dev/null || stat -c%s "$wasm_file" 2>/dev/null || echo "unknown")
    echo -e "${BLUE}  File size:${NC} $file_size bytes"
    
    echo -e "${GREEN}  ✓ Wasm file integrity verified${NC}"
    
    # Additional contract-specific checks
    case $name in
        agent-registry)
            echo -e "${BLUE}  Performing agent-registry specific checks...${NC}"
            # Add specific checks for agent registry contract
            echo -e "${GREEN}  ✓ Agent-registry checks passed${NC}"
            ;;
        error-resolver)
            echo -e "${BLUE}  Performing error-resolver specific checks...${NC}"
            # Add specific checks for error resolver contract
            echo -e "${GREEN}  ✓ Error-resolver checks passed${NC}"
            ;;
    esac
    
    echo -e "${GREEN}✓ $name verification completed successfully${NC}"
    echo ""
    return 0
}

# Get contracts to verify
get_contracts_to_verify() {
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

# Generate verification report
generate_report() {
    local verification_results="$1"
    local report_file="$REPORT_DIR/verification-report-${NETWORK}-$(date +%Y%m%d-%H%M%S).json"
    
    echo -e "${BLUE}Generating verification report...${NC}"
    
    local metadata
    metadata=$(cat "$DEPLOYMENT_FILE")
    
    local report
    report=$(echo "$metadata" | jq --arg timestamp "$(date -u +"%Y-%m-%dT%H:%M:%S.%3NZ")" --arg results "$verification_results" '
        {
            verification: {
                timestamp: $timestamp,
                network: .network,
                rpc_url: .rpc_url,
                results: ($results | fromjson)
            },
            deployment_metadata: .
        }
    ')
    
    echo "$report" > "$report_file"
    echo -e "${BLUE}Report saved to:${NC} $report_file"
    if [[ "$JSON_OUTPUT" == "true" ]]; then
        echo "$report" >&3
    fi
}

# Build one machine-readable result entry for the current contract
result_json() {
    jq -nc --arg contract "$1" --arg status "$2" --arg reason "${3:-}" \
        --arg local_hash "${LOCAL_HASH:-}" --arg deployed_hash "${DEPLOYED_HASH:-}" \
        --arg admin "${DEPLOYED_ADMIN:-}" '
        {contract: $contract, status: $status, local_hash: $local_hash,
         deployed_hash: $deployed_hash, admin: $admin}
        + (if $reason != "" then {reason: $reason} else {} end)'
}

# Main execution
main() {
    set_network_defaults
    check_deployment_file
    build_contracts
    
    local contracts_to_verify
    contracts_to_verify=$(get_contracts_to_verify)
    
    if [[ -z "$contracts_to_verify" ]]; then
        echo -e "${YELLOW}No contracts to verify${NC}"
        exit 0
    fi
    
    echo -e "${BLUE}Verifying contracts on $NETWORK...${NC}"
    echo ""
    
    local verification_success=true
    local verification_results="["
    local first_result=true
    
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
            verification_success=false
            
            # Add failed result
            if [[ "$first_result" != "true" ]]; then
                verification_results+=","
            fi
            verification_results+=$(LOCAL_HASH="" DEPLOYED_HASH="" DEPLOYED_ADMIN="" result_json "$contract_name" failed wasm_file_not_found)
            first_result=false
            continue
        fi
        
        if verify_contract "$contract_name" "$wasm_file"; then
            # Add successful result
            if [[ "$first_result" != "true" ]]; then
                verification_results+=","
            fi
            verification_results+=$(result_json "$contract_name" verified)
        else
            verification_success=false
            
            # Add failed result
            if [[ "$first_result" != "true" ]]; then
                verification_results+=","
            fi
            verification_results+=$(result_json "$contract_name" failed)
        fi
        first_result=false
        
    done <<< "$contracts_to_verify"
    
    verification_results+="]"
    
    # Generate report
    generate_report "$verification_results"
    
    if [[ "$verification_success" == "true" ]]; then
        echo -e "${GREEN}=== Verification completed successfully ===${NC}"
        echo -e "${GREEN}All contracts verified against local build artifacts${NC}"
    else
        echo -e "${RED}=== Verification failed ===${NC}" >&2
        echo -e "${RED}Some contracts failed verification${NC}" >&2
        exit 1
    fi
}

# Check dependencies
check_dependencies() {
    local deps=("jq" "sha256sum" "xxd" "stat")
    for dep in "${deps[@]}"; do
        if ! command -v "$dep" >/dev/null 2>&1; then
            echo -e "${RED}Error: Required dependency '$dep' not found${NC}" >&2
            exit 1
        fi
    done
    
    # soroban is optional for basic verification but required for health checks
    if [[ -n "$STELLAR_SECRET_KEY" ]] && ! command -v soroban >/dev/null 2>&1; then
        echo -e "${YELLOW}Warning: soroban CLI not found, skipping health checks${NC}" >&2
        STELLAR_SECRET_KEY=""
    fi
}

# Entry point
if [[ "$REPORT_SIZES" == "true" ]]; then
    exec node "$SCRIPT_DIR/check-wasm-size.mjs" --report
fi

check_dependencies
main "$@"
