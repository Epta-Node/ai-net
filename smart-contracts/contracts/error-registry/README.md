# error-registry

On-chain store for agent error reports on Soroban, with **TTL-based expiration**
so storage stays bounded instead of growing forever.

Implements [issue #113](https://github.com/Epta-Node/ai-net/issues/113).

## Why this crate exists

The `error-resolver` crate in this workspace is a plain (`std`) library that maps
error categories/codes to human-readable fix suggestions. It has no on-chain
storage. Issue #113 asks for a Soroban contract that *stores* submitted
`ErrorRecord`s on-chain and expires them via a TTL. Since a `#![no_std]`
soroban-sdk contract and the existing `std`/serde library cannot live in one
crate, that on-chain store is implemented here as a separate contract, leaving
`error-resolver` untouched.

## Data model

```rust
pub struct ErrorRecord {
    pub error_code: u32,   // application error code (also the secondary index key)
    pub message: Symbol,   // short human-readable message
    pub agent_id: Symbol,  // reporting agent
    pub created_at: u64,   // ledger timestamp at submission
    pub expires_at: u64,   // created_at + ttl_seconds
}
```

Storage (all `persistent`):

| Key                    | Value                | Purpose                          |
| ---------------------- | -------------------- | -------------------------------- |
| `Error(BytesN<32>)`    | `ErrorRecord`        | primary record, keyed by error_id |
| `CodeIndex(u32)`       | `Vec<BytesN<32>>`    | lookup by `error_code`           |
| `AllErrorIds`          | `Vec<BytesN<32>>`    | enumeration index for cleanup    |

## Interface

- `submit_error(error_id, error_code, message, agent_id, ttl_seconds)` — store a
  record. Sets `created_at` from the ledger clock and `expires_at = created_at +
  ttl_seconds`. Rejects `ttl_seconds` outside `(0, MAX_TTL_SECONDS]`
  (`InvalidTtl`), an `error_id` that already exists (`AlreadyExists`), and any
  expiry that would overflow `u64` (`TtlOverflow`).
- `get_error(error_id) -> Option<ErrorRecord>` — expired records read as `None`.
- `get_errors_by_code(error_code) -> Vec<ErrorRecord>` — active records only.
- `count_active_by_code(error_code) -> u32` — count of active records.
- `cleanup_expired_errors(max_batch) -> CleanupStats` — permissionless, bounded
  deletion of expired records.

## Expiration semantics

A record is **active** while `ledger_timestamp <= expires_at` and **expired**
once `ledger_timestamp > expires_at` (strict `>`; at `now == expires_at` it is
still active). Expiry is enforced at **read time**, so queries never return
stale data whether or not cleanup has run. Cleanup only reclaims storage; it is
never required for correctness.

This application-level TTL is independent of Soroban's ledger-level state
archival (rent TTL); this contract does not manage the latter.

## Cleanup & gas strategy

Soroban has no "enumerate all keys" primitive, so `AllErrorIds` tracks every live
id. `cleanup_expired_errors`:

- is **permissionless** (callable by anyone — incentivized or altruistic);
- removes at most `max_batch` expired records per call, clamped to
  `MAX_CLEANUP_BATCH` (100); `0` uses `DEFAULT_CLEANUP_BATCH` (50);
- lets **active records be scanned for free** — they never count against the
  batch, so they can't block cleanup of expired records behind them;
- groups per-code index removals so each affected `CodeIndex` is rewritten at
  most once per call;
- deletes emptied index entries entirely (no dangling keys).

Bounding deletions per call caps the expensive storage writes per transaction, so
cleanup always fits within resource limits. Drain a large backlog with repeated
calls. `MAX_TTL_SECONDS` is 90 days (`7_776_000`).

## Migration

New contract, deployed with `expires_at` already present — there is no prior
on-chain schema to migrate.

## Building & testing

```sh
# Unit tests must use the pinned toolchain: soroban-env-host 22.1.3's testutils
# path does not compile on current Rust stable (see repo commits f09c71c /
# d4e1c8a). CI wasm-builds the contract on stable and runs unit tests on 1.84.0.
cargo +1.84.0 test -p error-registry

# Real compile target:
cargo build -p error-registry --target wasm32-unknown-unknown --release
```
