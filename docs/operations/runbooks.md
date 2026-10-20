# AI-Net Operator Runbooks

This appendix documents step-by-step resolution procedures for the five most common production incidents. Each runbook follows the format: **Symptoms → Diagnosis → Resolution → Verification**.

For steady-state operations guidance see [NODE_OPERATORS_GUIDE.md](../NODE_OPERATORS_GUIDE.md).

---

## Table of Contents

1. [Agent goes offline mid-task](#1-agent-goes-offline-mid-task)
2. [Payment reconciliation drift](#2-payment-reconciliation-drift)
3. [Stellar transaction stuck in pending](#3-stellar-transaction-stuck-in-pending)
4. [Venice AI — all keys cooling down](#4-venice-ai--all-keys-cooling-down)
5. [Disk space warning — archive directory full](#5-disk-space-warning--archive-directory-full)

---

## 1. Agent goes offline mid-task

### Symptoms

- Task status stuck in `running` for longer than 5 minutes with no progress events.
- Prometheus counter `agent_watchdog_evictions_total` is incrementing.
- Logs contain: `[watchdog] agent <id> missed heartbeat`.

### Diagnosis

```bash
# 1. Identify which agents the watchdog considers offline
curl -s -H "Authorization: Bearer $ADMIN_API_KEY" \
  http://localhost:3000/api/admin/watchdog/status | jq '.offline_agents'

# 2. Check the agent container logs (replace <agent-container> with the name from step 1)
docker logs --tail 200 <agent-container>

# 3. Check the coordinator logs for task routing decisions
docker logs --tail 200 ai-net-coordinator | grep "task_id=<TASK_ID>"
```

### Resolution

**If the container is still running but unresponsive:**

```bash
docker restart <agent-container>
# Wait 30 s, then verify the agent re-registers
curl -s http://localhost:3000/api/agents | jq '.[] | select(.id == "<AGENT_ID>") | .status'
```

**If the container has crashed and cannot recover:**

```bash
# Evict the agent — coordinator will attempt to re-route the task
curl -s -X POST \
  -H "Authorization: Bearer $ADMIN_API_KEY" \
  http://localhost:3000/api/admin/agents/<AGENT_ID>/evict

# Confirm the task was re-routed
curl -s http://localhost:3000/api/tasks/<TASK_ID> | jq '.status, .assigned_agent_id'
```

**If no fallback agent is available (task cannot be re-routed):**

```bash
# Cancel the task — escrowed XLM is automatically refunded to the submitter
curl -s -X POST \
  -H "Authorization: Bearer $ADMIN_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"reason":"agent_unavailable","refund":true}' \
  http://localhost:3000/api/admin/tasks/<TASK_ID>/cancel
```

### Verification

```bash
# Task should now be in 'cancelled' or 're-running' state
curl -s http://localhost:3000/api/tasks/<TASK_ID> | jq '.status'
# Prometheus watchdog counter should stop incrementing
curl -s http://localhost:3000/metrics | grep agent_watchdog_evictions_total
```

---

## 2. Payment reconciliation drift

### Symptoms

- Webhook payload received at `RECONCILIATION_WEBHOOK_URL` with `alert: "reconciliation_drift_critical"`.
- Log line: `[reconciliation] critical drift detected: expected=X actual=Y delta=Z`.
- `RECONCILIATION_CRITICAL_DRIFT_PERCENT` threshold exceeded.

### Diagnosis

```bash
# 1. Fetch the most recent reconciliation report
curl -s -H "Authorization: Bearer $ADMIN_API_KEY" \
  http://localhost:3000/api/admin/reconciliation/last-report | jq .

# 2. Compare locked escrow balances on Horizon against the local task store
# Replace <COORDINATOR_PUBLIC_KEY> with STELLAR_COORDINATOR_PUBLIC_KEY from .env
curl -s "https://horizon-testnet.stellar.org/claimable_balances?claimant=<COORDINATOR_PUBLIC_KEY>&limit=200" \
  | jq '[.._embedded.records[] | {id, amount, asset_type}]'

# 3. Cross-reference with local task store
curl -s -H "Authorization: Bearer $ADMIN_API_KEY" \
  "http://localhost:3000/api/admin/tasks?status=running&limit=200" | jq '[.[].escrow_amount]'
```

### Resolution

**If drift is caused by a stuck task with a locked escrow older than `RECONCILIATION_ESCROW_EXPIRY_MS`:**

The reconciliation daemon will automatically refund these escrows if `RECONCILIATION_REMEDIATION_ENABLED=true`. To trigger an immediate remediation cycle without waiting for the next scheduled run:

```bash
curl -s -X POST \
  -H "Authorization: Bearer $ADMIN_API_KEY" \
  http://localhost:3000/api/admin/reconciliation/run-now
```

**If a specific claimable balance is orphaned (task deleted, balance still on-chain):**

```bash
# Manually refund the orphaned balance — coordinator claims it back
curl -s -X POST \
  -H "Authorization: Bearer $ADMIN_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"balance_id":"<CLAIMABLE_BALANCE_ID>"}' \
  http://localhost:3000/api/admin/reconciliation/refund-balance
```

### Verification

```bash
# Drift percentage should return to below the warning threshold
curl -s -H "Authorization: Bearer $ADMIN_API_KEY" \
  http://localhost:3000/api/admin/reconciliation/last-report | jq '.drift_percent'
```

---

## 3. Stellar transaction stuck in pending

### Symptoms

- Payment operation initiated more than 30 seconds ago with no confirmed hash.
- Log line: `[payment] transaction not confirmed after 30s, hash=<TX_HASH>`.
- Horizon returns `PENDING` or the transaction is absent from the ledger.

### Diagnosis

```bash
# 1. Look up the transaction on Horizon by hash
curl -s "https://horizon-testnet.stellar.org/transactions/<TX_HASH>" | jq '.status, .result_code'

# 2. Check the coordinator's current sequence number on-chain
curl -s "https://horizon-testnet.stellar.org/accounts/<COORDINATOR_PUBLIC_KEY>" \
  | jq '.sequence'

# 3. Compare to the sequence the node thinks it last used
curl -s -H "Authorization: Bearer $ADMIN_API_KEY" \
  http://localhost:3000/api/admin/stellar/sequence-state | jq .
```

### Resolution

**If the transaction was never submitted (build error, network timeout):**

```bash
# Retry the specific operation — the coordinator will rebuild and re-sign
curl -s -X POST \
  -H "Authorization: Bearer $ADMIN_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"task_id":"<TASK_ID>","operation":"release"}' \
  http://localhost:3000/api/admin/payment/retry
```

**If the transaction was submitted but has a stale sequence number (common after a coordinator restart):**

```bash
# Force the coordinator to reload its sequence number from Horizon
curl -s -X POST \
  -H "Authorization: Bearer $ADMIN_API_KEY" \
  http://localhost:3000/api/admin/stellar/sync-sequence
```

**If the transaction is genuinely stuck due to a low fee (fee-bump required):**

```bash
# Submit a fee-bump transaction wrapping the original
# <ORIGINAL_TX_XDR> comes from the coordinator's pending-tx log
stellar transaction fee-bump \
  --fee-account <COORDINATOR_PUBLIC_KEY> \
  --base-fee 10000 \
  --inner-transaction "<ORIGINAL_TX_XDR>" \
  --source mycoord \
  --network testnet \
  --sign
```

### Verification

```bash
# Transaction should appear as succeeded on Horizon
curl -s "https://horizon-testnet.stellar.org/transactions/<TX_HASH>" | jq '.successful'
# Task payment status should update
curl -s http://localhost:3000/api/tasks/<TASK_ID> | jq '.payment_status'
```

---

## 4. Venice AI — all keys cooling down

### Symptoms

- Log line: `[venice] VeniceUnavailableError: all API keys are in cooldown`.
- Prometheus gauge `venice_keys_available` reads `0`.
- New task submissions return HTTP 503.

### Diagnosis

```bash
# 1. Check which keys are in cooldown and when they expire
curl -s -H "Authorization: Bearer $ADMIN_API_KEY" \
  http://localhost:3000/api/admin/venice/key-status | jq .

# 2. Check the error rate that triggered the cooldown
docker logs --tail 500 ai-net-backend | grep "venice" | grep -E "error|cooldown|rate"

# 3. Confirm Venice's own status page is reachable
curl -s -o /dev/null -w "%{http_code}" https://api.venice.ai/api/v1/health
```

### Resolution

**If all keys cooled down due to a temporary Venice outage:**

Wait for `VENICE_KEY_COOLDOWN_MS` (default 60 s) to pass. Keys are automatically re-enabled after the cooldown window. Monitor with:

```bash
watch -n 5 'curl -s -H "Authorization: Bearer $ADMIN_API_KEY" \
  http://localhost:3000/api/admin/venice/key-status | jq ".keys_available"'
```

**If the cooldown needs to be cleared immediately (e.g. Venice is back, outage confirmed over):**

```bash
# Reset all key error counters and remove cooldowns
curl -s -X POST \
  -H "Authorization: Bearer $ADMIN_API_KEY" \
  http://localhost:3000/api/admin/venice/reset-cooldowns
```

**To add an additional backup API key during an incident:**

```bash
# Add a new key without restarting (takes effect at next request cycle)
curl -s -X POST \
  -H "Authorization: Bearer $ADMIN_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"key":"<NEW_VENICE_API_KEY>"}' \
  http://localhost:3000/api/admin/venice/add-key
```

### Verification

```bash
curl -s -H "Authorization: Bearer $ADMIN_API_KEY" \
  http://localhost:3000/api/admin/venice/key-status | jq '.keys_available'
# Should be >= 1

curl -s http://localhost:3000/health | jq '.venice'
# Should show: "ok"
```

---

## 5. Disk space warning — archive directory full

### Symptoms

- Alert fires: disk usage > 90% on the archive mount.
- Log line: `[archive] ENOSPC: no space left on device`.
- Docker containers may fail to write logs or crash.

### Diagnosis

```bash
# 1. Check disk usage breakdown
df -h
du -sh /var/lib/docker/volumes/ai-net_archive* 2>/dev/null || \
  du -sh ./data/archives/ 2>/dev/null

# 2. Find the largest archive files
find ./data/archives -type f -name "*.tar.gz" -printf "%s %p\n" \
  | sort -rn | head -20

# 3. Check configured retention policy
grep -E "ARCHIVE|RETENTION" .env
```

### Resolution

**Manual purge of archives older than the retention window:**

```bash
# Purge archives older than 30 days (adjust -mtime as needed)
find ./data/archives -type f -name "*.tar.gz" -mtime +30 -delete
# Verify space reclaimed
df -h
```

**If archives are being written faster than they can be purged (backlog):**

```bash
# Temporarily reduce the archive retention period in .env
# Then signal the backend to reload config without a full restart
kill -HUP $(pgrep -f "node.*backend")
# Or for Docker deployments:
docker exec ai-net-backend kill -HUP 1
```

**Adjust the retention configuration permanently:**

Edit `.env` (or your secrets manager entry) and set the desired retention window:

```bash
# Keep archives for 14 days instead of the default
ARCHIVE_RETENTION_DAYS=14
```

Then restart the backend:

```bash
docker compose restart backend
```

### Verification

```bash
# Disk usage should be below 80% after purge
df -h | grep -E "archive|data"

# Confirm the backend is writing archives successfully
docker logs --tail 50 ai-net-backend | grep -i archive
```

---

*For additional troubleshooting guidance see [NODE_OPERATORS_GUIDE.md § 12 Troubleshooting & Common Errors](../NODE_OPERATORS_GUIDE.md#12-troubleshooting--common-errors).*
