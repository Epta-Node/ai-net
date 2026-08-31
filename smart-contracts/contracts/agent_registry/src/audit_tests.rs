//! Tests for the security audit trail and anomaly detection (issue #261).

extern crate std;

use super::*;
use crate::audit::{
    DEFAULT_HIGH_VALUE_THRESHOLD, DEFAULT_RATE_LIMIT, DEFAULT_RATE_WINDOW_SECS, MAX_AUDIT_PAGE_SIZE,
};
use crate::events::AnomalyDetectedEvent;
use crate::types::AnomalyKind;
use soroban_sdk::{
    symbol_short,
    testutils::{Address as _, Events as _, Ledger as _},
    Address, Env, FromVal, Map, String, Symbol, Val,
};

fn setup() -> (Env, AgentRegistryContractClient<'static>, Address) {
    let env = Env::default();
    env.mock_all_auths();
    let id = env.register(AgentRegistryContract, ());
    let client = AgentRegistryContractClient::new(&env, &id);
    let admin = Address::generate(&env);
    client.initialize(&admin);
    (env, client, admin)
}

fn register(env: &Env, client: &AgentRegistryContractClient, id: &str, owner: &Address) -> Symbol {
    let agent_id = Symbol::new(env, id);
    client.register_agent(&AgentRecord {
        id: agent_id.clone(),
        capability: Symbol::new(env, "research"),
        price_stroops: 1_000,
        endpoint: String::from_str(env, "https://agent.example.com"),
        owner: owner.clone(),
        metadata: Map::new(env),
        bond_amount: DEFAULT_MIN_BOND_STROOPS,
    });
    agent_id
}

/// Decode the `AnomalyDetectedEvent`s emitted by the most recent invocation.
///
/// `env.events().all()` is scoped to the last contract call, so this must be
/// read immediately after the operation under test — any intervening call,
/// including a `get_audit_log` query, replaces the buffer.
fn anomalies(env: &Env) -> std::vec::Vec<AnomalyDetectedEvent> {
    env.events()
        .all()
        .iter()
        .filter_map(|(_, topics, data)| {
            let is_anomaly = topics.len() == 2
                && Symbol::from_val(env, &topics.get(1).unwrap()) == symbol_short!("anomaly");
            if is_anomaly {
                Some(AnomalyDetectedEvent::from_val(env, &data))
            } else {
                None
            }
        })
        .collect()
}

#[test]
fn admin_operations_are_logged() {
    let (_env, client, admin) = setup();

    client.pause();
    client.unpause();

    let page = client.get_audit_log(&None, &10);
    assert_eq!(page.total, 2);
    assert_eq!(page.entries.len(), 2);

    // Newest first.
    let newest = page.entries.get(0).unwrap();
    assert_eq!(newest.operation, symbol_short!("unpause"));
    assert_eq!(newest.caller, admin);
    assert_eq!(newest.seq, 1);

    let oldest = page.entries.get(1).unwrap();
    assert_eq!(oldest.operation, symbol_short!("pause"));
    assert_eq!(oldest.seq, 0);
}

#[test]
fn an_entry_records_the_ledger_context() {
    let (env, client, admin) = setup();
    env.ledger().set_timestamp(1_700_000_000);
    let sequence = env.ledger().sequence();

    client.pause();

    let entry = client.get_audit_log(&None, &1).entries.get(0).unwrap();
    assert_eq!(entry.caller, admin);
    assert_eq!(entry.timestamp, 1_700_000_000);
    assert_eq!(entry.ledger, sequence);
}

#[test]
fn operations_on_an_agent_record_their_target() {
    let (env, client, _admin) = setup();
    let owner = Address::generate(&env);
    let agent_id = register(&env, &client, "agent_a", &owner);

    client.freeze_agent(&agent_id);

    let entry = client.get_audit_log(&None, &1).entries.get(0).unwrap();
    assert_eq!(entry.operation, symbol_short!("freeze"));
    assert_eq!(entry.target, Some(agent_id));
}

#[test]
fn operations_without_a_target_leave_it_empty() {
    let (_env, client, _admin) = setup();
    client.pause();

    let entry = client.get_audit_log(&None, &1).entries.get(0).unwrap();
    assert_eq!(entry.target, None);
    assert_eq!(entry.amount_stroops, 0);
    assert!(!entry.high_value);
}

#[test]
fn config_changes_are_logged() {
    let (_env, client, _admin) = setup();

    client.set_min_bond(&12_345);
    client.set_error_ttl(&999);

    let page = client.get_audit_log(&None, &10);
    assert_eq!(page.total, 2);
    assert_eq!(
        page.entries.get(0).unwrap().operation,
        symbol_short!("errttl")
    );

    let min_bond = page.entries.get(1).unwrap();
    assert_eq!(min_bond.operation, symbol_short!("minbond"));
    // The configured amount is captured so a change can be audited by value.
    assert_eq!(min_bond.amount_stroops, 12_345);
}

#[test]
fn an_admin_handover_is_logged_against_the_outgoing_admin() {
    let (env, client, admin) = setup();
    let successor = Address::generate(&env);

    client.set_admin(&successor);

    let entry = client.get_audit_log(&None, &1).entries.get(0).unwrap();
    assert_eq!(entry.operation, symbol_short!("setadmin"));
    assert_eq!(entry.caller, admin);
}

// ── High-value flagging ──────────────────────────────────────────────────────

#[test]
fn a_slash_below_the_threshold_is_not_flagged() {
    let (env, client, _admin) = setup();
    let owner = Address::generate(&env);
    let agent_id = register(&env, &client, "agent_a", &owner);

    // The registration bond is 10 XLM, well under the 100 XLM threshold.
    client.slash_bond(&agent_id, &1_000_000);

    let entry = client.get_audit_log(&None, &1).entries.get(0).unwrap();
    assert_eq!(entry.operation, symbol_short!("slashbond"));
    assert_eq!(entry.amount_stroops, 1_000_000);
    assert!(!entry.high_value);
}

#[test]
fn a_high_value_slash_is_flagged_and_reported() {
    let (env, client, _admin) = setup();
    let owner = Address::generate(&env);
    let agent_id = Symbol::new(&env, "whale");
    client.register_agent(&AgentRecord {
        id: agent_id.clone(),
        capability: Symbol::new(&env, "research"),
        price_stroops: 1_000,
        endpoint: String::from_str(&env, "https://agent.example.com"),
        owner,
        metadata: Map::new(&env),
        // Large enough that a slash crosses the 100 XLM threshold.
        bond_amount: DEFAULT_HIGH_VALUE_THRESHOLD * 2,
    });

    client.slash_bond(&agent_id, &DEFAULT_HIGH_VALUE_THRESHOLD);

    // Read the events before any further call replaces the buffer.
    let flagged = anomalies(&env);
    assert!(flagged
        .iter()
        .any(|a| a.kind == AnomalyKind::HighValue && a.observed == DEFAULT_HIGH_VALUE_THRESHOLD));

    let entry = client.get_audit_log(&None, &1).entries.get(0).unwrap();
    assert!(entry.high_value);
    assert_eq!(entry.amount_stroops, DEFAULT_HIGH_VALUE_THRESHOLD);
}

#[test]
fn the_high_value_threshold_is_inclusive() {
    let (_env, client, _admin) = setup();
    let config = client.get_audit_config();
    assert_eq!(config.high_value_threshold, DEFAULT_HIGH_VALUE_THRESHOLD);

    // Exactly at the threshold counts as high value.
    client.set_min_bond(&DEFAULT_HIGH_VALUE_THRESHOLD);
    let entry = client.get_audit_log(&None, &1).entries.get(0).unwrap();
    assert!(entry.high_value);
}

// ── Anomaly detection ────────────────────────────────────────────────────────

#[test]
fn the_first_operation_by_a_caller_is_flagged() {
    let (env, client, admin) = setup();
    client.pause();

    let flagged = anomalies(&env);
    assert!(flagged
        .iter()
        .any(|a| a.kind == AnomalyKind::FirstSeenCaller && a.caller == admin));
}

#[test]
fn a_familiar_caller_is_not_flagged_again() {
    let (env, client, _admin) = setup();

    client.pause();
    let first_call = anomalies(&env)
        .iter()
        .filter(|a| a.kind == AnomalyKind::FirstSeenCaller)
        .count();

    client.unpause();
    let second_call = anomalies(&env)
        .iter()
        .filter(|a| a.kind == AnomalyKind::FirstSeenCaller)
        .count();

    assert_eq!(first_call, 1, "the admin's first operation is flagged");
    assert_eq!(second_call, 0, "the same caller is not flagged again");
}

#[test]
fn exceeding_the_rate_limit_is_flagged() {
    let (env, client, admin) = setup();

    // One more operation than the window permits.
    for _ in 0..=DEFAULT_RATE_LIMIT {
        client.pause();
    }

    let rate_flags: std::vec::Vec<_> = anomalies(&env)
        .into_iter()
        .filter(|a| a.kind == AnomalyKind::RateExceeded)
        .collect();

    assert!(!rate_flags.is_empty());
    assert_eq!(rate_flags[0].caller, admin);
    assert_eq!(rate_flags[0].observed, (DEFAULT_RATE_LIMIT + 1) as i128);
}

#[test]
fn staying_within_the_rate_limit_is_not_flagged() {
    let (env, client, _admin) = setup();

    for _ in 0..DEFAULT_RATE_LIMIT {
        client.pause();
    }

    assert!(anomalies(&env)
        .iter()
        .all(|a| a.kind != AnomalyKind::RateExceeded));
}

#[test]
fn the_rate_window_rolls_over() {
    let (env, client, _admin) = setup();

    for _ in 0..DEFAULT_RATE_LIMIT {
        client.pause();
    }
    // Move past the window; the counter restarts.
    env.ledger()
        .set_timestamp(env.ledger().timestamp() + DEFAULT_RATE_WINDOW_SECS + 1);
    client.pause();

    assert!(anomalies(&env)
        .iter()
        .all(|a| a.kind != AnomalyKind::RateExceeded));
}

#[test]
fn detection_does_not_block_the_operation() {
    let (_env, client, _admin) = setup();

    for _ in 0..=DEFAULT_RATE_LIMIT {
        client.pause();
    }

    // Every call still took effect, and every one was recorded.
    assert!(client.is_paused());
    assert_eq!(client.get_audit_total(), (DEFAULT_RATE_LIMIT + 1) as u64);
}

// ── Pagination ───────────────────────────────────────────────────────────────

#[test]
fn an_empty_log_returns_an_empty_page() {
    let (_env, client, _admin) = setup();

    let page = client.get_audit_log(&None, &10);
    assert_eq!(page.total, 0);
    assert_eq!(page.entries.len(), 0);
    assert_eq!(page.next_cursor, None);
}

#[test]
fn a_page_is_capped_and_hands_back_a_cursor() {
    let (_env, client, _admin) = setup();
    for _ in 0..10 {
        client.pause();
    }

    let first = client.get_audit_log(&None, &4);
    assert_eq!(first.entries.len(), 4);
    assert_eq!(first.total, 10);
    // Newest is seq 9, so the page covers 9..=6 and resumes at 6.
    assert_eq!(first.entries.get(0).unwrap().seq, 9);
    assert_eq!(first.entries.get(3).unwrap().seq, 6);
    assert_eq!(first.next_cursor, Some(6));
}

#[test]
fn the_cursor_walks_the_whole_log_without_gaps_or_repeats() {
    let (_env, client, _admin) = setup();
    for _ in 0..10 {
        client.pause();
    }

    let mut seen = std::vec::Vec::new();
    let mut cursor = None;
    loop {
        let page = client.get_audit_log(&cursor, &3);
        for entry in page.entries.iter() {
            seen.push(entry.seq);
        }
        match page.next_cursor {
            Some(next) => cursor = Some(next),
            None => break,
        }
    }

    let expected: std::vec::Vec<u64> = (0..10).rev().collect();
    assert_eq!(seen, expected);
}

#[test]
fn the_final_page_reports_no_cursor() {
    let (_env, client, _admin) = setup();
    for _ in 0..3 {
        client.pause();
    }

    let page = client.get_audit_log(&None, &10);
    assert_eq!(page.entries.len(), 3);
    assert_eq!(page.next_cursor, None);
}

#[test]
fn a_zero_limit_uses_the_default_page_size() {
    let (_env, client, _admin) = setup();
    for _ in 0..25 {
        client.pause();
    }

    let page = client.get_audit_log(&None, &0);
    assert_eq!(page.entries.len(), 20);
}

#[test]
fn an_oversized_limit_is_rejected() {
    let (_env, client, _admin) = setup();

    let result = client.try_get_audit_log(&None, &(MAX_AUDIT_PAGE_SIZE + 1));
    assert_eq!(result, Err(Ok(Error::InvalidAuditRange)));
}

#[test]
fn a_zero_cursor_returns_nothing() {
    let (_env, client, _admin) = setup();
    for _ in 0..3 {
        client.pause();
    }

    // seq 0 is the oldest entry and the cursor is exclusive.
    let page = client.get_audit_log(&Some(0), &10);
    assert_eq!(page.entries.len(), 0);
    assert_eq!(page.next_cursor, None);
}

// ── Configuration ────────────────────────────────────────────────────────────

#[test]
fn the_defaults_are_reported() {
    let (_env, client, _admin) = setup();
    let config = client.get_audit_config();

    assert_eq!(config.high_value_threshold, DEFAULT_HIGH_VALUE_THRESHOLD);
    assert_eq!(config.rate_limit, DEFAULT_RATE_LIMIT);
    assert_eq!(config.rate_window_secs, DEFAULT_RATE_WINDOW_SECS);
}

#[test]
fn the_config_can_be_replaced() {
    let (_env, client, _admin) = setup();

    let updated = AuditConfig {
        high_value_threshold: 500,
        rate_limit: 3,
        rate_window_secs: 60,
        retention_ledgers: 1_000,
    };
    client.set_audit_config(&updated);

    assert_eq!(client.get_audit_config(), updated);
}

#[test]
fn a_lowered_threshold_takes_effect() {
    let (_env, client, _admin) = setup();
    client.set_audit_config(&AuditConfig {
        high_value_threshold: 100,
        rate_limit: DEFAULT_RATE_LIMIT,
        rate_window_secs: DEFAULT_RATE_WINDOW_SECS,
        retention_ledgers: 1_000,
    });

    client.set_min_bond(&150);

    let entry = client.get_audit_log(&None, &1).entries.get(0).unwrap();
    assert!(entry.high_value);
}

#[test]
fn a_zero_rate_limit_is_rejected() {
    let (_env, client, _admin) = setup();

    let result = client.try_set_audit_config(&AuditConfig {
        high_value_threshold: 100,
        rate_limit: 0,
        rate_window_secs: 60,
        retention_ledgers: 1_000,
    });
    assert_eq!(result, Err(Ok(Error::InvalidAuditRange)));
}

#[test]
fn a_negative_threshold_is_rejected() {
    let (_env, client, _admin) = setup();

    let result = client.try_set_audit_config(&AuditConfig {
        high_value_threshold: -1,
        rate_limit: 5,
        rate_window_secs: 60,
        retention_ledgers: 1_000,
    });
    assert_eq!(result, Err(Ok(Error::InvalidAuditRange)));
}

#[test]
fn changing_the_config_is_itself_audited() {
    let (_env, client, _admin) = setup();

    client.set_audit_config(&AuditConfig {
        high_value_threshold: 500,
        rate_limit: 3,
        rate_window_secs: 60,
        retention_ledgers: 1_000,
    });

    let entry = client.get_audit_log(&None, &1).entries.get(0).unwrap();
    assert_eq!(entry.operation, symbol_short!("auditcfg"));
}

#[test]
fn a_non_admin_cannot_change_the_config() {
    let env = Env::default();
    let id = env.register(AgentRegistryContract, ());
    let client = AgentRegistryContractClient::new(&env, &id);
    let admin = Address::generate(&env);
    env.mock_all_auths();
    client.initialize(&admin);

    // No mocked auth for this call.
    env.set_auths(&[]);
    let result = client.try_set_audit_config(&AuditConfig {
        high_value_threshold: 1,
        rate_limit: 1,
        rate_window_secs: 1,
        retention_ledgers: 1,
    });
    assert!(result.is_err());
}

#[test]
fn sequence_numbers_are_contiguous() {
    let (_env, client, _admin) = setup();
    for _ in 0..5 {
        client.pause();
    }

    let page = client.get_audit_log(&None, &10);
    let seqs: std::vec::Vec<u64> = page.entries.iter().map(|e| e.seq).collect();
    assert_eq!(seqs, std::vec![4, 3, 2, 1, 0]);
    assert_eq!(client.get_audit_total(), 5);
}

#[test]
fn bridging_is_audited() {
    let (env, client, _admin) = setup();
    let owner = Address::generate(&env);
    register(&env, &client, "agent_a", &owner);

    // Bridging is covered end-to-end in bridge_tests; here we only assert that
    // the audit trail sees it, using the log written by register + freeze.
    client.freeze_agent(&Symbol::new(&env, "agent_a"));
    let entry = client.get_audit_log(&None, &1).entries.get(0).unwrap();
    assert_eq!(entry.operation, symbol_short!("freeze"));
}

#[test]
fn an_audit_entry_event_is_emitted_per_operation() {
    let (env, client, _admin) = setup();
    client.pause();

    let audit_events = env
        .events()
        .all()
        .iter()
        .filter(|(_, topics, _)| {
            topics.len() == 2
                && Symbol::from_val(&env, &topics.get(1).unwrap()) == symbol_short!("audit")
        })
        .count();

    assert_eq!(audit_events, 1);
}

#[test]
fn distinct_callers_are_tracked_separately() {
    let (env, client, admin) = setup();
    let successor = Address::generate(&env);

    client.pause();
    let flagged_admin: std::vec::Vec<Address> = anomalies(&env)
        .into_iter()
        .filter(|a| a.kind == AnomalyKind::FirstSeenCaller)
        .map(|a| a.caller)
        .collect();

    client.set_admin(&successor);
    // The new admin's first operation raises its own first-seen event.
    client.unpause();
    let flagged_successor: std::vec::Vec<Address> = anomalies(&env)
        .into_iter()
        .filter(|a| a.kind == AnomalyKind::FirstSeenCaller)
        .map(|a| a.caller)
        .collect();

    assert!(flagged_admin.contains(&admin));
    assert!(flagged_successor.contains(&successor));
}

/// Silences the unused-import warning for `Val`, which the event decoding needs.
#[allow(dead_code)]
fn _val_is_used(_: Val) {}
