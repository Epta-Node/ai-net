# Soroban gas estimation guide

The contracts expose `estimate_gas` as a conservative CPU-instruction
estimate, not a transaction fee quote. Estimates are calibrated against the
Soroban host cost tracker and the testnet farm in
`smart-contracts/tests/testnet/contract-farm.test.ts`.

> [!IMPORTANT]
> Instructions and memory are only two of the Soroban resource dimensions.
> The fee charged on-chain is computed from the complete resource usage
> (CPU, memory, ledger storage, and transaction overhead) using the network's
> current fee schedule. The numbers in this guide are benchmarks for
> comparison, **not stroop quotes**.

## How Soroban gas works

Every contract invocation is metered by the Soroban host. Metering happens
inside the host when the contract runs, and again during resource fee
calculation when the transaction is submitted. The main dimensions are:

| Resource | What consumes it | Typical driver in ai-net |
|---|---|---|
| CPU instructions | Wasm execution and host functions | scoring loops, hashing, XDR encoding |
| Memory | Wasm linear memory and host allocations | `Vec`/`Map` size, large `String` terms |
| Ledger I/O | reads, writes, and TTL extensions | number of storage keys touched |
| Transaction overhead | signature verification, calldata size | number of signers, argument size |

Two fee components matter operationally:

- **Inclusion fee** — based on transaction resource declarations, paid even
  if the invocation fails.
- **Resource fee** — based on actual metered resources, refunded in part when
  the declared limits exceed what was used.

Storage is a separate, recurring cost: persistent entries require rent via
TTL extensions. A cheap write can therefore become expensive over time if its
TTL is extended frequently. The contracts keep collections bounded (for
example, `MAX_BIDDERS` in agent bidding) precisely so CPU, memory, and rent
stay predictable.

`estimate_gas` reports CPU instructions only. `estimate(operation, params)`
uses the same bounded model with a parameter map. Unknown operations and
zero-count requests return `0`, so callers cannot mistake an unsupported
operation for a valid quote.

## Benchmark baseline: actual recorded numbers

Source of truth: [`smart-contracts/gas-baselines.json`](../smart-contracts/gas-baselines.json).
Each entry records the measured instruction count and memory bytes for one
entrypoint, with a `tolerance_percent` of 5 for regression checks.

| Contract operation | Instructions | Memory (bytes) |
|---|---:|---:|
| `agent_bidding::create_auction` | 305,046 | 52,717 |
| `agent_bidding::reveal_bid` | 210,537 | 39,150 |
| `agent_bidding::submit_bid` | 389,419 | 64,895 |
| `agent_marketplace::book_agent` | 290,199 | 48,871 |
| `agent_marketplace::complete_booking` | 303,526 | 50,444 |
| `agent_marketplace::list_service` | 77,535 | 10,817 |
| `agent_registry::lookup_agents` | 133,597 | 15,191 |
| `agent_registry::register_agent` | 211,801 | 33,988 |
| `agent_registry::register_agents_2` | 489,669 | 88,179 |
| `task_store::create_task` | 207,739 | 34,748 |
| `task_store::get_task_metadata` | 54,438 | 6,276 |
| `task_store::store_task_metadata` | 188,050 | 27,130 |
| `task_store::update_task_status` | 187,971 | 26,283 |

Reading the table:

- `get_task_metadata` (54,438 instructions) is the cheapest read benchmark;
  it performs a single persistent lookup.
- `list_service` (77,535) is the cheapest write benchmark in this set.
- `register_agents_2` (489,669) is the most expensive recorded operation;
  batch registration writes multiple entries in one invocation.
- `submit_bid` (389,419) combines storage writes, a SHA-256 commitment check,
  and a token transfer, which explains why it exceeds `reveal_bid` (210,537).

These figures were captured on testnet with the fixture described in the
calibration workflow below. Ledger protocol upgrades and configuration
changes will shift them; treat them as a baseline to compare against, not a
guarantee.

## Estimating gas before deployment

### 1. Estimate in the local test harness

The contract unit tests run inside the Soroban test host, which meters
resources using the same host logic the network applies. Use this to get a
fast estimate before deploying anything:

```bash
cd smart-contracts
cargo test -p agent-bidding -p agent-marketplace -p dispute-resolution
```

Gas-focused tests assert against `gas-baselines.json` (see
`smart-contracts/test-utils/src/gas.rs`) with the configured tolerance, so an
out-of-band estimate fails locally instead of on-chain.

### 2. Estimate against a deployed contract

For a deployed contract, call the view entrypoints with `stellar contract invoke`:

```bash
stellar contract invoke \
  --id "$CONTRACT_ID" \
  --network testnet \
  -- estimate_gas --operation submit_bid --count 1

stellar contract invoke \
  --id "$CONTRACT_ID" \
  --network testnet \
  -- estimate --operation submit_bid \
  --params '{"task_id":"my_task"}'
```

Use `--count` for operations whose cost scales with a bounded collection
(for example, the number of bids being revealed). If the operation is not in
the supported set, the result is `0` — do not submit with that estimate.

### 3. Simulate the real transaction

On testnet, use transaction simulation to get the host's authoritative
resource usage before signing and submitting:

```bash
stellar contract invoke ... --network testnet --send=no
```

Simulation reports the actual CPU, memory, and storage resources for the
exact call and ledger state. Use those numbers to set resource limits with a
safety margin (see the 20% acceptance band below), then submit. Do not cache a
stroop fee derived from simulation: both the fee schedule and ledger state
can change between simulation and inclusion.

### 4. Update the baseline

When a representative measurement changes by more than the configured
tolerance:

1. Run the testnet farm with a funded testnet account and record diagnostics
   emitted by `recordGas`.
2. Update the operation constants in each contract's `src/gas.rs` so the
   on-chain estimate tracks reality.
3. Update the recorded values in `smart-contracts/gas-baselines.json`, keeping
   the measurement context (testnet, benchmark commit) in the PR description.
4. Keep a 20% acceptance band in gas tests. This gives operators headroom for
   ledger-version variance while still catching stale estimates.

## Optimising gas usage

Ordering by impact:

1. **Minimise storage writes.** Each write touches a ledger entry and may
   trigger a TTL extension. `register_agents_2` (489,669 instructions, 88,179
   bytes) is the most expensive recorded operation because it writes multiple
   entries; prefer a single entry per logical record where that does not
   sacrifice auditability.
2. **Keep collections bounded.** Loops over bidders, reveals, and agent lists
   scale linearly. Respect `MAX_BIDDERS` and paginate reads with cursors
   (`get_bidders_paginated`) rather than materialising an entire list.
3. **Shrink calldata and event payloads.** Large `String` terms cost memory and
   transaction bytes. The 512-byte `MAX_TERMS_LEN` cap in agent bidding exists
   for this reason. Emit minimal event payloads; indexers can join on IDs.
4. **Avoid redundant XDR encoding and hashing.** Compute commitment pre-images
   once and reuse them. `submit_bid` (389,419 instructions) is more expensive
   than `reveal_bid` (210,537) partly because of the commitment work and token
   transfer.
5. **Batch rent extensions.** `extend_ttl_batch` in agent bidding extends only
   keys that exist, in one pass, instead of bumping rent ad hoc.
6. **Prefer view calls for reads.** `get_task_metadata` costs 54,438
   instructions versus 188,050 for `store_task_metadata`; keep read paths free
   of mutation and call them via simulation when only data is needed.

## Operational limits

- Never treat `estimate_gas` as a fee quote. Convert to a fee at submission
  time using the network's active Soroban resource fee schedule.
- Never submit with an estimate of `0`; it means the operation is unsupported.
- Re-run calibration after a protocol upgrade, a dependency bump that changes
  generated Wasm, or any change to storage layout or loop bounds.
- Track the full resource envelope in monitoring, not just instructions; a
  storage-heavy transaction can be expensive even with a modest instruction
  count.
