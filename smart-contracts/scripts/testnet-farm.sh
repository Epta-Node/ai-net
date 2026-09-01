#!/bin/bash

# ─────────────────────────────────────────────────────────────────────────────
# testnet-farm.sh
#
# Contract integration test farm against the LIVE Stellar testnet.
#
# What it does:
#   1. Builds the deployable Soroban contracts to Wasm.
#   2. Deploys the core contracts (agent-registry, agent-bidding, error-registry,
#      task-store) to testnet using the `soroban` CLI.
#   3. Runs the cross-contract integration farm (tests/testnet/contract-farm.test.ts),
#      which exercises the registry → bidding → task_store flow end-to-end.
#   4. Records per-operation gas/fee (CPU instructions + charge) captured from
#      `soroban contract invoke --print-diag` output.
#   5. Publishes a JSON + Markdown report artifact (testnet-farm-report.json | .md).
#
# Exit code: 0 on success, non-zero on any failure. CI treats the farm as a real
# signal — a breakage must page maintainers.
#
# Env:
#   STELLAR_SECRET_KEY      Deployment/invocation account secret (required)
#   STELLAR_RPC_URL         Soroban RPC URL (default: testnet)
#   STELLAR_HORIZON_URL     Horizon URL (default: testnet)
#   STELLAR_NETWORK         testnet | futurenet | mainnet (default: testnet)
#   FARM_OUTPUT_DIR         Where to write the report (default: ./testnet-farm-output)
#   RUN_TESTNET_FARM        Set to "true" to actually execute the farm (CI guard)
#
# Usage:
#   RUN_TESTNET_FARM=true STELLAR_SECRET_KEY=... ./scripts/testnet-farm.sh
# ─────────────────────────────────────────────────────────────────────────────

set -euo pipefail

# ── Colours ──────────────────────────────────────────────────────────────────
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

# ── Defaults ─────────────────────────────────────────────────────────────────
NETWORK="${STELLAR_NETWORK:-testnet}"
SKIP_BUILD="${FARM_SKIP_BUILD:-false}"
OUTPUT_DIR="${FARM_OUTPUT_DIR:-./testnet-farm-output}"

# CI guard: the farm hits a real network and costs testnet XLM. Only run when
# explicitly requested via RUN_TESTNET_FARM=true (set by the nightly job / CI).
if [[ "${RUN_TESTNET_FARM:-false}" != "true" ]]; then
    echo -e "${YELLOW}RUN_TESTNET_FARM is not 'true' — refusing to run against testnet.${NC}"
    echo -e "${YELLOW}Set RUN_TESTNET_FARM=true to execute the contract test farm.${NC}"
    exit 0
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
TARGET_DIR="$PROJECT_ROOT/target/wasm32v1-none/release"

TESTNET_PASSPHRASE="Test SDF Network ; September 2015"
RPC_URL="${STELLAR_RPC_URL:-https://soroban-testnet.stellar.org}"
HORIZON_URL="${STELLAR_HORIZON_URL:-https://horizon-testnet.stellar.org}"

REPORT_JSON="$OUTPUT_DIR/testnet-farm-report.json"
REPORT_MD="$OUTPUT_DIR/testnet-farm-report.md"
GAS_JSON="$OUTPUT_DIR/gas-measurements.json"

mkdir -p "$OUTPUT_DIR"

# ── Dependency checks ────────────────────────────────────────────────────────
# The farm needs a Soroban/Stellar CLI (either the legacy `soroban` binary or the
# modern `stellar` successor). SOROBAN_CLI_BIN overrides which one is invoked.
CLI_BIN="${SOROBAN_CLI_BIN:-soroban}"
if [[ -z "$SOROBAN_CLI_BIN" ]]; then
    if command -v soroban >/dev/null 2>&1; then
        CLI_BIN="soroban"
    elif command -v stellar >/dev/null 2>&1; then
        CLI_BIN="stellar"
    else
        echo -e "${RED}Error: neither 'soroban' nor 'stellar' CLI found on PATH${NC}" >&2
        exit 1
    fi
fi
echo -e "${BLUE}Using CLI binary:${NC} $CLI_BIN"

for dep in jq cargo sha256sum; do
    if ! command -v "$dep" >/dev/null 2>&1; then
        echo -e "${RED}Error: required dependency '$dep' not found${NC}" >&2
        exit 1
    fi
done

if [[ -z "${STELLAR_SECRET_KEY:-}" ]]; then
    echo -e "${RED}Error: STELLAR_SECRET_KEY is required to drive the farm.${NC}" >&2
    exit 1
fi

# ── Helpers ──────────────────────────────────────────────────────────────────

get_network_passphrase() {
    case "$NETWORK" in
        testnet)   echo "Test SDF Network ; September 2015" ;;
        futurenet) echo "Test SDF Future Network ; October 2022" ;;
        mainnet)   echo "Public Global Stellar Network ; September 2015" ;;
        *)         echo "Test SDF Network ; September 2015" ;;
    esac
}

# Extract contract ID from `soroban contract deploy` output.
extract_contract_id() {
    grep -oE 'C[A-Z0-9]{55}' | head -1
}

echo -e "${BLUE}=== ai-net Contract Test Farm (live $NETWORK) ===${NC}"
echo -e "${BLUE}RPC:${NC} $RPC_URL"
echo -e "${BLUE}Output:${NC} $OUTPUT_DIR"
echo ""

# ── 1. Build contracts ───────────────────────────────────────────────────────
if [[ "$SKIP_BUILD" == "true" ]]; then
    echo -e "${YELLOW}Skipping build step${NC}"
else
    echo -e "${BLUE}Building contracts (release Wasm)...${NC}"
    (
        cd "$PROJECT_ROOT"
        cargo build --locked -p agent-registry --target wasm32v1-none --release
        cargo build --locked -p agent-bidding --target wasm32v1-none --release
        cargo build --locked -p error-registry --target wasm32v1-none --release
        cargo build --locked -p task-store --target wasm32v1-none --release
    )
    echo -e "${GREEN}✓ Contracts built${NC}"
fi

# Actual wasm file names (crate target names).
WASM_REGISTRY="$TARGET_DIR/agent_registry.wasm"
WASM_BIDDING="$TARGET_DIR/agent_bidding.wasm"
WASM_ERRORREG="$TARGET_DIR/error_registry.wasm"
WASM_TASKSTORE="$TARGET_DIR/task_store.wasm"

for f in "$WASM_REGISTRY" "$WASM_BIDDING" "$WASM_ERRORREG" "$WASM_TASKSTORE"; do
    if [[ ! -f "$f" ]]; then
        echo -e "${RED}Error: missing Wasm artifact $f${NC}" >&2
        exit 1
    fi
done

# ── 2. Deploy contracts ──────────────────────────────────────────────────────
declare -A CONTRACT_IDS
CONTRACT_IDS[agent_registry]=""
CONTRACT_IDS[agent_bidding]=""
CONTRACT_IDS[error_registry]=""
CONTRACT_IDS[task_store]=""

deploy_contract() {
    local name="$1"
    local wasm_file="$2"
    echo -e "${BLUE}Deploying $name...${NC}"
    local id
    id=$($CLI_BIN contract deploy \
        --wasm "$wasm_file" \
        --source "$STELLAR_SECRET_KEY" \
        --rpc-url "$RPC_URL" \
        --network-passphrase "$(get_network_passphrase)" )
    id=$(echo "$id" | extract_contract_id)
    if [[ -z "$id" ]]; then
        echo -e "${RED}✗ Failed to deploy $name${NC}" >&2
        return 1
    fi
    CONTRACT_IDS["$name"]="$id"
    echo -e "${GREEN}✓ $name deployed: $id${NC}"
    return 0
}

deploy_contract "agent_registry" "$WASM_REGISTRY"
deploy_contract "agent_bidding" "$WASM_BIDDING"
deploy_contract "error_registry" "$WASM_ERRORREG"
deploy_contract "task_store" "$WASM_TASKSTORE"

if [[ -z "${CONTRACT_IDS[agent_registry]}" || -z "${CONTRACT_IDS[agent_bidding]}" \
      || -z "${CONTRACT_IDS[error_registry]}" || -z "${CONTRACT_IDS[task_store]}" ]]; then
    echo -e "${RED}One or more contracts failed to deploy — aborting farm.${NC}" >&2
    exit 1
fi

# Persist contract IDs + network config for the Jest farm to consume.
cat > "$OUTPUT_DIR/deployed-contracts.json" <<EOF
{
  "network": "$NETWORK",
  "rpc_url": "$RPC_URL",
  "horizon_url": "$HORIZON_URL",
  "network_passphrase": "$(get_network_passphrase)",
  "deployed_at": "$(date -u +"%Y-%m-%dT%H:%M:%SZ")",
  "contracts": {
    "agent_registry": "${CONTRACT_IDS[agent_registry]}",
    "agent_bidding": "${CONTRACT_IDS[agent_bidding]}",
    "error_registry": "${CONTRACT_IDS[error_registry]}",
    "task_store": "${CONTRACT_IDS[task_store]}"
  }
}
EOF

echo -e "${GREEN}✓ All contracts deployed — IDs written to deployed-contracts.json${NC}"
echo ""

# ── 3. Run the cross-contract integration farm ───────────────────────────────
echo -e "${BLUE}Running cross-contract integration farm...${NC}"
# Disable set -e around the farm so a test failure still produces a report
# artifact (pass/fail + gas) before the script exits non-zero.
set +e
FARM_CONTRACT_FILE="$OUTPUT_DIR/deployed-contracts.json" \
FARM_GAS_FILE="$OUTPUT_DIR/gas-measurements.json" \
STELLAR_SECRET_KEY="$STELLAR_SECRET_KEY" \
STELLAR_RPC_URL="$RPC_URL" \
STELLAR_NETWORK="$NETWORK" \
SOROBAN_CLI_BIN="$CLI_BIN" \
RUN_INTEGRATION_TESTS=true \
npx jest --runInBand --forceExit --testPathPattern='tests/testnet/contract-farm.test.ts'
FARM_EXIT=$?
set -e
echo -e "${BLUE}Farm finish code: $FARM_EXIT${NC}"

# ── 4. Assemble the report ───────────────────────────────────────────────────
TIMESTAMP=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
SHA=$(cd "$PROJECT_ROOT" && git rev-parse --short HEAD 2>/dev/null || echo "unknown")

GAS_JSON_CONTENT="[]"
if [[ -f "$GAS_JSON" ]]; then
    GAS_JSON_CONTENT=$(cat "$GAS_JSON")
fi

jq -n \
    --arg ts "$TIMESTAMP" \
    --arg sha "$SHA" \
    --arg network "$NETWORK" \
    --arg rpc "$RPC_URL" \
    --arg exit "$FARM_EXIT" \
    --argjson contracts "$(cat "$OUTPUT_DIR/deployed-contracts.json" | jq '.contracts')" \
    --argjson gas "$GAS_JSON_CONTENT" \
    --arg status "$([ "$FARM_EXIT" -eq 0 ] && echo pass || echo fail)" \
    '{
        title: "Contract Integration Test Farm (live testnet)",
        timestamp: $ts,
        commit: $sha,
        network: $network,
        rpc_url: $rpc,
        status: $status,
        exit_code: ($exit | tonumber),
        contracts: $contracts,
        gas: $gas
    }' > "$REPORT_JSON"

# ── Markdown report ──────────────────────────────────────────────────────────
{
    echo "# Contract Integration Test Farm Report"
    echo ""
    echo "**Status:** \`$([ "$FARM_EXIT" -eq 0 ] && echo PASS || echo FAIL)\`"
    echo ""
    echo "| Field | Value |"
    echo "|-------|-------|"
    echo "| Timestamp | $TIMESTAMP |"
    echo "| Commit | $SHA |"
    echo "| Network | $NETWORK |"
    echo "| RPC URL | $RPC_URL |"
    echo "| Exit code | $FARM_EXIT |"
    echo ""
    echo "## Deployed Contracts"
    echo ""
    echo "| Contract | ID |"
    echo "|----------|----|"
    for name in agent_registry agent_bidding error_registry task_store; do
        echo "| $name | ${CONTRACT_IDS[$name]} |"
    done
    echo ""
    echo "## Gas Measurements (CU)"
    echo ""
    echo "| Operation | CPU insns | Mem insns | Fee (stroops) | Delta vs baseline |"
    echo "|-----------|-----------|-----------|----------------|-------------------|"
    echo "$GAS_JSON_CONTENT" | jq -r '.[] | "| \(.operation) | \(.cpu_insns) | \(.mem_insns) | \(.fee_stroops // 0) | \(.delta_cu // "—") |"'
} > "$REPORT_MD"

echo ""
echo -e "${BLUE}Report written to:${NC}"
echo -e "  ${GREEN}$REPORT_JSON${NC}"
echo -e "  ${GREEN}$REPORT_MD${NC}"

# ── Exit handling ────────────────────────────────────────────────────────────
if [[ "$FARM_EXIT" -ne 0 ]]; then
    echo -e "${RED}=== Contract test farm FAILED (exit $FARM_EXIT) ===${NC}" >&2
    exit "$FARM_EXIT"
fi

echo -e "${GREEN}=== Contract test farm PASSED ===${NC}"
exit 0
