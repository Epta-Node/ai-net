#!/usr/bin/env bash

set -euo pipefail

NETWORK="${NETWORK:-testnet}"
NEW_VERSION="${NEW_VERSION:-1.0.1-upgrade-check}"
SKIP_BUILD="${SKIP_BUILD:-false}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
MANIFEST="${MANIFEST:-$PROJECT_ROOT/deployments/${NETWORK}.json}"
TARGET_DIR="$PROJECT_ROOT/target/wasm32-unknown-unknown/release"

CONTRACTS=(
  "agent-registry:agent_registry"
  "agent-bidding:agent_bidding"
  "task-store:task_store"
  "error-resolver:error_resolver"
  "error-registry:error_registry"
)

usage() {
  cat <<EOF
Usage: NETWORK=testnet NEW_VERSION=1.0.1 $0

Runs the verified live-testnet upgrade sequence for ai-net contracts.

Required environment:
  STELLAR_SECRET_KEY   Source account with admin authority for every contract.

Optional environment:
  NETWORK              testnet, futurenet, or mainnet. Defaults to testnet.
  MANIFEST             Deployment manifest path. Defaults to deployments/<network>.json.
  NEW_VERSION          Version string written by contract_version after upgrade.
  SKIP_BUILD           true to reuse existing release WASM artifacts.
EOF
}

network_passphrase() {
  case "$NETWORK" in
    testnet) echo "Test SDF Network ; September 2015" ;;
    futurenet) echo "Test SDF Future Network ; October 2022" ;;
    mainnet) echo "Public Global Stellar Network ; September 2015" ;;
    *) echo "Unsupported NETWORK=$NETWORK" >&2; exit 1 ;;
  esac
}

rpc_url() {
  if [[ -n "${STELLAR_RPC_URL:-}" ]]; then
    echo "$STELLAR_RPC_URL"
    return
  fi

  case "$NETWORK" in
    testnet) echo "https://soroban-testnet.stellar.org" ;;
    futurenet) echo "https://rpc-futurenet.stellar.org" ;;
    mainnet) echo "https://mainnet.sorobanrpc.com" ;;
    *) echo "Unsupported NETWORK=$NETWORK" >&2; exit 1 ;;
  esac
}

require_tools() {
  command -v soroban >/dev/null || { echo "soroban CLI is required" >&2; exit 1; }
  command -v jq >/dev/null || { echo "jq is required" >&2; exit 1; }
  [[ -n "${STELLAR_SECRET_KEY:-}" ]] || { echo "STELLAR_SECRET_KEY is required" >&2; exit 1; }
  [[ -f "$MANIFEST" ]] || { echo "Manifest not found: $MANIFEST" >&2; exit 1; }
}

build_contracts() {
  if [[ "$SKIP_BUILD" == "true" ]]; then
    echo "Skipping contract build"
    return
  fi
  cargo build --manifest-path "$PROJECT_ROOT/Cargo.toml" --target wasm32-unknown-unknown --release
}

contract_id() {
  local name="$1"
  jq -r --arg name "$name" '.contracts[$name].contract_id // empty' "$MANIFEST"
}

invoke() {
  local contract="$1"
  shift
  soroban contract invoke \
    --id "$contract" \
    --source "$STELLAR_SECRET_KEY" \
    --rpc-url "$(rpc_url)" \
    --network-passphrase "$(network_passphrase)" \
    -- "$@"
}

install_wasm() {
  local wasm="$1"
  soroban contract install \
    --wasm "$wasm" \
    --source "$STELLAR_SECRET_KEY" \
    --rpc-url "$(rpc_url)" \
    --network-passphrase "$(network_passphrase)"
}

update_manifest() {
  local name="$1"
  local wasm_hash="$2"
  local old_version="$3"
  local timestamp
  timestamp="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"

  local tmp
  tmp="$(mktemp)"
  jq \
    --arg name "$name" \
    --arg wasmHash "$wasm_hash" \
    --arg oldVersion "$old_version" \
    --arg newVersion "$NEW_VERSION" \
    --arg timestamp "$timestamp" \
    '.contracts[$name].wasm_hash = $wasmHash |
     .contracts[$name].version = $newVersion |
     .contracts[$name].upgraded_at = $timestamp |
     .deployment_history += [{
       action: "verified-upgrade",
       contract: $name,
       old_version: $oldVersion,
       new_version: $newVersion,
       wasm_hash: $wasmHash,
       network: .network,
       timestamp: $timestamp
     }]' "$MANIFEST" > "$tmp"
  mv "$tmp" "$MANIFEST"
}

verify_contract() {
  local name="$1"
  local wasm_name="$2"
  local id
  id="$(contract_id "$name")"
  [[ -n "$id" && "$id" != "null" ]] || { echo "Missing contract_id for $name" >&2; exit 1; }

  local wasm="$TARGET_DIR/${wasm_name}.wasm"
  [[ -f "$wasm" ]] || { echo "Missing WASM for $name: $wasm" >&2; exit 1; }

  echo "Verifying $name at $id"
  local admin
  admin="$(invoke "$id" admin)"
  [[ -n "$admin" && "$admin" != "null" ]] || { echo "$name did not expose admin" >&2; exit 1; }

  local old_version
  old_version="$(invoke "$id" contract_version)"
  [[ -n "$old_version" ]] || { echo "$name did not expose contract_version" >&2; exit 1; }

  local wasm_hash
  wasm_hash="$(install_wasm "$wasm" | grep -Eo '[A-Fa-f0-9]{64}' | head -1)"
  [[ -n "$wasm_hash" ]] || { echo "No WASM hash returned for $name" >&2; exit 1; }

  invoke "$id" upgrade --new_wasm_hash "$wasm_hash" --new_version "$NEW_VERSION" >/dev/null

  local observed_version
  observed_version="$(invoke "$id" contract_version)"
  [[ "$observed_version" == "$NEW_VERSION" ]] || {
    echo "$name version mismatch: expected $NEW_VERSION, got $observed_version" >&2
    exit 1
  }

  update_manifest "$name" "$wasm_hash" "$old_version"
  echo "$name upgraded and verified: $old_version -> $observed_version"
}

main() {
  if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
    usage
    exit 0
  fi

  require_tools
  build_contracts

  for entry in "${CONTRACTS[@]}"; do
    IFS=":" read -r name wasm_name <<< "$entry"
    verify_contract "$name" "$wasm_name"
  done
}

main "$@"
