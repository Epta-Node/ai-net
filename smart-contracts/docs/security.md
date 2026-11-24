# Security Audit Trail and Anomaly Detection

`agent_registry` records every privileged operation in an append-only on-chain
audit log, so a post-incident investigation can reconstruct who did what, and
when, without replaying the whole ledger.

## What is recorded

Every admin entry point writes one `AuditLogEntry`:

| Field | Meaning |
|-------|---------|
| `seq` | Monotonic sequence number; also the storage key |
| `caller` | Address that authorised the operation |
| `operation` | Short operation name, e.g. `pause`, `slashbond` |
| `target` | Agent the operation acted on, when it targets one |
| `amount_stroops` | Value moved; `0` for operations that move none |
| `high_value` | Whether the amount met the high-value threshold |
| `timestamp` | Ledger timestamp, in seconds |
| `ledger` | Ledger sequence the operation was included in |

Audited operations:

| Operation | Symbol | Amount recorded |
|-----------|--------|-----------------|
| `pause` | `pause` | — |
| `unpause` | `unpause` | — |
| `freeze_agent` | `freeze` | — |
| `unfreeze_agent` | `unfreeze` | — |
| `set_admin` | `setadmin` | — |
| `set_min_bond` | `minbond` | new minimum |
| `set_error_ttl` | `errttl` | — |
| `set_gas_config` | `gascfg` | — |
| `set_storage_config` | `storecfg` | — |
| `set_audit_config` | `auditcfg` | — |
| `slash_bond` | `slashbond` | penalty actually applied |
| `bridge_identity` | `bridge` | — |
| `revoke_bridge_proof` | `unbridge` | — |

`set_admin` is recorded against the **outgoing** admin, who authorised the
handover.

Entries are written once and never rewritten, so the log is append-only for as
long as it is retained (default ~1 year, `DEFAULT_AUDIT_RETENTION_LEDGERS`).

## Reading the log

```rust
// Newest first. `None` starts at the newest entry.
let page = client.get_audit_log(&None, &20);

// Continue with the cursor from the previous page.
let next = client.get_audit_log(&page.next_cursor, &20);
```

`limit` of `0` uses the default page size (20); anything above
`MAX_AUDIT_PAGE_SIZE` (50) is rejected with `InvalidAuditRange`. The cap keeps a
single query inside one ledger's footprint budget.

`page.total` is the number of entries ever written, **including any whose TTL
has lapsed**, so it is a true operation counter rather than a count of what is
currently readable. Entries that have expired are skipped rather than ending the
page, so an expired record in the middle of the range does not truncate the
history behind it.

`get_audit_total()` returns the same counter on its own.

## Anomaly detection

Three checks run as each entry is written. Each emits an
`AnomalyDetectedEvent`.

| Kind | Fires when | `observed` |
|------|-----------|------------|
| `HighValue` | `amount_stroops >= high_value_threshold` | the amount |
| `RateExceeded` | caller exceeded `rate_limit` operations within `rate_window_secs` | the count |
| `FirstSeenCaller` | the caller has no prior audited activity | `0` |

**Detection is advisory: it never blocks the operation.** A false positive that
locks the admin out of the registry during an incident is worse than a late
alert. If you want enforcement, put it behind the multi-sig timelock
(`set_multisig_config`), which is designed for it.

The rate counter lives in temporary storage on a rolling window. When the window
elapses the counter restarts, so a caller operating steadily below the limit is
never flagged.

`FirstSeenCaller` is a coarse signal by design: it fires whenever a caller has
no counter, which includes a legitimate admin handover as well as a genuinely
unexpected caller. Treat it as "look at this", not as an alarm.

## Configuration

```rust
client.set_audit_config(&AuditConfig {
    high_value_threshold: 1_000_000_000, // 100 XLM in stroops
    rate_limit: 20,
    rate_window_secs: 3_600,
    retention_ledgers: 6_312_000,        // ~1 year at 5s/ledger
});
```

Admin only, and itself audited. Defaults:

| Setting | Default | Notes |
|---------|---------|-------|
| `high_value_threshold` | 1 000 000 000 stroops | 100 XLM; the check is inclusive |
| `rate_limit` | 20 | operations per window before flagging |
| `rate_window_secs` | 3 600 | one hour |
| `retention_ledgers` | 6 312 000 | roughly one year |

A zero `rate_limit`, `rate_window_secs` or `retention_ledgers`, or a negative
`high_value_threshold`, is rejected with `InvalidAuditRange`.

## Events

| Event | Topic | Emitted when |
|-------|-------|--------------|
| `AuditLogEntryEvent` | `("registry", "audit")` | Every audited operation |
| `AnomalyDetectedEvent` | `("registry", "anomaly")` | Each anomaly check that fires |

An indexer that only wants alerts can subscribe to `("registry", "anomaly")`
alone; one building a forensic timeline should follow `("registry", "audit")`.

## Note for integrators

Admin operations now emit **more than one event**: the operation's own event,
plus an audit event, plus any anomaly events. Any consumer asserting an exact
event count after an admin call needs updating; the operation's own event is
still emitted first.

## Operational guidance

- **Alert on `RateExceeded`.** A compromised admin key usually shows up as a
  burst of operations, not a single one.
- **Alert on `HighValue` with a threshold you would actually investigate.** The
  100 XLM default is a starting point, not a recommendation.
- **Do not rely on the log alone for long-horizon forensics.** Entries expire
  with their TTL; mirror `("registry", "audit")` events off-chain if you need
  history beyond the retention window.

## Storage budgets (AGENTS.md §1)

Every write path owns a bounded set of ledger entries. A refactor that quietly
adds a per-agent, per-bid or per-task entry is a rent regression that no
functional test catches, so the hot paths are pinned by assertions in the
contract test suites.

The shared helper lives in [`test-utils/src/storage.rs`](../test-utils/src/storage.rs)
and is available to tests as `contract_test_utils::assert_storage_within`. It
snapshots the contract's instance, persistent and temporary entries before and
after one operation and fails when the **growth** exceeds a documented ceiling.
Bytes are the XDR-encoded key + value payload; ledger-entry metadata and rent
are excluded, so the number is stable across machines.

### Enforced ceilings

| Operation | Entries | Bytes | What is written |
|---|---:|---:|---|
| `agent_registry::register_agent` | 6 | 900 | agent record, capability index, bond record, ordinal index, two instance counters |
| `agent_registry::register_agents(2)` | 9 | 1,600 | per-agent record/bond/ordinal, shared capability index, counters |
| `agent_bidding::create_auction` | 3 | 900 | auction record, bidder list, phase index |
| `agent_bidding::submit_bid` | 1 | 500 | sealed bid record + bidder list append |
| `agent_bidding::reveal_bid` | 0 | 32 | overwrite of the existing bid record |
| `agent_marketplace::list_service` | 2 | 500 | listing record + capability index |
| `agent_marketplace::book_agent` | 2 | 600 | booking record + booking index |
| `agent_marketplace::complete_booking` | 1 | 200 | booking status update |
| `task_store::store_task_metadata` | 5 | 1,100 | task record, history, version counter, creator index |
| `task_store::update_task_status` | 0 | 200 | in-place record + history append |
| `task_store::create_task` | 5 | 1,100 | lifecycle record, history, creator index |
| `dispute_resolution::file_dispute` | 3 | 1,200 | dispute record, juror snapshot, task index |
| `dispute_resolution::submit_evidence` | 1 | 300 | evidence record + dispute counter |
| all read paths under test | 0 | 0 | reads must be storage-neutral |

Ceilings are maxima, not targets. Tighten one when an implementation gets
smaller. Raise one only when the new entry is justified here and in the PR
description; the assertion message points back to this section.

### Running and updating

```bash
cd smart-contracts
cargo test -p agent_registry -p agent-bidding -p agent-marketplace \
  -p task-store -p dispute-resolution --test storage_budget
```

The assertions are part of the normal `cargo test` run, so CI fails on an
unexplained ceiling breach without any extra workflow step.
