#!/usr/bin/env bash
set -euo pipefail

echo "Checking smart-contracts for non-canonical update_current_contract_wasm calls..."

NON_CANONICAL_CALLS=$(grep -rn "update_current_contract_wasm" smart-contracts/contracts/ \
  | grep -v "smart-contracts/contracts/upgrade-manager/" \
  | grep -v "smart-contracts/contracts/agent_registry/src/upgrade.rs" || true)

if [ -n "$NON_CANONICAL_CALLS" ]; then
  echo "ERROR: Found non-canonical calls to update_current_contract_wasm:"
  echo "$NON_CANONICAL_CALLS"
  exit 1
fi

echo "SUCCESS: No non-canonical update_current_contract_wasm calls found."
