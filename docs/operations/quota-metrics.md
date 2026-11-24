# Quota & Token-Budget Metrics

Operational visibility into `DAILY_TASK_LIMIT_PER_WALLET` and `TASK_TOKEN_BUDGET`.

Both limits were already enforced, but an operator could only observe them
*after* the fact — a `429` arrived, someone looked at the logs, and by then
there was no answer to the question that actually matters: **how many wallets
are close to the ceiling, and how much of today's token budget is gone?**

These metric families answer that on a normal Prometheus scrape, with no change
to the enforcement path and no extra query surface.

> **Scrape target:** `GET /metrics` (alias `GET /api/metrics`).
> Related: [NODE_OPERATORS_GUIDE.md §9](../NODE_OPERATORS_GUIDE.md#9-observability-metrics--health-monitoring).

---

## 1. Metric reference

### Quota family

| Metric | Type | Labels | Meaning |
|---|---|---|---|
| `ainet_wallet_daily_quota_limit` | gauge | — | The configured `DAILY_TASK_LIMIT_PER_WALLET`. `0` means the quota is disabled. |
| `ainet_wallet_daily_quota_wallets` | gauge | `bucket` | Wallets seen in the trailing 24h, folded into a utilisation band. |
| `ainet_wallet_daily_quota_utilization_max` | gauge | — | Highest utilisation ratio (`used / limit`) any single wallet reached in the trailing 24h. |
| `ainet_wallet_daily_quota_rejections_total` | counter | `bucket` | `429`s served for the daily task quota since process start, by the band the rejected wallet was in. |
| `ainet_wallet_daily_quota_source_errors` | gauge | — | `1` when the trailing-24h read failed and the gauges below are stale, `0` otherwise. Absent when healthy. |

Utilisation bands (the complete, fixed value set of the `bucket` label):

| `bucket` | Utilisation of `ainet_wallet_daily_quota_limit` |
|---|---|
| `disabled` | Quota is switched off (`limit = 0`) |
| `0-25%` | `0%` – `24.99%` |
| `25-50%` | `25%` – `49.99%` |
| `50-75%` | `50%` – `74.99%` |
| `75-100%` | `75%` – `99.99%` |
| `at-limit` | Exactly `100%` — the next request will be rejected |
| `over-limit` | Above `100%` — the limit was lowered after the wallet had already spent |

### Token-budget family

| Metric | Type | Labels | Meaning |
|---|---|---|---|
| `ainet_task_token_budget` | gauge | — | The configured per-task `TASK_TOKEN_BUDGET`. |
| `ainet_task_tokens_spent_total` | counter | — | Tokens spent on settled tasks since process start. |
| `ainet_task_tokens_spent_daily` | gauge | — | Tokens spent on tasks settled in the trailing 24h. |
| `ainet_tasks_settled_daily` | gauge | — | Tasks whose token spend was settled in the trailing 24h. |
| `ainet_task_cost_usd_daily` | gauge | — | US dollars spent on tasks settled in the trailing 24h. |
| `ainet_task_budget_exceeded_daily` | gauge | — | Tasks in the trailing 24h whose actual usage passed the budget. |

### Where the numbers come from

| Series | Source | Survives a restart? |
|---|---|---|
| `ainet_wallet_daily_quota_wallets`, `..._utilization_max` | `tasks` table, grouped per wallet over the trailing 24h | Yes |
| `ainet_wallet_daily_quota_rejections_total` | In-memory, incremented by the enforcement path | No — counters reset to `0` on restart |
| `ainet_task_tokens_spent_daily`, `ainet_tasks_settled_daily`, `ainet_task_cost_usd_daily`, `ainet_task_budget_exceeded_daily` | `task_costs` table, tasks settled in the trailing 24h | Yes |
| `ainet_task_tokens_spent_total` | In-memory, incremented when a task settles | No |
| `ainet_wallet_daily_quota_limit`, `ainet_task_token_budget` | Validated config, re-read on every scrape | Yes |

Anything durable is read from SQLite at scrape time so a restart does not put a
hole in the day's history. The two cumulative counters have no durable home —
a counter that resets is a visible blip, a missed rejection is not — so they are
accumulated in process instead.

---

## 2. Why wallets are bucketed, not labelled

The obvious implementation is one series per wallet:

```promql
# DO NOT DO THIS
ainet_wallet_tasks_used{walletPublicKey="GB3NK5X2…"} 37
```

It is the design this module deliberately rejects. Wallet addresses are
unbounded — every account that has ever submitted a task is a distinct label
value — so that layout produces unbounded label cardinality, which is the
documented way to take a Prometheus server down. It also publishes every
subscriber's Stellar account in a scrape endpoint that is routinely exposed on
the node's metrics port.

Instead, wallets are folded into the seven fixed bands above and reported as a
count. Consequences worth knowing:

- **Cardinality is constant.** Every labelled family emits exactly
  `len(QUOTA_BUCKETS)` = 7 series, whether the node serves ten wallets or ten
  million. Nothing grows over time.
- **All bands are always emitted**, including zero-valued ones. Prometheus
  treats a series that appears and disappears as a counter reset, so omitting
  idle bands would corrupt every rate calculation over them.
- **Top-N by address is not provided.** If you need per-wallet detail, the
  task list (`GET /api/tasks`) is the authorised, rate-limited surface for it.
- **Banding hides the identity of a heavy wallet by design.** `at-limit: 3` says
  three wallets are pinned; it deliberately does not say which.

---

## 3. PromQL recipes

```promql
# Wallets pinned at or over the daily ceiling right now
sum(ainet_wallet_daily_quota_wallets{bucket=~"at-limit|over-limit"})

# Wallets in the danger zone (>= 75% of the daily task quota)
sum(ainet_wallet_daily_quota_wallets{bucket=~"75-100%|at-limit|over-limit"})

# Share of active wallets at the ceiling
sum(ainet_wallet_daily_quota_wallets{bucket=~"at-limit|over-limit"})
  / ignoring(bucket) sum(ainet_wallet_daily_quota_wallets{bucket!="disabled"})

# Rejections per second, all bands
rate(ainet_wallet_daily_quota_rejections_total[5m])

# Rejections per second, split by band
sum by (bucket) (rate(ainet_wallet_daily_quota_rejections_total[5m]))

# Tokens spent per second across settled tasks
rate(ainet_task_tokens_spent_total[1h])

# Trailing-24h token spend against the configured per-task budget
# (>1 means the node settled more tokens today than one full task may use)
ainet_task_tokens_spent_daily / on() ainet_task_token_budget

# Average tokens per settled task today
ainet_task_tokens_spent_daily / on() ainet_tasks_settled_daily

# Tasks that overran their budget in the last 24h
ainet_task_budget_exceeded_daily

# Is the quota telemetry itself trustworthy?
ainet_wallet_daily_quota_source_errors
```

---

## 4. Alerting

Drop into `prometheus/rules/ainet-quota.yml` (requires the `prometheus` alert
manager; `rule_files` must include the directory).

```yaml
groups:
  - name: ainet-quota
    rules:
      # Quota is working but real wallets are hitting it. Not a fault on its
      # own — it is a capacity signal, and the threshold is deliberately loose.
      - alert: AiNetQuotaRejectionsRising
        expr: sum(rate(ainet_wallet_daily_quota_rejections_total[15m])) > 0.1
        for: 15m
        labels:
          severity: warning
        annotations:
          summary: Quota rejections sustained for 15 minutes
          description: >-
            ai-net is rejecting {{ $value | printf "%.2f" }} task submissions/s
            against DAILY_TASK_LIMIT_PER_WALLET. Clients are being turned away;
            raise the limit or investigate a runaway client.

      # A wallet is pinned at the ceiling right now.
      - alert: AiNetWalletsAtDailyQuotaLimit
        expr: sum(ainet_wallet_daily_quota_wallets{bucket=~"at-limit|over-limit"}) > 0
        for: 30m
        labels:
          severity: info
        annotations:
          summary: Wallets sitting at the daily task quota
          description: >-
            {{ $value }} wallet(s) have spent 100% of DAILY_TASK_LIMIT_PER_WALLET
            for 30 minutes.

      # Trailing-24h token spend is an order of magnitude past the per-task
      # budget: the node is spending far more than a single task may consume.
      - alert: AiNetDailyTokenSpendAnomalous
        expr: ainet_task_tokens_spent_daily / on() ainet_task_token_budget > 10
        for: 10m
        labels:
          severity: critical
        annotations:
          summary: Daily token spend is 10x the per-task budget
          description: >-
            ainet_task_tokens_spent_daily is more than 10x TASK_TOKEN_BUDGET over
            the trailing 24h. Check for a retry storm or an unbounded client.

      # Budget halts: tasks are being cut off mid-DAG.
      - alert: AiNetTaskBudgetExhausted
        expr: increase(ainet_task_budget_exceeded_daily[6h]) > 0
        labels:
          severity: warning
        annotations:
          summary: Tasks exhausted their token budget
          description: >-
            At least one task settled above TASK_TOKEN_BUDGET in the last 6 hours.

      # Telemetry blind spot — the gauges above are stale, not healthy.
      - alert: AiNetQuotaMetricsSourceUnavailable
        expr: ainet_wallet_daily_quota_source_errors == 1
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: Quota metrics could not read the task database
          description: >-
            ainet_wallet_daily_quota_source_errors is 1 — the trailing-24h quota
            gauges are stale. The enforcement path is unaffected.
```

---

## 5. Grafana panel snippet

Append to `backend/grafana/ai-net-dashboard.json`, or import the fragment into
an existing dashboard. Datasource `${DS_PROMETHEUS}` matches the shipped
dashboard.

```json
{
  "title": "Wallet Daily Quota",
  "type": "row",
  "gridPos": { "h": 1, "w": 24, "x": 0, "y": 20 },
  "collapsed": false,
  "panels": []
},
{
  "title": "Wallets At Daily Limit",
  "type": "stat",
  "datasource": "${DS_PROMETHEUS}",
  "gridPos": { "h": 4, "w": 6, "x": 0, "y": 21 },
  "targets": [
    {
      "expr": "sum(ainet_wallet_daily_quota_wallets{bucket=~\"at-limit|over-limit\"})",
      "legendFormat": "at limit",
      "refId": "A"
    }
  ],
  "fieldConfig": {
    "defaults": {
      "unit": "short",
      "thresholds": {
        "steps": [
          { "color": "green", "value": null },
          { "color": "orange", "value": 1 }
        ]
      }
    },
    "overrides": []
  }
},
{
  "title": "Quota Utilisation Distribution",
  "type": "timeseries",
  "datasource": "${DS_PROMETHEUS}",
  "gridPos": { "h": 8, "w": 12, "x": 6, "y": 21 },
  "targets": [
    {
      "expr": "ainet_wallet_daily_quota_wallets{bucket!=\"disabled\"}",
      "legendFormat": "{{bucket}}",
      "refId": "A"
    }
  ],
  "fieldConfig": {
    "defaults": { "unit": "short", "custom": { "stacking": { "mode": "normal" } } },
    "overrides": []
  }
},
{
  "title": "Quota Rejections / s",
  "type": "timeseries",
  "datasource": "${DS_PROMETHEUS}",
  "gridPos": { "h": 8, "w": 6, "x": 18, "y": 21 },
  "targets": [
    {
      "expr": "sum by (bucket) (rate(ainet_wallet_daily_quota_rejections_total[5m]))",
      "legendFormat": "{{bucket}}",
      "refId": "A"
    }
  ],
  "fieldConfig": { "defaults": { "unit": "reqps" }, "overrides": [] }
},
{
  "title": "Daily Token Spend (24h)",
  "type": "timeseries",
  "datasource": "${DS_PROMETHEUS}",
  "gridPos": { "h": 8, "w": 12, "x": 0, "y": 29 },
  "targets": [
    { "expr": "ainet_task_tokens_spent_daily", "legendFormat": "tokens", "refId": "A" },
    { "expr": "ainet_tasks_settled_daily", "legendFormat": "tasks settled", "refId": "B" },
    { "expr": "ainet_task_cost_usd_daily", "legendFormat": "usd", "refId": "C" },
    { "expr": "ainet_task_budget_exceeded_daily", "legendFormat": "over budget", "refId": "D" }
  ],
  "fieldConfig": { "defaults": { "unit": "short" }, "overrides": [] }
}
```

---

## 6. Verifying locally

```bash
# The families and their HELP/TYPE annotations
curl -s http://localhost:3001/api/metrics | grep -E 'ainet_wallet_daily_quota|ainet_task_token|ainet_task_budget_exceeded'

# Every band is present, zero-valued ones included
curl -s http://localhost:3001/api/metrics | grep ainet_wallet_daily_quota_wallets

# Confirm the exposition has no wallet-shaped label
curl -s http://localhost:3001/api/metrics | grep -c 'walletPublicKey='   # expected: 0

# Rejection counters are process-owned; reset to re-baseline (admin key required)
curl -s -X POST http://localhost:3001/api/metrics/reset -H "x-admin-key: $ADMIN_API_KEY"
```

Parsing the endpoint should always satisfy Prometheus' own format rules:

```bash
npx @prometheus-io/promtool check metrics <<< "$(curl -s http://localhost:3001/api/metrics)"
```

---

## 7. Troubleshooting

| Symptom | Cause | Action |
|---|---|---|
| `ainet_wallet_daily_quota_wallets` absent from the scrape | Collector failed to build its SQLite source | Check `ainet_wallet_daily_quota_source_errors` and the backend log line `task database unavailable for quota metrics` |
| Every wallet in `disabled` | `DAILY_TASK_LIMIT_PER_WALLET=0` | Intentional — the quota is off. Wallets are still counted, just not against a limit |
| `ainet_wallet_daily_quota_rejections_total` all zero but clients report `429`s | The rejections came from `rateLimitMiddleware` (per-minute), not the daily quota | Check `ainet_http_client_errors_total{...}` / the rate-limit route; the two limits are enforced independently |
| Counters dropped to zero after a deploy | They are process-owned by design | Use `rate()`/`increase()` with a window longer than your deploy interval, or `resets()` to correct for it |
| All gauges zero on a fresh node | No tasks settled and no submissions in the trailing 24h | Expected |