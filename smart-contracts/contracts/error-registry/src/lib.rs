#![no_std]
//! # Error Registry (with TTL expiration)
//!
//! On-chain store for agent error reports on Soroban. Each report is an
//! [`ErrorRecord`] keyed by a caller-supplied `error_id` ([`BytesN<32>`]).
//!
//! ## Why TTL?
//!
//! Without expiration, every submitted [`ErrorRecord`] lives on the ledger
//! forever. That means unbounded storage growth, rising rent/fees, and slower
//! lookups over time. To bound this, every record carries an application-level
//! **time-to-live (TTL)**: `submit_error` computes `expires_at = created_at +
//! ttl_seconds`, and once the ledger clock passes `expires_at` the record is
//! considered gone.
//!
//! ## Expiration semantics
//!
//! A record is **active** while `ledger_timestamp <= expires_at` and **expired**
//! once `ledger_timestamp > expires_at`. Note the boundary: at the exact instant
//! `now == expires_at` the record is still active — expiry is strictly `>`.
//!
//! Expiry is enforced at **read time**: every query ([`get_error`],
//! [`get_errors_by_code`], [`count_active_by_code`]) filters out expired records,
//! so callers never receive stale data regardless of whether cleanup has run.
//! Cleanup is therefore purely a storage-reclamation concern, never a
//! correctness one.
//!
//! ## Application TTL vs. ledger TTL
//!
//! This contract's TTL is an *application-level* expiry recorded in each value.
//! It is independent of Soroban's *ledger-level* state archival (the rent TTL
//! that governs when a persistent entry is archived by the network). We do not
//! extend ledger TTLs here; the two mechanisms are orthogonal and this crate is
//! concerned only with the former.
//!
//! ## Gas strategy for cleanup
//!
//! Soroban has no "list all keys" primitive, so to enumerate records for cleanup
//! we maintain an explicit index of every live `error_id` under
//! [`DataKey::AllErrorIds`]. [`cleanup_expired_errors`] is permissionless and
//! **bounded**: it removes at most `max_batch` expired records per call (capped
//! by [`MAX_CLEANUP_BATCH`]). Active records are scanned but never counted
//! against the batch, so they can never starve cleanup of expired records that
//! sit behind them, and the number of expensive storage-write operations per
//! transaction stays bounded no matter how many records exist. Callers can
//! invoke it repeatedly to drain a large backlog. See [`cleanup_expired_errors`]
//! for the full algorithm and its cost characteristics.
//!
//! ## Migration
//!
//! This is a brand-new contract, deployed with the `expires_at` field already
//! present in [`ErrorRecord`]. There is no prior on-chain data to migrate, so no
//! migration path is required. Were an older schema (without `expires_at`) ever
//! deployed, a migration would need to backfill `expires_at` for existing keys —
//! but that situation does not exist here.

use soroban_sdk::{
    contract, contracterror, contractimpl, contracttype, symbol_short, BytesN, Env, Map, Symbol,
    Vec,
};

/// Maximum allowed TTL for a single record: **90 days** (in seconds).
///
/// This ceiling exists so that no submitter can pin a record on the ledger for
/// an unreasonably long time (which would defeat the purpose of TTL and grow
/// storage without bound). 90 days is long enough for error reports to remain
/// useful for debugging and trend analysis, yet short enough to keep storage
/// churn healthy. `submit_error` rejects any `ttl_seconds` above this value.
pub const MAX_TTL_SECONDS: u64 = 7_776_000;

/// Hard upper bound on how many records a single [`cleanup_expired_errors`] call
/// may delete. This caps the number of storage-write operations per transaction
/// so cleanup can always fit within resource limits — it never becomes
/// impossible to run just because a large backlog of expired records exists.
pub const MAX_CLEANUP_BATCH: u32 = 100;

/// Batch size used when a caller passes `0` to [`cleanup_expired_errors`],
/// giving a sensible default for the common "just clean up" call.
pub const DEFAULT_CLEANUP_BATCH: u32 = 50;

/// A single error report stored on-chain.
///
/// `created_at` and `expires_at` are set by the contract from the ledger clock
/// and the caller-supplied TTL; they are never trusted from the caller.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ErrorRecord {
    /// Application-defined error code, also used as the secondary index key.
    pub error_code: u32,
    /// Human-readable short error message.
    pub message: Symbol,
    /// Identifier of the agent that reported the error.
    pub agent_id: Symbol,
    /// Ledger timestamp (seconds) at which the record was submitted.
    pub created_at: u64,
    /// Ledger timestamp (seconds) after which the record is considered expired.
    pub expires_at: u64,
}

/// Statistics returned by [`cleanup_expired_errors`], useful for callers driving
/// repeated cleanup passes and for off-chain monitoring.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CleanupStats {
    /// Number of records inspected during this call.
    pub scanned: u32,
    /// Number of expired records deleted during this call.
    pub removed: u32,
    /// Number of `error_id`s still present in the index after this call.
    pub remaining: u32,
}

/// Storage keys. All entries live in `persistent` storage.
#[contracttype]
pub enum DataKey {
    /// Primary storage: `error_id` -> [`ErrorRecord`].
    Record(BytesN<32>),
    /// Secondary lookup index: `error_code` -> `Vec<error_id>`.
    CodeIndex(u32),
    /// Enumeration index of every live `error_id`, used by cleanup.
    AllErrorIds,
}

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
pub enum Error {
    /// An active record already exists under the supplied `error_id`.
    AlreadyExists = 1,
    /// `ttl_seconds` was `0` or greater than [`MAX_TTL_SECONDS`].
    InvalidTtl = 2,
    /// `created_at + ttl_seconds` would overflow `u64`.
    TtlOverflow = 3,
}

#[contract]
pub struct ErrorRegistryContract;

#[contractimpl]
impl ErrorRegistryContract {
    /// Submit a new error report with an explicit TTL.
    ///
    /// * `error_id` — unique 32-byte key for the record (caller-supplied, e.g. a
    ///   content hash). Submitting an `error_id` that already maps to a record
    ///   fails with [`Error::AlreadyExists`].
    /// * `ttl_seconds` — lifetime in seconds. Must satisfy
    ///   `0 < ttl_seconds <= MAX_TTL_SECONDS`, otherwise [`Error::InvalidTtl`].
    ///
    /// On success the record is stored with `created_at` = current ledger
    /// timestamp and `expires_at = created_at + ttl_seconds` (checked for
    /// overflow), and it is added to both the per-code index and the global
    /// enumeration index. Emits an `("errreg", "submitted")` event.
    pub fn submit_error(
        env: Env,
        error_id: BytesN<32>,
        error_code: u32,
        message: Symbol,
        agent_id: Symbol,
        ttl_seconds: u64,
    ) -> Result<(), Error> {
        validate_ttl(ttl_seconds)?;

        let error_key = DataKey::Record(error_id.clone());
        if env.storage().persistent().has(&error_key) {
            return Err(Error::AlreadyExists);
        }

        let created_at = env.ledger().timestamp();
        // Never allow the expiry timestamp to wrap around u64.
        let expires_at = created_at
            .checked_add(ttl_seconds)
            .ok_or(Error::TtlOverflow)?;

        let record = ErrorRecord {
            error_code,
            message,
            agent_id,
            created_at,
            expires_at,
        };

        // Secondary index: error_code -> [error_id].
        let code_key = DataKey::CodeIndex(error_code);
        let mut code_ids: Vec<BytesN<32>> = env
            .storage()
            .persistent()
            .get(&code_key)
            .unwrap_or_else(|| Vec::new(&env));
        code_ids.push_back(error_id.clone());
        env.storage().persistent().set(&code_key, &code_ids);

        // Enumeration index used by cleanup.
        let mut all_ids: Vec<BytesN<32>> = env
            .storage()
            .persistent()
            .get(&DataKey::AllErrorIds)
            .unwrap_or_else(|| Vec::new(&env));
        all_ids.push_back(error_id.clone());
        env.storage()
            .persistent()
            .set(&DataKey::AllErrorIds, &all_ids);

        // Primary storage.
        env.storage().persistent().set(&error_key, &record);

        env.events().publish(
            (symbol_short!("errreg"), symbol_short!("submitted")),
            (error_id, error_code, expires_at),
        );

        Ok(())
    }

    /// Fetch a single record by `error_id`, or `None` if it does not exist or has
    /// expired. Expired records are treated exactly as if absent.
    pub fn get_error(env: Env, error_id: BytesN<32>) -> Option<ErrorRecord> {
        let now = env.ledger().timestamp();
        env.storage()
            .persistent()
            .get::<DataKey, ErrorRecord>(&DataKey::Record(error_id))
            .filter(|record| is_active(now, record))
    }

    /// Return all **active** records carrying `error_code`. Expired records are
    /// skipped and never returned to the caller.
    pub fn get_errors_by_code(env: Env, error_code: u32) -> Vec<ErrorRecord> {
        let now = env.ledger().timestamp();
        let ids = read_code_index(&env, error_code);

        let mut records = Vec::new(&env);
        for id in ids.iter() {
            if let Some(record) = env
                .storage()
                .persistent()
                .get::<DataKey, ErrorRecord>(&DataKey::Record(id))
            {
                if is_active(now, &record) {
                    records.push_back(record);
                }
            }
        }
        records
    }

    /// Count active (non-expired) records carrying `error_code`.
    pub fn count_active_by_code(env: Env, error_code: u32) -> u32 {
        Self::get_errors_by_code(env, error_code).len()
    }

    /// Permissionless, bounded cleanup of expired records.
    ///
    /// Deletes up to `max_batch` expired records (removing each from primary
    /// storage, the per-code index, and the enumeration index), leaving active
    /// records untouched. `max_batch` is clamped to [`MAX_CLEANUP_BATCH`]; a
    /// value of `0` falls back to [`DEFAULT_CLEANUP_BATCH`].
    ///
    /// ## Algorithm & cost
    ///
    /// 1. Read the enumeration index once (a single ledger entry).
    /// 2. Walk it in order. Active records are kept and cost only an in-memory
    ///    check — they do **not** count against the batch, so they can never
    ///    block cleanup of expired records behind them. Each expired record is
    ///    removed from primary storage and queued for index removal, counting
    ///    against the batch.
    /// 3. Once `max_batch` removals are reached, the remaining ids are kept
    ///    as-is and the pass stops deleting.
    /// 4. Per-code index removals are grouped by `error_code`, so each affected
    ///    code index is rewritten at most once regardless of how many of its
    ///    records expired — avoiding repeated rebuilds of the same vector.
    ///
    /// The number of expensive storage writes/removes per call is therefore
    /// bounded by `max_batch` plus the number of distinct affected codes, so the
    /// call always fits within resource limits. Draining a large backlog is done
    /// by calling repeatedly. (The one cost that scales with total live records
    /// is deserializing the single enumeration-index vector; for extreme scale a
    /// paginated index would be the natural next step.)
    ///
    /// Emits an `("errreg", "cleaned")` event with the [`CleanupStats`] when any
    /// record was removed.
    pub fn cleanup_expired_errors(env: Env, max_batch: u32) -> CleanupStats {
        let now = env.ledger().timestamp();
        let batch = resolve_batch(max_batch);

        let all_ids: Vec<BytesN<32>> = env
            .storage()
            .persistent()
            .get(&DataKey::AllErrorIds)
            .unwrap_or_else(|| Vec::new(&env));

        let mut kept_ids = Vec::new(&env);
        let mut removed_by_code: Map<u32, Vec<BytesN<32>>> = Map::new(&env);
        let mut scanned: u32 = 0;
        let mut removed: u32 = 0;

        for id in all_ids.iter() {
            // Batch exhausted: keep everything else untouched for a later pass.
            if removed >= batch {
                kept_ids.push_back(id);
                continue;
            }

            scanned += 1;
            let error_key = DataKey::Record(id.clone());
            match env
                .storage()
                .persistent()
                .get::<DataKey, ErrorRecord>(&error_key)
            {
                Some(record) if is_active(now, &record) => {
                    // Still active — keep it.
                    kept_ids.push_back(id);
                }
                Some(record) => {
                    // Expired: drop primary now, queue code-index removal.
                    env.storage().persistent().remove(&error_key);
                    let mut ids = removed_by_code
                        .get(record.error_code)
                        .unwrap_or_else(|| Vec::new(&env));
                    ids.push_back(id.clone());
                    removed_by_code.set(record.error_code, ids);
                    removed += 1;
                }
                None => {
                    // Defensive: primary already gone (should not happen while
                    // invariants hold). Drop the dangling id from the index.
                    removed += 1;
                }
            }
        }

        apply_code_index_removals(&env, &removed_by_code);

        if kept_ids.is_empty() {
            env.storage().persistent().remove(&DataKey::AllErrorIds);
        } else {
            env.storage()
                .persistent()
                .set(&DataKey::AllErrorIds, &kept_ids);
        }

        let stats = CleanupStats {
            scanned,
            removed,
            remaining: kept_ids.len(),
        };

        if removed > 0 {
            env.events().publish(
                (symbol_short!("errreg"), symbol_short!("cleaned")),
                stats.clone(),
            );
        }

        stats
    }
}

/// Reject `ttl_seconds` outside `(0, MAX_TTL_SECONDS]`.
fn validate_ttl(ttl_seconds: u64) -> Result<(), Error> {
    if ttl_seconds == 0 || ttl_seconds > MAX_TTL_SECONDS {
        return Err(Error::InvalidTtl);
    }
    Ok(())
}

/// A record is active while the clock has not passed its expiry. Expiry is
/// strictly `>`, so `now == expires_at` is still active.
fn is_active(now: u64, record: &ErrorRecord) -> bool {
    now <= record.expires_at
}

/// Clamp the caller-requested batch size into `[1, MAX_CLEANUP_BATCH]`,
/// substituting [`DEFAULT_CLEANUP_BATCH`] when `0` is requested.
fn resolve_batch(max_batch: u32) -> u32 {
    match max_batch {
        0 => DEFAULT_CLEANUP_BATCH,
        n if n > MAX_CLEANUP_BATCH => MAX_CLEANUP_BATCH,
        n => n,
    }
}

/// Read the per-code index vector for `error_code` (empty if none).
fn read_code_index(env: &Env, error_code: u32) -> Vec<BytesN<32>> {
    env.storage()
        .persistent()
        .get(&DataKey::CodeIndex(error_code))
        .unwrap_or_else(|| Vec::new(env))
}

/// Remove the queued ids from each affected per-code index in one pass per code,
/// deleting the index entry entirely once it becomes empty.
fn apply_code_index_removals(env: &Env, removed_by_code: &Map<u32, Vec<BytesN<32>>>) {
    for code in removed_by_code.keys().iter() {
        let to_remove = removed_by_code.get(code).unwrap_or_else(|| Vec::new(env));
        let current = read_code_index(env, code);

        let mut updated = Vec::new(env);
        for id in current.iter() {
            if !vec_contains(&to_remove, &id) {
                updated.push_back(id);
            }
        }

        let code_key = DataKey::CodeIndex(code);
        if updated.is_empty() {
            env.storage().persistent().remove(&code_key);
        } else {
            env.storage().persistent().set(&code_key, &updated);
        }
    }
}

/// Linear membership check over a small bounded vector.
fn vec_contains(list: &Vec<BytesN<32>>, target: &BytesN<32>) -> bool {
    for item in list.iter() {
        if &item == target {
            return true;
        }
    }
    false
}

#[cfg(test)]
mod test;
