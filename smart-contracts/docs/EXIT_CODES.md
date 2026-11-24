# Cross-Contract Error Propagation

## Standardized Exit Codes

All ai-net Soroban contracts use a shared exit-code registry for cross-contract
error propagation. This lets callers interpret failures without coupling to a
specific contract's internal enum.

### Code Ranges

| Range | Purpose |
|-------|---------|
| `1..=15` | **Reserved common codes** — shared across all contracts |
| `100..` | **Contract-specific codes** — local to each contract |

### Exit-Code-to-Meaning Table

| Code | Name | Meaning |
|------|------|---------|
| 1 | `NotFound` | The requested entity does not exist |
| 2 | `Unauthorized` | Caller lacks the required authorization signature |
| 3 | `AlreadyExists` | Entity already registered / duplicate creation |
| 4 | `ContractPaused` | Contract is paused; all mutations rejected |
| 5 | `AgentFrozen` | Agent is frozen; operations on it are rejected |
| 6 | `NotAdmin` | Caller is not an admin of the contract |
| 7 | `InvalidRecord` | Input record fails validation |
| 8 | `DuplicateInBatch` | Batch contains duplicate entity IDs |
| 9 | `StorageLimitReached` | Global storage capacity has been reached |
| 10 | `InvalidArgument` | A required argument is missing or malformed |
| 11 | `InternalError` | Unexpected internal error (contract bug) |
| 12 | `Expired` | The entity has expired or its TTL has elapsed |
| 13 | `InsufficientFunds` | Caller or escrow lacks sufficient balance |
| 14 | `RateLimited` | Operation rejected due to rate limiting |
| 15 | `ContractNotLinked` | Cross-contract call target is not configured |

### Using the Error Mapper

The registry contract exposes a public `error_mapper` function:

```rust
// On-chain: call from another contract
let common_code = registry.error_mapper(raw_error_code);

// Off-chain: interpret the result
match common_code {
    Some(CommonExitCode::NotFound) => { /* entity not found */ }
    Some(CommonExitCode::Unauthorized) => { /* auth failure */ }
    Some(CommonExitCode::AlreadyExists) => { /* duplicate */ }
    None => { /* contract-specific code, inspect locally */ }
}
```

### Local Error Mapping vs Shared Exit Codes

Contracts retain local error enum definitions (`1..=100`) to maintain compact WASM binary size and zero-dependency compilation per contract crate. When performing cross-contract invocations (such as calling `verify_agent_eligible`), calling contracts map the raw error status codes (`1` = `NotFound`, `5` = `AgentFrozen`, `10` = `InsufficientBond`, `36` = `AgentDeregistered`) back into local typed contract errors. `shared_exit_codes.rs` defines the authoritative code taxonomy for off-chain callers and indexers mapping errors across all ai-net Soroban contracts.

### Adding New Common Codes

1. Add the variant to `CommonExitCode` in `shared_exit_codes.rs`.
2. Assign the next available code in `1..=15` range.
3. Update the table above.
4. Add a test in `shared_exit_codes::tests`.

**Never renumber an existing code** once deployed.

## Contract-Specific Codes: `dispute_resolution`

Local `Error` enum (`contracts/dispute_resolution/src/errors.rs`). Codes are
append-only; new variants are added at the end.

| Code | Name | Meaning |
|------|------|---------|
| 1 | `NotFound` | Dispute or referenced record does not exist |
| 2 | `Unauthorized` | Caller is not permitted to perform the action |
| 3 | `AlreadyExists` | A dispute already exists for the task |
| 4 | `ContractPaused` | Contract is paused |
| 5 | `DisputeAlreadyResolved` | Dispute already carries a final ruling |
| 6 | `DisputeExpired` | Evidence/voting window for the action has closed |
| 7 | `AlreadyVoted` | Voter already cast a vote this round |
| 8 | `NotEligibleVoter` | Voter is not in the pool or lacks reputation |
| 9 | `InvalidPhase` | Action not valid in the dispute's current phase |
| 10 | `NoVotersAvailable` | No voter pool configured |
| 11 | `InvalidReason` | Dispute reason empty or too long |
| 12 | `InvalidReputation` | Reputation outside `0..=100` |
| 13 | `InvalidAmount` | Negative bond or escrow amount |
| 14 | `InvalidVoterPool` | Voter pool empty, oversized or duplicated |
| 15 | `EvidenceLimitReached` | Per-dispute evidence cap reached |
| 16 | `AppealExpired` | Appeal window has closed |
| 17 | `AppealAlreadyFiled` | Dispute was already appealed once |
| 18 | `VotingStillOpen` | `resolve` called before `voting_deadline` |
| 19 | `NotResolved` | `appeal_dispute` called on a dispute with no ruling yet |
