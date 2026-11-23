# error-resolver

Maps Soroban failures to human-readable recovery suggestions.

The crate has two parts, selected by Cargo features (both on by default):

| Feature | What it provides |
|---|---|
| `std` | Off-chain `ErrorResolver`, backed by [`src/errors.toml`](src/errors.toml): looks up a fix suggestion for a Tier 1 host error `(category, error_code)` or for a contract-specific `#[contracterror]` code `(contract, code)`. |
| `contract` | On-chain per-agent error ledger (`src/agent_errors.rs`), callable cross-contract by `agent-registry`. |

## Usage

```rust
use error_resolver::{lookup_suggestion, ErrorCategory, ErrorCode, ErrorResolver};

// Tier 1 host error
let hint = lookup_suggestion(ErrorCategory::Storage, ErrorCode::MissingValue);

// Contract-specific error code
let resolver = ErrorResolver::new();
let hint = resolver.resolve_contract_error("error-registry", 7);
```

Unknown contract codes resolve to `UNKNOWN_CONTRACT_ERROR_FALLBACK` rather than
failing, so callers always get a usable message.

## Error code reference

The tables below are generated from [`src/errors.toml`](src/errors.toml), the
single source of truth for the resolver. `tests/readme_sync.rs` fails if an
entry is added to `errors.toml` without a matching row here.

### Tier 1 host errors (`[[errors]]`)

| Category | Error code | Description | Recovery |
|---|---|---|---|
| `budget` | `ExceededLimit` | The transaction exceeded its allocated CPU-instruction or memory budget. | Optimize loops and avoid excessive memory allocation, or submit with a higher resource limit fee. |
| `storage` | `MissingValue` | The requested ledger entry (persistent data, contract instance or Wasm bytecode) does not exist or has been archived. | Verify the entry was created; if it was archived, submit a `RestoreFootprintOp` transaction to restore it. |
| `storage` | `ExceededLimit` | The transaction accessed a ledger entry missing from its read/write footprint, or exceeded an entry size limit. | Run `simulateTransaction` first to obtain the correct footprint and declare every accessed entry. |
| `storage` | `ExistingValue` | The ledger entry or storage key already exists and cannot be created again. | Use an update/put operation instead of a create, or check the key-initialization logic. |
| `auth` | `InvalidAction` | An authorization check failed. | Ensure every required address has signed the authorization payload, arguments are deterministic, and nonces are neither expired nor reused. |
| `contract` | `InvalidAction` | The contract rejected an operation that is invalid in its current state. | Check state constraints and invariants, and make sure the preconditions for this state transition are met. |
| `contract` | `InvalidInput` | The arguments passed to the contract function are invalid or out of bounds. | Verify argument types match the function signature and satisfy its validation constraints. |

### Contract errors (`[[contract_errors]]`)

#### `error-registry`

| Code | Name | Description | Recovery |
|---:|---|---|---|
| 1 | `AlreadyExists` | An error record with this `error_id` is already stored. | Generate a fresh `error_id` (e.g. a hash including a nonce) instead of re-submitting the same one. |
| 2 | `InvalidTtl` | `ttl_seconds` is zero or larger than `MAX_TTL_SECONDS` (90 days). | Clamp the TTL to `1..=MAX_TTL_SECONDS` before calling `submit_error`. |
| 3 | `TtlOverflow` | `created_at + ttl_seconds` overflowed `u64`. | Use a TTL within `MAX_TTL_SECONDS` and verify the ledger timestamp is sane. |
| 4 | `ContractPaused` | The registry is paused and rejects mutations. | Wait for the admin to call `unpause`, or contact the operator. |
| 5 | `AlreadyInitialized` | `initialize` has already been called on this instance. | Do not re-initialize; manage the contract through the existing admin. |
| 6 | `NotInitialized` | The contract has no admin yet. | Call `initialize(admin)` once after deployment before using admin entrypoints. |
| 7 | `Unauthorized` | The caller is not authorized for this admin action. | Sign the transaction with the configured admin address. |
| 8 | `UpgradeFailed` | The Wasm upgrade could not be applied. | Verify the new Wasm hash has been uploaded to the network and that pre-upgrade validation passes. |
| 9 | `RollbackNotAvailable` | No recent upgrade exists to roll back, or the rollback window (34,560 ledgers) has elapsed. | Perform a forward upgrade instead. |
| 10 | `MaxCapacityReached` | The per-code index for this `error_code` is full (`MAX_CODE_INDEX_SIZE`). | Run `cleanup_expired_errors` to reclaim expired records, then retry. |

Any code not listed above resolves to the fallback:

> Unknown contract error code. Inspect the contract's `#[contracterror]` enum
> for this code and add a matching `[[contract_errors]]` entry to `errors.toml`.

## Adding an error code

1. Add an `[[errors]]` or `[[contract_errors]]` entry to `src/errors.toml`.
   Contract entries need `contract`, `code`, `name` and `fix_suggestion`.
2. Add the matching row to the tables above.
3. Run `cargo test -p error-resolver`. `registry_consistency` checks the TOML
   against the `error-registry` enum, and `readme_sync` checks this README
   against the TOML.
