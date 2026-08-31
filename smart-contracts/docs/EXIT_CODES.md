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

### Adding New Common Codes

1. Add the variant to `CommonExitCode` in `shared_exit_codes.rs`.
2. Assign the next available code in `1..=15` range.
3. Update the table above.
4. Add a test in `shared_exit_codes::tests`.

**Never renumber an existing code** once deployed.
