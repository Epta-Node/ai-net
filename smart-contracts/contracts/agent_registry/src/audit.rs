//! # Security audit trail and anomaly detection (issue #261)
//!
//! Every privileged operation writes an immutable [`AuditLogEntry`] so a
//! post-incident investigation can reconstruct who did what, and when, without
//! replaying the whole ledger.
//!
//! Three checks run as an entry is written:
//!
//! - **High value** — the operation moved at least `high_value_threshold`
//!   stroops.
//! - **Rate** — the caller performed more than `rate_limit` operations inside a
//!   rolling `rate_window_secs` window.
//! - **First seen** — the caller has no prior audited activity.
//!
//! Each fires an [`AnomalyDetectedEvent`]. Detection is advisory: it never
//! blocks the operation, because a false positive that locks the admin out of
//! the registry during an incident is worse than a late alert. Enforcement, if
//! wanted, belongs behind the multi-sig timelock.
//!
//! Entries live in persistent storage under a TTL of roughly one year and are
//! never rewritten, so the log is append-only for as long as it is retained.

use soroban_sdk::{symbol_short, Address, Env, Symbol, Vec};

use crate::events::{AnomalyDetectedEvent, AuditLogEntryEvent};
use crate::types::{AnomalyKind, AuditConfig, AuditLogEntry, AuditPage, CallerActivity};
use crate::{DataKey, Error};

/// Operations at or above 100 XLM are flagged high-value (100 XLM in stroops).
pub const DEFAULT_HIGH_VALUE_THRESHOLD: i128 = 1_000_000_000;
/// Operations one caller may perform per window before the rate check fires.
pub const DEFAULT_RATE_LIMIT: u32 = 20;
/// Width of the rate-limiting window, in seconds (1 hour).
pub const DEFAULT_RATE_WINDOW_SECS: u64 = 3_600;
/// Audit retention in ledgers (~1 year at 5s per ledger).
pub const DEFAULT_AUDIT_RETENTION_LEDGERS: u32 = 6_312_000;

/// Largest page `get_audit_log` will return, so one query stays within a
/// single ledger's footprint budget.
pub const MAX_AUDIT_PAGE_SIZE: u32 = 50;
/// Page size used when a caller passes zero.
pub const DEFAULT_AUDIT_PAGE_SIZE: u32 = 20;

/// The configured thresholds, or the defaults when none have been set.
pub fn audit_config(env: &Env) -> AuditConfig {
    env.storage()
        .instance()
        .get(&DataKey::AuditConfig)
        .unwrap_or(AuditConfig {
            high_value_threshold: DEFAULT_HIGH_VALUE_THRESHOLD,
            rate_limit: DEFAULT_RATE_LIMIT,
            rate_window_secs: DEFAULT_RATE_WINDOW_SECS,
            retention_ledgers: DEFAULT_AUDIT_RETENTION_LEDGERS,
        })
}

/// Total entries ever written, which is also the next sequence number.
pub fn audit_total(env: &Env) -> u64 {
    env.storage()
        .instance()
        .get(&DataKey::AuditSequence)
        .unwrap_or(0u64)
}

/// Update the caller's rolling counter and report whether it exceeds the limit.
///
/// Returns the observed count and whether this is the caller's first audited
/// operation.
fn bump_caller_activity(env: &Env, caller: &Address, config: &AuditConfig) -> (u32, bool) {
    let now = env.ledger().timestamp();
    let key = DataKey::CallerActivity(caller.clone());

    let existing: Option<CallerActivity> = env.storage().temporary().get(&key);
    let first_seen = existing.is_none();

    let activity = match existing {
        // Window still open: count this operation against it.
        Some(prev) if now.saturating_sub(prev.window_start) < config.rate_window_secs => {
            CallerActivity {
                count: prev.count.saturating_add(1),
                window_start: prev.window_start,
                last_seen: now,
            }
        }
        // No history, or the previous window has elapsed: start a fresh one.
        _ => CallerActivity {
            count: 1,
            window_start: now,
            last_seen: now,
        },
    };

    let count = activity.count;
    env.storage().temporary().set(&key, &activity);
    // Keep the counter alive for at least one full window so a burst spanning
    // the boundary is still visible.
    let window_ledgers = (config.rate_window_secs / 5).max(1) as u32;
    env.storage()
        .temporary()
        .extend_ttl(&key, window_ledgers, window_ledgers.saturating_mul(2));

    (count, first_seen)
}

/// Write one audit entry and run the anomaly checks over it.
///
/// `amount_stroops` is zero for operations that move no value. Returns the
/// sequence number written.
pub fn record(
    env: &Env,
    caller: &Address,
    operation: Symbol,
    target: Option<Symbol>,
    amount_stroops: i128,
) -> u64 {
    let config = audit_config(env);
    let seq = audit_total(env);
    let high_value = amount_stroops >= config.high_value_threshold && amount_stroops > 0;

    let entry = AuditLogEntry {
        seq,
        caller: caller.clone(),
        operation: operation.clone(),
        target,
        amount_stroops,
        high_value,
        timestamp: env.ledger().timestamp(),
        ledger: env.ledger().sequence(),
    };

    let key = DataKey::AuditEntry(seq);
    env.storage().persistent().set(&key, &entry);
    env.storage()
        .persistent()
        .extend_ttl(&key, config.retention_ledgers, config.retention_ledgers);

    env.storage()
        .instance()
        .set(&DataKey::AuditSequence, &(seq + 1));

    env.events().publish(
        (symbol_short!("registry"), symbol_short!("audit")),
        AuditLogEntryEvent {
            seq,
            caller: caller.clone(),
            operation,
            amount_stroops,
            high_value,
        },
    );

    let (count, first_seen) = bump_caller_activity(env, caller, &config);

    if high_value {
        emit_anomaly(env, seq, caller, AnomalyKind::HighValue, amount_stroops);
    }
    if count > config.rate_limit {
        emit_anomaly(env, seq, caller, AnomalyKind::RateExceeded, count as i128);
    }
    if first_seen {
        emit_anomaly(env, seq, caller, AnomalyKind::FirstSeenCaller, 0);
    }

    seq
}

fn emit_anomaly(env: &Env, seq: u64, caller: &Address, kind: AnomalyKind, observed: i128) {
    env.events().publish(
        (symbol_short!("registry"), symbol_short!("anomaly")),
        AnomalyDetectedEvent {
            seq,
            caller: caller.clone(),
            kind,
            observed,
        },
    );
}

/// Read a page of audit entries, newest first.
///
/// `before_seq` is exclusive: pass `None` to start at the newest entry, or the
/// `next_cursor` from the previous page to continue. Entries whose TTL has
/// lapsed are skipped rather than ending the page, so an expired record in the
/// middle of the range does not truncate the history behind it.
pub fn page(env: &Env, before_seq: Option<u64>, limit: u32) -> Result<AuditPage, Error> {
    if limit > MAX_AUDIT_PAGE_SIZE {
        return Err(Error::InvalidAuditRange);
    }

    let total = audit_total(env);
    let size = if limit == 0 {
        DEFAULT_AUDIT_PAGE_SIZE
    } else {
        limit
    };

    let mut entries = Vec::new(env);
    if total == 0 {
        return Ok(AuditPage {
            entries,
            next_cursor: None,
            total,
        });
    }

    // `before_seq` is exclusive, so start one below it. `total` is one past the
    // newest sequence, so the newest entry is `total - 1`.
    let start = match before_seq {
        Some(0) => {
            return Ok(AuditPage {
                entries,
                next_cursor: None,
                total,
            })
        }
        Some(cursor) => cursor.min(total).saturating_sub(1),
        None => total - 1,
    };

    let mut seq = start;
    let mut next_cursor = None;

    loop {
        if entries.len() >= size {
            // More history remains below this point.
            next_cursor = Some(seq + 1);
            break;
        }
        if let Some(entry) = env
            .storage()
            .persistent()
            .get::<DataKey, AuditLogEntry>(&DataKey::AuditEntry(seq))
        {
            entries.push_back(entry);
        }
        if seq == 0 {
            break;
        }
        seq -= 1;
    }

    Ok(AuditPage {
        entries,
        next_cursor,
        total,
    })
}

/// Replace the audit thresholds. Admin-only; validated by the caller.
pub fn set_config(env: &Env, config: AuditConfig) -> Result<(), Error> {
    if config.rate_limit == 0 || config.rate_window_secs == 0 || config.retention_ledgers == 0 {
        return Err(Error::InvalidAuditRange);
    }
    if config.high_value_threshold < 0 {
        return Err(Error::InvalidAuditRange);
    }
    env.storage().instance().set(&DataKey::AuditConfig, &config);
    Ok(())
}
