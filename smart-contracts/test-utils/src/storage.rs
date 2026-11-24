//! Storage-footprint assertions for contract tests.
//!
//! Soroban charges rent per ledger entry, so an entrypoint's storage growth is
//! part of its public cost contract. These helpers snapshot the entries a
//! contract owns before and after an operation and fail when the *growth*
//! exceeds a ceiling the test documents next to the call.
//!
//! The snapshot counts every entry in the contract's instance, persistent and
//! temporary storage. Bytes are the XDR-encoded size of each key plus value,
//! i.e. the payload the network stores; ledger-entry metadata and rent are
//! excluded. That makes the number stable across machines and Rust versions.

use soroban_sdk::{
    testutils::storage::{Instance as _, Persistent as _, Temporary as _},
    xdr::ToXdr,
    Address, Env, Map, Val,
};

/// Number of storage entries and their XDR-encoded payload size.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub struct StorageFootprint {
    pub entries: u32,
    pub bytes: u64,
}

impl StorageFootprint {
    /// Growth from `self` (before) to `after`.
    ///
    /// Signed because an operation may legitimately remove entries (a cleanup
    /// or an overwrite that drops a field); negative growth is never a budget
    /// violation.
    pub fn delta_to(self, after: StorageFootprint) -> StorageDelta {
        StorageDelta {
            entries: i64::from(after.entries) - i64::from(self.entries),
            bytes: after.bytes as i64 - self.bytes as i64,
        }
    }
}

/// Signed change in entries/bytes across one operation.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub struct StorageDelta {
    pub entries: i64,
    pub bytes: i64,
}

/// Maximum growth allowed for a single operation.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct StorageBudget {
    pub max_entries: u32,
    pub max_bytes: u64,
}

impl StorageBudget {
    /// A ceiling for an operation that is expected to add entries.
    pub const fn new(max_entries: u32, max_bytes: u64) -> Self {
        Self {
            max_entries,
            max_bytes,
        }
    }

    /// A ceiling for a read-only operation: storage must not grow at all.
    pub const fn read_only() -> Self {
        Self::new(0, 0)
    }
}

fn map_footprint(map: &Map<Val, Val>, env: &Env) -> StorageFootprint {
    let mut bytes = 0_u64;
    for (key, value) in map.iter() {
        // `ToXdr` serialises the value in its ScVal form, which is what the
        // ledger stores. Keys and values are counted separately.
        bytes += u64::from(key.to_xdr(env).len());
        bytes += u64::from(value.to_xdr(env).len());
    }
    StorageFootprint {
        entries: map.len(),
        bytes,
    }
}

fn measure_current_contract(env: &Env) -> StorageFootprint {
    let instance = map_footprint(&env.storage().instance().all(), env);
    let persistent = map_footprint(&env.storage().persistent().all(), env);
    let temporary = map_footprint(&env.storage().temporary().all(), env);

    StorageFootprint {
        entries: instance.entries + persistent.entries + temporary.entries,
        bytes: instance.bytes + persistent.bytes + temporary.bytes,
    }
}

/// Measure the storage owned by `contract`.
///
/// Callers must pass the contract address: `env.storage()` is scoped to the
/// contract currently executing, so the helper enters the contract context
/// first.
pub fn measure_storage(env: &Env, contract: &Address) -> StorageFootprint {
    env.as_contract(contract, || measure_current_contract(env))
}

/// Records the footprint before an operation and asserts its growth when
/// [`StorageAudit::finish`] is called.
#[derive(Debug)]
pub struct StorageAudit {
    label: &'static str,
    before: StorageFootprint,
    budget: StorageBudget,
}

impl StorageAudit {
    /// Snapshot `contract`'s storage before the operation.
    pub fn begin(
        env: &Env,
        contract: &Address,
        label: &'static str,
        budget: StorageBudget,
    ) -> Self {
        let before = measure_storage(env, contract);
        std::println!(
            "[storage] {label}: before entries={} bytes={}",
            before.entries,
            before.bytes
        );
        Self {
            label,
            before,
            budget,
        }
    }

    /// Snapshot again, assert the growth against the budget, and return it.
    #[must_use = "finish performs the assertion; dropping the audit skips it"]
    pub fn finish(self, env: &Env, contract: &Address) -> StorageDelta {
        let after = measure_storage(env, contract);
        let delta = self.before.delta_to(after);
        std::println!(
            "[storage] {}: after entries={} bytes={} | delta entries={:+} bytes={:+} | budget entries<={} bytes<={}",
            self.label,
            after.entries,
            after.bytes,
            delta.entries,
            delta.bytes,
            self.budget.max_entries,
            self.budget.max_bytes
        );

        assert!(
            delta.entries <= i64::from(self.budget.max_entries),
            "storage budget exceeded for `{}`: {} new entries, ceiling is {}.\n\
             If this growth is intentional, raise the ceiling in the test and \
             document the new entry in `smart-contracts/docs/security.md`.",
            self.label,
            delta.entries,
            self.budget.max_entries,
        );
        assert!(
            delta.bytes <= self.budget.max_bytes as i64,
            "storage byte budget exceeded for `{}`: {:+} bytes, ceiling is {}.\n\
             If this growth is intentional, raise the ceiling in the test and \
             document the new entry in `smart-contracts/docs/security.md`.",
            self.label,
            delta.bytes,
            self.budget.max_bytes,
        );

        delta
    }
}

/// Run `op` and assert that it grows `contract`'s storage by no more than
/// `budget`.
///
/// This is the one-line form used by the hot-path tests:
///
/// ```ignore
/// assert_storage_within(&env, &client.address, "registry::register_agent",
///     StorageBudget::new(3, 1_500), || client.register_agent(&record));
/// ```
pub fn assert_storage_within<T, F>(
    env: &Env,
    contract: &Address,
    label: &'static str,
    budget: StorageBudget,
    op: F,
) -> T
where
    F: FnOnce() -> T,
{
    let audit = StorageAudit::begin(env, contract, label, budget);
    let result = op();
    let _ = audit.finish(env, contract);
    result
}
