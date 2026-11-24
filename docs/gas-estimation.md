# Contract gas estimates

The contracts expose `estimate_gas` as a conservative CPU-instruction
estimate, not a transaction fee quote. Estimates are calibrated against the
Soroban host cost tracker and the testnet farm in
`smart-contracts/tests/testnet/contract-farm.test.ts`.

## Calibration workflow

1. Run the contract unit tests with the cost tracker enabled:
   `cargo test -p agent-bidding -p agent-marketplace -p dispute-resolution`.
2. Run the testnet farm with a funded testnet account and record the
   diagnostics emitted by `recordGas`.
3. Update the operation constants in each contract's `src/gas.rs` only when a
   representative measurement changes by more than 10%.
4. Keep a 20% acceptance band in gas tests. This gives operators headroom for
   ledger-version variance while still catching stale estimates.

The model is deliberately bounded by the contract's collection limits. For
example, bidding and reveal estimates scale with the number of bids, while a
single listing or purchase uses the fixed one-item cost. Unknown operations
and zero-count requests return `0` so callers cannot mistake an unsupported
operation for a valid quote.

The returned instruction estimate must still be converted to a fee using the
network's current Soroban resource fee schedule at submission time; callers
should not cache a stroop fee derived from this value.
