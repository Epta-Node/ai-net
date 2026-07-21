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
ACTION=""

# Usage function
usage() {
    cat << EOF
Usage: $0 ACTION [OPTIONS]

Smart contract management helper script for ai-net.

ACTIONS:
    init            Initialize deployment environment
    deploy          Deploy contracts to network
    upgrade         Upgrade existing contracts
    verify          Verify deployed contracts
    backup          Backup contract state
    status          Show deployment status
    clean           Clean build artifacts and temporary files

OPTIONS:
    -n, --network NETWORK     Network to use (testnet, futurenet, mainnet) [default: testnet]
    -h, --help               Show this help message

EXAMPLES:
    $0 init                  Initialize deployment environment
    $0 deploy -n testnet     Deploy contracts to testnet
    $0 upgrade               Upgrade contracts on testnet (dry-run first)
    $0 verify                Verify contract deployments
    $0 status                Show current deployment status
EOF
}

# Parse command line arguments
while [[ $# -gt 0 ]]; do
    case $1 in
        init|deploy|upgrade|verify|backup|status|clean)
            if [[ -n "$ACTION" ]]; then
                echo -e "${RED}Error: Multiple actions specified${NC}" >&2
                usage >&2
                exit 1
            fi
            ACTION="$1"
            shift
            ;;
        -n|--network)
            NETWORK="$2"
            shift 2
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

if [[ -z "$ACTION" ]]; then
    echo -e "${RED}Error: No action specified${NC}" >&2
    usage >&2
    exit 1
fi

# Directories
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"

# Initialize deployment environment
init_environment() {
    echo -e "${BLUE}=== Initializing ai-net Smart Contract Environment ===${NC}"
    echo ""
    
    # Check dependencies
    echo -e "${BLUE}Checking dependencies...${NC}"
    local missing_deps=()
    
    local deps=("soroban" "jq" "cargo" "sha256sum" "node" "npm")
    for dep in "${deps[@]}"; do
        if ! command -v "$dep" >/dev/null 2>&1; then
            missing_deps+=("$dep")
        else
            echo -e "${GREEN}✓ $dep${NC}"
        fi
    done
    
    if [[ ${#missing_deps[@]} -gt 0 ]]; then
        echo -e "${RED}Missing dependencies:${NC}"
        for dep in "${missing_deps[@]}"; do
            echo -e "${RED}  ✗ $dep${NC}"
        done
        echo ""
        echo -e "${YELLOW}Installation hints:${NC}"
        echo -e "${YELLOW}  soroban: cargo install --version 22.0.11 soroban-cli${NC}"
        echo -e "${YELLOW}  jq: apt install jq (Ubuntu) or brew install jq (macOS)${NC}"
        echo -e "${YELLOW}  node/npm: https://nodejs.org/${NC}"
        exit 1
    fi
    
    # Create required directories
    echo ""
    echo -e "${BLUE}Creating directory structure...${NC}"
    mkdir -p "$PROJECT_ROOT/deployments"
    mkdir -p "$PROJECT_ROOT/backups"
    echo -e "${GREEN}✓ Directories created${NC}"
    
    # Check for environment file
    echo ""
    echo -e "${BLUE}Checking environment configuration...${NC}"
    if [[ ! -f "$PROJECT_ROOT/.env" ]]; then
        if [[ -f "$PROJECT_ROOT/.env.example" ]]; then
            echo -e "${YELLOW}⚠ .env file not found, creating from example...${NC}"
            cp "$PROJECT_ROOT/.env.example" "$PROJECT_ROOT/.env"
            echo -e "${YELLOW}Please edit .env file with your credentials${NC}"
        else
            echo -e "${RED}✗ .env.example file not found${NC}"
            exit 1
        fi
    else
        echo -e "${GREEN}✓ .env file found${NC}"
    fi
    
    # Validate rust toolchain
    echo ""
    echo -e "${BLUE}Checking Rust toolchain...${NC}"
    if ! rustup target list --installed | grep -q "wasm32-unknown-unknown"; then
        echo -e "${YELLOW}⚠ Adding wasm32-unknown-unknown target...${NC}"
        rustup target add wasm32-unknown-unknown
    fi
    echo -e "${GREEN}✓ Rust toolchain configured${NC}"
    
    # Install Node.js dependencies
    echo ""
    echo -e "${BLUE}Installing Node.js dependencies...${NC}"
    cd "$PROJECT_ROOT"
    if [[ -f "package.json" ]]; then
        npm install
        echo -e "${GREEN}✓ Node.js dependencies installed${NC}"
    fi
    
    echo ""
    echo -e "${GREEN}=== Environment initialization completed ===${NC}"
    echo -e "${YELLOW}Next steps:${NC}"
    echo -e "${YELLOW}1. Edit .env file with your credentials${NC}"
    echo -e "${YELLOW}2. Run: $0 deploy -n testnet${NC}"
}

# Deploy contracts
deploy_contracts() {
    echo -e "${BLUE}=== Deploying Smart Contracts ===${NC}"
    echo ""
    
    cd "$SCRIPT_DIR"
    ./deploy.sh --network "$NETWORK" --verify
}

# Upgrade contracts with safety checks
upgrade_contracts() {
    echo -e "${BLUE}=== Upgrading Smart Contracts ===${NC}"
    echo ""
    
    cd "$SCRIPT_DIR"
    
    # Always do dry-run first
    echo -e "${YELLOW}Performing dry-run first...${NC}"
    if ! ./upgrade.sh --network "$NETWORK" --dry-run; then
        echo -e "${RED}Dry-run failed, aborting upgrade${NC}" >&2
        exit 1
    fi
    
    echo ""
    echo -e "${YELLOW}Dry-run completed successfully.${NC}"
    read -p "Proceed with actual upgrade? (y/N): " -n 1 -r
    echo
    
    if [[ $REPLY =~ ^[Yy]$ ]]; then
        ./upgrade.sh --network "$NETWORK"
    else
        echo -e "${YELLOW}Upgrade cancelled${NC}"
    fi
}

# Verify contracts
verify_contracts() {
    echo -e "${BLUE}=== Verifying Smart Contracts ===${NC}"
    echo ""
    
    cd "$SCRIPT_DIR"
    ./verify.sh --network "$NETWORK" --rebuild
}

# Backup contract state
backup_contract_state() {
    echo -e "${BLUE}=== Backing Up Contract State ===${NC}"
    echo ""
    
    local deployment_file="$PROJECT_ROOT/deployments/${NETWORK}.json"
    if [[ ! -f "$deployment_file" ]]; then
        echo -e "${RED}No deployment found for network $NETWORK${NC}" >&2
        exit 1
    fi
    
    local backup_dir="$PROJECT_ROOT/backups/$NETWORK"
    local timestamp=$(date -u +"%Y%m%d-%H%M%S")
    
    mkdir -p "$backup_dir"
    
    # Copy deployment metadata
    cp "$deployment_file" "$backup_dir/deployment-${timestamp}.json"
    echo -e "${GREEN}✓ Deployment metadata backed up${NC}"
    
    # Create state backup (placeholder - would need contract-specific implementation)
    local contracts
    contracts=$(jq -r '.contracts | keys[]' "$deployment_file")
    
    while IFS= read -r contract_name; do
        echo -e "${BLUE}Backing up $contract_name state...${NC}"
        # This would need contract-specific backup logic
        echo '{"note": "Manual state backup required"}' > "$backup_dir/${contract_name}-state-${timestamp}.json"
        echo -e "${YELLOW}⚠ $contract_name: Manual state backup required${NC}"
    done <<< "$contracts"
    
    echo ""
    echo -e "${GREEN}Backup completed: $backup_dir${NC}"
}

# Show deployment status
show_status() {
    echo -e "${BLUE}=== ai-net Smart Contract Status ===${NC}"
    echo ""
    
    local deployment_file="$PROJECT_ROOT/deployments/${NETWORK}.json"
    if [[ ! -f "$deployment_file" ]]; then
        echo -e "${YELLOW}No deployment found for network $NETWORK${NC}"
        return
    fi
    
    local metadata
    metadata=$(cat "$deployment_file")
    
    echo -e "${BLUE}Network:${NC} $(echo "$metadata" | jq -r '.network')"
    echo -e "${BLUE}RPC URL:${NC} $(echo "$metadata" | jq -r '.rpc_url')"
    echo -e "${BLUE}Deployed:${NC} $(echo "$metadata" | jq -r '.deployed_at // "Never"')"
    echo ""
    
    echo -e "${BLUE}Contracts:${NC}"
    local contracts
    contracts=$(echo "$metadata" | jq -r '.contracts | keys[]')
    
    if [[ -z "$contracts" ]]; then
        echo -e "${YELLOW}  No contracts deployed${NC}"
        return
    fi
    
    while IFS= read -r contract_name; do
        local contract_info
        contract_info=$(echo "$metadata" | jq -r --arg name "$contract_name" '.contracts[$name]')
        
        local contract_id
        contract_id=$(echo "$contract_info" | jq -r '.contract_id')
        
        local wasm_hash
        wasm_hash=$(echo "$contract_info" | jq -r '.wasm_hash')
        
        local deployed_at
        deployed_at=$(echo "$contract_info" | jq -r '.deployed_at // "Unknown"')
        
        echo -e "${GREEN}  ✓ $contract_name${NC}"
        echo -e "${BLUE}    ID:${NC} $contract_id"
        echo -e "${BLUE}    Hash:${NC} ${wasm_hash:0:16}..."
        echo -e "${BLUE}    Deployed:${NC} $deployed_at"
        echo ""
    done <<< "$contracts"
    
    # Show deployment history
    local history_count
    history_count=$(echo "$metadata" | jq '.deployment_history | length')
    
    if [[ "$history_count" -gt 0 ]]; then
        echo -e "${BLUE}Recent deployment history:${NC}"
        echo "$metadata" | jq -r '.deployment_history[-3:] | .[] | "  \(.timestamp) - \(.action)"'
    fi
}

# Clean build artifacts
clean_artifacts() {
    echo -e "${BLUE}=== Cleaning Build Artifacts ===${NC}"
    echo ""
    
    cd "$PROJECT_ROOT"
    
    # Clean Rust artifacts
    if [[ -d "target" ]]; then
        echo -e "${BLUE}Removing Rust build artifacts...${NC}"
        cargo clean
        echo -e "${GREEN}✓ Rust artifacts cleaned${NC}"
    fi
    
    # Clean Node.js artifacts
    if [[ -d "node_modules" ]]; then
        echo -e "${BLUE}Cleaning Node.js artifacts...${NC}"
        rm -rf node_modules package-lock.json
        echo -e "${GREEN}✓ Node.js artifacts cleaned${NC}"
    fi
    
    # Clean temporary files
    echo -e "${BLUE}Removing temporary files...${NC}"
    find . -name "*.tmp" -type f -delete 2>/dev/null || true
    find . -name "*~" -type f -delete 2>/dev/null || true
    echo -e "${GREEN}✓ Temporary files cleaned${NC}"
    
    echo ""
    echo -e "${GREEN}Cleanup completed${NC}"
}

# Main execution
main() {
    case $ACTION in
        init)
            init_environment
            ;;
        deploy)
            deploy_contracts
            ;;
        upgrade)
            upgrade_contracts
            ;;
        verify)
            verify_contracts
            ;;
        backup)
            backup_contract_state
            ;;
        status)
            show_status
            ;;
        clean)
            clean_artifacts
            ;;
        *)
            echo -e "${RED}Unknown action: $ACTION${NC}" >&2
            usage >&2
            exit 1
            ;;
    esac
}

# Entry point
main "$@"
