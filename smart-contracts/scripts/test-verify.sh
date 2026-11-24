#!/bin/bash
# Checks that `verify.sh --strict` passes on a matching deployment and fails
# on a deliberately mismatched Wasm hash. Uses a stub `soroban` CLI; no network.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

mkdir -p "$TMP/bin" "$TMP/wasm" "$TMP/reports"
printf '\0asmlocal' > "$TMP/wasm/agent_registry.wasm"
printf '\0asmtampered' > "$TMP/tampered.wasm"

# Stub CLI: `fetch` serves $ONCHAIN_WASM, `get_admin` returns $ONCHAIN_ADMIN.
cat > "$TMP/bin/soroban" << 'STUB'
#!/bin/bash
case "$*" in
    *"contract fetch"*)
        while [[ $# -gt 0 ]]; do
            [[ "$1" == "--out-file" ]] && cp "$ONCHAIN_WASM" "$2"
            shift
        done
        ;;
    *get_admin*) echo "\"$ONCHAIN_ADMIN\"" ;;
esac
STUB
chmod +x "$TMP/bin/soroban"

HASH="$(sha256sum "$TMP/wasm/agent_registry.wasm" | cut -d' ' -f1)"
cat > "$TMP/deployment.json" << JSON
{
  "network": "testnet",
  "contracts": {
    "agent-registry": {
      "contract_id": "CTEST",
      "wasm_hash": "$HASH",
      "version": "1.0.0",
      "admin": "GADMIN",
      "upgrade_function": "upgrade"
    }
  }
}
JSON

run_verify() {
    PATH="$TMP/bin:$PATH" WASM_DIR="$TMP/wasm" REPORT_DIR="$TMP/reports" \
        STELLAR_SECRET_KEY=test ONCHAIN_ADMIN=GADMIN \
        "$SCRIPT_DIR/verify.sh" -n testnet -f "$TMP/deployment.json" \
        --strict --json agent-registry 2>/dev/null
}

# Matching on-chain Wasm passes and yields valid JSON.
OUT="$(ONCHAIN_WASM="$TMP/wasm/agent_registry.wasm" run_verify)"
echo "$OUT" | jq -e '.verification.results[0].status == "verified"' >/dev/null

# A mismatched on-chain hash must fail in strict mode.
if ONCHAIN_WASM="$TMP/tampered.wasm" run_verify >"$TMP/fail.json"; then
    echo "FAIL: --strict accepted a mismatched Wasm hash" >&2
    exit 1
fi
jq -e '.verification.results[0].status == "failed"' "$TMP/fail.json" >/dev/null

echo "verify.sh --strict tests passed"
