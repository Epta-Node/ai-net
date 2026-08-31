//! # Data Types for Agent Registry Multi-Sig Administration
//!
//! Defines the structs and enums used for multi-signature proposals, approvals,
//! and threshold configuration.

use crate::GasConfig;
use soroban_sdk::{contracttype, Address, BytesN, Symbol, Vec};

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

// ─── Cross-chain identity bridging (issue #259) ──────────────────────────────

/// Chains an agent identity can be bridged to.
///
/// The variant determines how an off-chain verifier reconstructs the signed
/// message, so adding a chain is a deliberate, versioned change rather than a
/// free-form string.
#[contracttype]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum TargetChain {
    /// Any EVM-compatible chain, identified by its EIP-155 chain id.
    Evm(u32),
    /// Solana; the cluster is carried out of band.
    Solana,
}

/// A time-limited attestation that a registered agent controls a Stellar key.
///
/// The registry stores the proof so a verifier can check it on-chain, and the
/// signature travels with it so a contract on the target chain can verify the
/// agent's authorisation independently, without trusting this registry.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct BridgeProof {
    /// Agent the proof attests to.
    pub agent_id: Symbol,
    /// Raw ed25519 public key the agent signs with.
    pub stellar_pubkey: BytesN<32>,
    /// Chain the proof is scoped to. A proof for one chain is not valid on another.
    pub target_chain: TargetChain,
    /// Ledger timestamp when the proof was issued, in seconds.
    pub issued_at: u64,
    /// Ledger timestamp after which the proof is no longer valid, in seconds.
    pub expiry: u64,
    /// SHA-256 over the canonical encoding of the fields above.
    pub digest: BytesN<32>,
    /// Agent's ed25519 signature over `digest`.
    pub signature: BytesN<64>,
}

// ─── Security audit trail (issue #261) ───────────────────────────────────────

/// Why an operation was flagged as anomalous.
#[contracttype]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum AnomalyKind {
    /// Caller exceeded the permitted operation count within the rate window.
    RateExceeded,
    /// Operation moved more value than the high-value threshold.
    HighValue,
    /// Caller has no prior audited activity in the retained history.
    FirstSeenCaller,
}

/// One immutable record of a privileged operation.
///
/// Written for every admin entry point so a post-incident investigation can
/// reconstruct who did what, and when, without replaying the whole ledger.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AuditLogEntry {
    /// Monotonic sequence number; also the storage key.
    pub seq: u64,
    /// Address that authorised the operation.
    pub caller: Address,
    /// Short operation name, e.g. `pause`, `slash_bond`.
    pub operation: Symbol,
    /// Agent the operation acted on, when it targets one.
    pub target: Option<Symbol>,
    /// Value moved, in stroops. Zero for operations that move none.
    pub amount_stroops: i128,
    /// True when `amount_stroops` met or exceeded the high-value threshold.
    pub high_value: bool,
    /// Ledger timestamp, in seconds.
    pub timestamp: u64,
    /// Ledger sequence the operation was included in.
    pub ledger: u32,
}

/// A page of audit entries, newest-first.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AuditPage {
    /// Entries on this page.
    pub entries: Vec<AuditLogEntry>,
    /// Sequence to pass as `before_seq` for the next page, or `None` at the end.
    pub next_cursor: Option<u64>,
    /// Total entries ever written, including any already expired.
    pub total: u64,
}

/// Thresholds governing audit logging and anomaly detection.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AuditConfig {
    /// Value at or above which an operation is flagged high-value, in stroops.
    pub high_value_threshold: i128,
    /// Operations one caller may perform within `rate_window_secs` before
    /// being flagged.
    pub rate_limit: u32,
    /// Width of the rate-limiting window, in seconds.
    pub rate_window_secs: u64,
    /// Retention for audit entries, in ledgers.
    pub retention_ledgers: u32,
}

/// Rolling per-caller counter backing the rate check.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CallerActivity {
    /// Operations counted so far in the current window.
    pub count: u32,
    /// Timestamp the current window opened, in seconds.
    pub window_start: u64,
    /// Timestamp of this caller's most recent audited operation.
    pub last_seen: u64,
}
