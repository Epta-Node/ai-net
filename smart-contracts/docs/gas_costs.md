# Gas Costs — Batch Operations

Empirical CPU-instruction (CU) estimates for the Agent Registry Soroban contract.
Use `estimate_gas(operation, count)` on-chain for the same numbers (or updated
config via `set_gas_config`).

## Constants

| Constant | Value | Meaning |
|----------|------:|---------|
| `GAS_TX_OVERHEAD` | 40,000 | Shared base cost paid once per transaction |
| `GAS_REGISTER_AGENT` | 100,000 | Full cost of a single `register_agent` |
| `GAS_REGISTER_AGENT_MARGINAL` | 55,556 | Extra cost per additional agent in a batch |
| `GAS_RESOLVE_ERROR` | 50,000 | Full cost of resolving one error |
| `GAS_RESOLVE_ERROR_MARGINAL` | 30,000 | Extra cost per additional error in a batch |

## Formulae

```
estimate(register_agents, n) =
    GAS_REGISTER_AGENT + (n - 1) * GAS_REGISTER_AGENT_MARGINAL   // n ≥ 1

estimate(resolve_errors, n) =
    GAS_RESOLVE_ERROR + (n - 1) * GAS_RESOLVE_ERROR_MARGINAL     // n ≥ 1
```

## Per-batch-size table

### `register_agents`

| Batch size | Batched CU | Separate txs CU | Savings |
|-----------:|-----------:|----------------:|--------:|
| 1 | 100,000 | 100,000 | 0% |
| 2 | 155,556 | 200,000 | 22% |
| 5 | 322,224 | 500,000 | 36% |
| 10 | 600,004 | 1,000,000 | 40% |
| 20 | 1,155,564 | 2,000,000 | 42% |

### `resolve_errors`

| Batch size | Batched CU | Separate txs CU | Savings |
|-----------:|-----------:|----------------:|--------:|
| 1 | 50,000 | 50,000 | 0% |
| 2 | 80,000 | 100,000 | 20% |
| 5 | 170,000 | 250,000 | 32% |
| 10 | 320,000 | 500,000 | 36% |
| 20 | 620,000 | 1,000,000 | 38% |

These figures match the issue #120 gas analysis (~100k per single
`register_agent`, ~600k for a batched 10).

## Storage optimizations

1. **Atomic validate-then-write** — failed batches never touch persistent storage,
   so failed attempts do not pay write fees for partial state.
2. **Batched TTL extension** — after a successful batch, every written key is
   extended with `persistent().extend_ttl(threshold, extend_to)` in one loop
   (`TTL_THRESHOLD = 100_000`, `TTL_EXTEND_TO = 535_680`).
3. **Lookup TTL touch** — `lookup_agents` extends TTL for the capability index
   and every returned agent entry, keeping hot keys live without separate rent txs.

Soroban SDK 22 does not expose a public `multi_load`; reads remain per-key.
Batching still wins by amortizing host/tx overhead and consolidating writes + TTL.

## Caller budgeting

```rust
let budget = client.estimate_gas(&String::from_str(&env, "register_agents"), &10);
// Set resource fee / instructions based on `budget` before simulation.
```
