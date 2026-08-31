# Gas Costs

Empirical CPU-instruction (CU) estimates for ai-net Soroban contracts. The
Agent Registry exposes these estimates on-chain through `estimate_gas`.

## Agent Registry Constants

| Constant | Value | Meaning |
|----------|------:|---------|
| `GAS_TX_OVERHEAD` | 40,000 | Shared base cost paid once per transaction |
| `GAS_REGISTER_AGENT` | 82,000 | Full cost of a single `register_agent` |
| `GAS_REGISTER_AGENT_MARGINAL` | 42,500 | Extra cost per additional agent in a batch |
| `GAS_RESOLVE_ERROR` | 42,000 | Full cost of resolving one error |
| `GAS_RESOLVE_ERROR_MARGINAL` | 22,000 | Extra cost per additional error in a batch |
| `GAS_CLEANUP_ERROR` | 16,000 | Full cost of checking/removing one expired error |
| `GAS_CLEANUP_ERROR_MARGINAL` | 8,000 | Extra cost per additional cleanup item |
| `GAS_SLASH_BOND` | 52,000 | Full cost of a single `slash_bond` |
| `GAS_DEREGISTER_WITH_BOND` | 68,000 | Full cost of `deregister_agent` with bond return |

## Formulae

```rust
estimate(register_agents, n) =
    GAS_REGISTER_AGENT + (n - 1) * GAS_REGISTER_AGENT_MARGINAL

estimate(resolve_errors, n) =
    GAS_RESOLVE_ERROR + (n - 1) * GAS_RESOLVE_ERROR_MARGINAL

estimate(cleanup_expired_errors, n) =
    GAS_CLEANUP_ERROR + (n - 1) * GAS_CLEANUP_ERROR_MARGINAL
```

All formulae return `0` when `n == 0`.

## Benchmark Tables

### `register_agents`

| Batch size | Previous CU | Optimized CU | Reduction vs previous | Separate txs CU | Savings vs separate |
|-----------:|------------:|-------------:|----------------------:|----------------:|--------------------:|
| 1 | 100,000 | 82,000 | 18.0% | 82,000 | 0.0% |
| 2 | 155,556 | 124,500 | 20.0% | 164,000 | 24.1% |
| 5 | 322,224 | 252,000 | 21.8% | 410,000 | 38.5% |
| 10 | 600,004 | 464,500 | 22.6% | 820,000 | 43.4% |
| 20 | 1,155,564 | 889,500 | 23.0% | 1,640,000 | 45.8% |

### `resolve_errors`

| Batch size | Previous CU | Optimized CU | Reduction vs previous | Separate txs CU | Savings vs separate |
|-----------:|------------:|-------------:|----------------------:|----------------:|--------------------:|
| 1 | 50,000 | 42,000 | 16.0% | 42,000 | 0.0% |
| 2 | 80,000 | 64,000 | 20.0% | 84,000 | 23.8% |
| 5 | 170,000 | 130,000 | 23.5% | 210,000 | 38.1% |
| 10 | 320,000 | 240,000 | 25.0% | 420,000 | 42.9% |
| 20 | 620,000 | 460,000 | 25.8% | 840,000 | 45.2% |

### `cleanup_expired_errors`

| Batch size | Previous CU | Optimized CU | Reduction vs previous |
|-----------:|------------:|-------------:|----------------------:|
| 1 | 20,000 | 16,000 | 20.0% |
| 2 | 30,000 | 24,000 | 20.0% |
| 5 | 60,000 | 48,000 | 20.0% |
| 10 | 110,000 | 88,000 | 20.0% |
| 20 | 210,000 | 168,000 | 20.0% |

## Average Reduction

The CI benchmark guard compares the optimized estimates against the previous
baseline for:

| Operation | Previous CU | Optimized CU | Reduction |
|----------|------------:|-------------:|----------:|
| `register_agent(1)` | 100,000 | 82,000 | 18.0% |
| `register_agents(10)` | 600,004 | 464,500 | 22.6% |
| `resolve_error(1)` | 50,000 | 42,000 | 16.0% |
| `resolve_errors(10)` | 320,000 | 240,000 | 25.0% |
| `cleanup_expired_errors(10)` | 110,000 | 88,000 | 20.0% |

Average reduction: **20.3%**, exceeding the 15% acceptance threshold.

## Storage Optimizations

1. Single `register_agent` now reads `TotalAgents` once and reuses the loaded
   capability index for both limit checking and commit.
2. `register_agents` caches per-capability counts during validation and writes
   each touched capability index once during commit.
3. `resolve_errors` reuses validation-loaded `ErrorEntry` records during commit
   instead of loading each error twice.
4. TTL extension uses a direct helper after known writes, avoiding redundant
   `has()` reads before every rent bump.
5. Lookup/list paths extend TTL directly when a previous `get()` already proved
   the key exists.

## Contract Snapshot

| Contract | Hot path profiled | Current status |
|----------|-------------------|----------------|
| `agent_registry` | Registration, batch registration, error resolution, cleanup, bond updates | Optimized and CI-guarded |
| `agent_bidding` | Auction create, bid submit/reveal, award/refund | Bounded maps/vectors; no unbounded storage iteration in this change |
| `agent_marketplace` | Listing and purchase flows | Singleton config and per-listing records; no gas model exported yet |
| `dispute_resolution` | Dispute create/vote/resolve | Bounded case records; no hot-path regression in this change |
| `error-registry` | Error submit, indexed lookup, bounded cleanup | Already uses cursor/batch cleanup; no extra reads introduced |
| `error-resolver` | Error count record/clear/query | Minimal per-agent counters; no extra reads introduced |
| `task_store` | Task create/update/query | Per-task records; no unbounded collection mutation in this change |
| `upgrade-manager` | Migration planning/execution | Existing estimator retained; no data migration in this change |

The unit tests in `contracts/agent_registry/src/test.rs` assert the benchmark
tables and the >=15% average reduction guard.
