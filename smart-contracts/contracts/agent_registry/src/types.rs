//! # Data Types for Agent Registry Multi-Sig Administration
//!
//! Defines the structs and enums used for multi-signature proposals, approvals,
//! and threshold configuration.

use crate::GasConfig;
use soroban_sdk::{contracttype, Address, Symbol, Vec};

/// On-chain representation of an agent's SLA terms.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AgentSla {
    /// Agent this SLA belongs to.
    pub agent_id: Symbol,
    /// Maximum allowed response time in milliseconds.
    pub max_response_time: u32,
    /// Minimum uptime percentage [0, 100].
    pub min_uptime: u32,
    /// Minimum quality score [0, 100].
    pub min_quality_score: u32,
    /// Timestamp when SLA was set.
    pub created_at: u64,
    /// Number of SLA checks performed.
    pub total_checks: u64,
    /// Number of SLA violations detected.
    pub violations: u64,
    /// Timestamp of last SLA check.
    pub last_check_at: u64,
}

/// SLA violation record.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SlaViolation {
    /// Agent that violated the SLA.
    pub agent_id: Symbol,
    /// Type of violation: 0 = response_time, 1 = uptime, 2 = quality.
    pub violation_type: u32,
    /// Timestamp when violation was detected.
    pub detected_at: u64,
    /// Whether penalty was applied.
    pub penalty_applied: bool,
}

/// On-chain analytics for an agent.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AgentAnalytics {
    /// Agent this analytics belongs to.
    pub agent_id: Symbol,
    /// Total tasks attempted.
    pub total_tasks: u64,
    /// Tasks completed successfully.
    pub successful_tasks: u64,
    /// Tasks that failed.
    pub failed_tasks: u64,
    /// Total earnings in stroops.
    pub total_earnings: i128,
    /// Running average response time in milliseconds.
    pub avg_response_time: u32,
    /// Last updated timestamp.
    pub last_updated: u64,
}

/// Daily snapshot of analytics (last 30 days).
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AnalyticsSnapshot {
    /// Date (ledger sequence) of the snapshot.
    pub snapshot_date: u64,
    /// Total tasks at time of snapshot.
    pub total_tasks: u64,
    /// Successful tasks at time of snapshot.
    pub successful_tasks: u64,
    /// Total earnings at time of snapshot.
    pub total_earnings: i128,
}

/// Leaderboard entry.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct LeaderboardEntry {
    /// Agent identifier.
    pub agent_id: Symbol,
    /// Metric value for ranking.
    pub metric_value: u64,
}

/// Admin actions that require multi-signature proposal and timelock execution.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum AdminAction {
    Pause,
    Unpause,
    SetAdmin(Address),
    SlashBond(Symbol, i128),
    SetMinBond(i128),
    SetGasConfig(GasConfig),
    SetMultisigConfig(Vec<Address>, u32, u64),
}

/// Multi-signature administration configuration parameters.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct MultisigConfig {
    /// List of authorized admin signer addresses.
    pub admins: Vec<Address>,
    /// Minimum required approval count (M of N).
    pub threshold: u32,
    /// Delay in seconds before an approved proposal can be executed.
    pub timelock_delay: u64,
}

/// On-chain representation of a multi-signature admin proposal.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Proposal {
    /// Unique proposal identifier.
    pub id: u64,
    /// Address of the admin who created the proposal.
    pub proposer: Address,
    /// Critical admin action to execute.
    pub action: AdminAction,
    /// Creation timestamp (seconds).
    pub created_at: u64,
    /// Earliest timestamp at which proposal can be executed (created_at + timelock_delay).
    pub eta: u64,
    /// Timestamp after which proposal can no longer be executed.
    pub expires_at: u64,
    /// Addresses of admins who have approved this proposal.
    pub approvals: Vec<Address>,
    /// Whether proposal has been executed.
    pub executed: bool,
    /// Whether proposal was cancelled by proposer.
    pub cancelled: bool,
}

/// Approval record for a proposal.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Approval {
    /// Proposal ID being approved.
    pub proposal_id: u64,
    /// Address of approving admin.
    pub approver: Address,
    /// Timestamp when approval was granted.
    pub timestamp: u64,
}

/// Query parameters for the agent discovery oracle.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct DiscoveryQuery {
    /// The specific capability required for matching agents.
    pub required_capability: Symbol,
    /// Maximum acceptable price in stroops (0 = no maximum price restriction).
    pub max_price: i128,
    /// Minimum acceptable reputation score [0, 100].
    pub min_reputation: u32,
    /// Maximum acceptable response time / latency in milliseconds (0 = no maximum latency restriction).
    pub max_latency: u32,
}

/// Individual ranked agent result returned by the discovery oracle.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct DiscoveryResult {
    /// Unique identifier of the matched agent.
    pub agent_id: Symbol,
    /// Composite match score scaled to basis points [0, 10000] (representing 0.00% to 100.00%).
    pub composite_score: u32,
    /// Service price in stroops.
    pub price_stroops: i128,
    /// Reputation score [0, 100].
    pub reputation: u32,
    /// Availability score percentage [0, 100].
    pub availability: u32,
    /// Response time / latency in milliseconds.
    pub response_time: u32,
}

/// Aggregate discovery statistics tracked across all oracle queries.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct DiscoveryStats {
    /// Total count of discovery queries executed.
    pub total_queries: u64,
    /// Total number of agent matches returned across all queries.
    pub total_matches_found: u64,
    /// Number of queries served from in-memory / temporary storage cache.
    pub cache_hits: u64,
}

// ─── Agent Subscriptions (issue #258) ────────────────────────────────────────

/// Lifecycle state of an agent-service subscription.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
#[repr(u32)]
pub enum SubscriptionStatus {
    /// Subscription is paid; it provides service while `now < end_time`.
    Active = 0,
    /// The client cancelled the subscription before its term ended.
    Cancelled = 1,
    /// The term elapsed without renewal.
    Expired = 2,
}

/// On-chain subscription letting a client pay an agent for recurring service.
///
/// Billing happens in fixed windows of `period_secs`. Creating the subscription
/// pays for the first window; `renew_subscription` (or opt-in auto-renewal)
/// pays for and appends another. The subscription is "active" while its
/// `status` is [`SubscriptionStatus::Active`] and `now < end_time`.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Subscription {
    /// The subscriber who funds the recurring payments.
    pub client: Address,
    /// The agent providing the subscribed service.
    pub agent_id: Symbol,
    /// Payment charged for each billing period, in stroops.
    pub payment_amount: i128,
    /// Length of one billing period, in ledger-seconds.
    pub period_secs: u64,
    /// Timestamp at which the subscription was first created.
    pub start_time: u64,
    /// Timestamp at which the currently-paid term ends.
    pub end_time: u64,
    /// Number of billing periods paid for over the subscription's lifetime.
    pub periods_paid: u32,
    /// Cumulative stroops paid into the subscription.
    pub total_paid: i128,
    /// Timestamp of the most recent processed payment.
    pub last_payment_at: u64,
    /// Whether the subscription auto-renews at term end (opt-in).
    pub auto_renew: bool,
    /// Current lifecycle state.
    pub status: SubscriptionStatus,
}
