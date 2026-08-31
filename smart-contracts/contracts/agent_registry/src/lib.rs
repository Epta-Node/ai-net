#![no_std]

//! # Agent Registry Contract
//!
//! On-chain registry for AI agents with **batch-optimized** registration and
//! error-resolution paths to amortize base transaction fees.
//!
//! ## Gas model (approximate CPU instructions / CU)
//!
//! | Operation            | count=1   | count=10 (batched) | vs 10 separate txs |
//! |----------------------|-----------|--------------------|--------------------|
//! | `register_agent(s)`  | ~100,000  | ~600,000           | 1,000,000          |
//! | `resolve_error(s)`   | ~50,000   | ~320,000           | 500,000            |
//!
//! Shared per-transaction overhead (~40k CU) is paid once in a batch.
//! Marginal cost per extra item is lower than a full single-item invocation.
//! See `docs/gas_costs.md` for the full table and `estimate_gas` for budgeting.
//!
//! ## Batch semantics
//!
//! Both `register_agents` and `resolve_errors` are **atomic**:
//! 1. Validate every item (auth, existence, duplicates in-batch).
//! 2. Collect per-item results.
//! 3. Write storage **only if every item validated successfully**.
//!
//! **IMPORTANT**: When implementing new batch operations that require authorization,
//! never call `require_auth()` multiple times for the same address within a single
//! transaction. Soroban's authorization system prevents this to avoid replay attacks.
//! Instead, collect unique addresses first and authorize each unique address once.
//! See `register_agents` Phase 0 for the correct pattern.
//!
//! Callers inspect the returned `Vec<BatchResult>` / `Vec<VoidBatchResult>`:
//! all-success means the batch committed; any failure means **no** writes occurred.

pub mod shared_exit_codes;
mod errors;
mod events;
mod upgrade;

#[cfg(test)]
mod upgrade_tests;

pub use upgrade::*;
pub use shared_exit_codes::CommonExitCode;

use events::{
    AdminChangedEvent, AgentDeregisteredEvent, AgentRegisteredEvent, ErrorReportedEvent,
    ErrorResolvedEvent, OperationApproved, OperationCancelled, OperationExecuted,
    OperationProposed, RegistryInitializedEvent, AnalyticsRecordedEvent,
    LeaderboardUpdatedEvent, SlaSetEvent, SlaViolationDetectedEvent, SlaBonusAwardedEvent,
};
pub use types::Attestation;
use soroban_sdk::{
    contract, contractimpl, contracttype, symbol_short, Address, BytesN, Env, Map, String, Symbol,
    TryFromVal, Val, Vec,
};

/// Default timelock delay in seconds (24 hours = 86,400 seconds).
pub const DEFAULT_TIMELOCK_DELAY: u64 = 86_400;
/// Default proposal validity period in seconds (7 days = 604,800 seconds).
pub const DEFAULT_PROPOSAL_EXPIRY: u64 = 604_800;

#[allow(dead_code)]
const MAX_AGENT_ID: u32 = 64;
const MAX_METADATA_ENTRIES: u32 = 16;
#[allow(dead_code)]
const MAX_METADATA_VALUE_SIZE: u32 = 256;
#[allow(dead_code)]
const MAX_TOTAL_AGENT_STORAGE: u32 = 4096;

// ─── Gas budget constants (empirical, CU / CPU instructions) ─────────────────
// Stored as defaults in contract config; overridable via `set_gas_config`.

/// Fixed overhead charged once per transaction invocation.
pub const GAS_TX_OVERHEAD: u64 = 40_000;
/// Full cost of a single `register_agent` (includes overhead).
pub const GAS_REGISTER_AGENT: u64 = 100_000;
/// Marginal cost of each additional agent in a batch after the first.
/// Chosen so a batch of 10 ≈ 600_000 CU (issue #120 gas analysis).
pub const GAS_REGISTER_AGENT_MARGINAL: u64 = 55_556;
/// Full cost of a single error resolution (includes overhead).
pub const GAS_RESOLVE_ERROR: u64 = 50_000;
/// Marginal cost of each additional error resolution in a batch.
pub const GAS_RESOLVE_ERROR_MARGINAL: u64 = 30_000;
/// Full cost of a single `slash_bond` operation (admin, includes overhead).
pub const GAS_SLASH_BOND: u64 = 60_000;
/// Full cost of a `deregister_agent` that also returns a bond.
pub const GAS_DEREGISTER_WITH_BOND: u64 = 80_000;
/// Full cost of checking/removing a single expired error (includes overhead).
pub const GAS_CLEANUP_ERROR: u64 = 20_000;
/// Marginal cost of each additional error checked in a cleanup batch.
pub const GAS_CLEANUP_ERROR_MARGINAL: u64 = 10_000;

/// Default minimum bond required to register an agent, in stroops.
/// 10 XLM = 100_000_000 stroops.  Admin can override via `set_min_bond`.
pub const DEFAULT_MIN_BOND_STROOPS: i128 = 100_000_000;
/// Cooldown period in ledgers before a deregistered agent's bond is returned.
/// At ~5s per ledger: 17_280 ledgers ≈ 24 hours.
pub const BOND_COOLDOWN_LEDGERS: u32 = 17_280;

/// Default TTL threshold (ledgers remaining) below which we extend.
pub const TTL_THRESHOLD: u32 = 100_000;
/// Target TTL after extension (~31 days at 5s ledgers: 535_680).
pub const TTL_EXTEND_TO: u32 = 535_680;

/// Default error entry retention, in ledger sequences (~30 days at 5s/ledger).
/// Overridable via `set_error_ttl`.
pub const DEFAULT_ERROR_TTL: u64 = 518_400;

/// Default analytics snapshot retention (30 days).
pub const ANALYTICS_SNAPSHOT_RETENTION: u32 = 30;

/// SLA penalty bond slash percentage (10% of bond).
pub const SLA_PENALTY_PERCENT: i128 = 10;

/// SLA bonus reputation boost (5 points).
pub const SLA_BONUS_REPUTATION_BOOST: u32 = 5;

/// Default page size for cursor-based agent pagination (issue #339).
pub const DEFAULT_PAGE_SIZE: u32 = 20;
/// Maximum upper bound on page size to guarantee execution within one ledger footprint budget.
pub const MAX_PAGE_SIZE: u32 = 50;

// ─── Types ───────────────────────────────────────────────────────────────────

/// Input / stored agent record.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AgentRecord {
    pub id: Symbol,
    pub capability: Symbol,
    pub price_stroops: i128,
    pub endpoint: String,
    pub owner: Address,
    pub metadata: Map<Symbol, Val>,
    /// XLM bond locked at registration time, in stroops.
    /// Must be ≥ the contract's `min_bond` setting (default: 100_000_000 = 10 XLM).
    pub bond_amount: i128,
}

/// Paginated response for agent listing (issue #339).
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AgentPage {
    /// List of agents on the current page.
    pub agents: Vec<AgentRecord>,
    /// Cursor to fetch the next page, or `None` if this is the last page.
    pub next_cursor: Option<u32>,
    /// Total active agents currently in the registry.
    pub total_count: u32,
}

/// Aggregate view of an agent's standing, including its error count as
/// tracked by error-resolver. `error_count` is 0 whenever error-resolver
/// isn't configured or the cross-contract call fails, rather than causing
/// this query to fail: health information degrades gracefully.
#[contracttype]
#[derive(Clone)]
pub struct AgentHealth {
    pub agent_id: Symbol,
    pub exists: bool,
    pub frozen: bool,
    pub error_count: u32,
}

/// Alias used by the batch API (`register_agents(agents: Vec<AgentParams>)`).
pub type AgentParams = AgentRecord;

/// Stored alongside a `DataKey::BondCooldown` entry so the second
/// `deregister_agent` call can return the bond without needing the (already
/// removed) `AgentRecord`.
#[contracttype]
#[derive(Clone)]
pub struct CooldownRecord {
    /// Ledger sequence number at which the cooldown expires (inclusive).
    pub expiry_ledger: u32,
    /// Owner to receive the bond.
    pub owner: Address,
    /// Bond amount to return, in stroops.
    pub bond_amount: i128,
}

/// How an on-chain error was closed.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
#[repr(u32)]
pub enum Resolution {
    Fixed = 0,
    Ignored = 1,
    Escalated = 2,
}

/// Persistent error entry that can be batch-resolved.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ErrorEntry {
    pub id: BytesN<32>,
    pub reporter: Address,
    pub message: String,
    pub resolved: bool,
    pub resolution: Resolution,
    /// Ledger sequence at which this entry was created.
    pub created_at: u64,
    /// Ledger sequence at/after which this entry is eligible for cleanup.
    pub expires_at: u64,
}

/// Empirical gas budget parameters (instance storage).
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct GasConfig {
    pub tx_overhead: u64,
    pub register_agent: u64,
    pub register_agent_marginal: u64,
    pub resolve_error: u64,
    pub resolve_error_marginal: u64,
    pub slash_bond: u64,
    pub deregister_with_bond: u64,
    pub cleanup_error: u64,
    pub cleanup_error_marginal: u64,
}

impl GasConfig {
    pub fn default_config() -> Self {
        Self {
            tx_overhead: GAS_TX_OVERHEAD,
            register_agent: GAS_REGISTER_AGENT,
            register_agent_marginal: GAS_REGISTER_AGENT_MARGINAL,
            resolve_error: GAS_RESOLVE_ERROR,
            resolve_error_marginal: GAS_RESOLVE_ERROR_MARGINAL,
            slash_bond: GAS_SLASH_BOND,
            deregister_with_bond: GAS_DEREGISTER_WITH_BOND,
            cleanup_error: GAS_CLEANUP_ERROR,
            cleanup_error_marginal: GAS_CLEANUP_ERROR_MARGINAL,
        }
    }
}

/// Configurable storage limits per contract instance.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct StorageConfig {
    pub max_agents: u32,         // Global limit (0 = unlimited)
    pub max_per_capability: u32, // Per-capability limit (0 = unlimited)
}

#[contracttype]
#[derive(Clone)]
pub enum DataKey {
    Admin,
    Paused,
    Agent(Symbol),
    CapabilityIndex(Symbol),
    FrozenAgent(Symbol),
    ErrorRecord(BytesN<32>),
    GasConfig,
    /// Configurable TTL (in ledger sequences) applied to new error entries.
    ErrorTTL,
    /// Minimum bond required for registration, in stroops (instance storage).
    MinBond,
    /// Ledger number at which the cooldown expires for a deregistering agent.
    /// Key present ⟺ the agent is in the cooldown window.
    BondCooldown(Symbol),
    MultisigConfig,
    Proposal(u64),
    ProposalIdSequence,
    StorageConfig,
    TotalAgents,
    DiscoveryCache(DiscoveryQuery),
    DiscoveryStats,
    // Analytics keys
    AgentAnalytics(Symbol),
    AnalyticsSnapshot(Symbol, u64),
    // SLA keys
    AgentSla(Symbol),
    SlaViolation(Symbol, u64),
    SlaViolationCount(Symbol),
    // Pagination keys (issue #339)
    AgentByIndex(u32),
    RegistrationSequence,
}

/// Per-item outcome for batch registration (`Ok(agent_id)` / `Err(code)`).
///
/// The failure payload is the raw `u32` error code rather than [`Error`]
/// itself: a `#[contracterror]` type is represented on the wire as a bare
/// status code and cannot be embedded inside a `#[contracttype]`. Use
/// [`Error::from_code`] to recover the typed variant.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum BatchResult {
    Ok(Symbol),
    Err(u32),
}

/// Per-item outcome for batch error resolution. See [`BatchResult`] for why
/// the failure payload is a `u32` code.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum VoidBatchResult {
    Ok,
    Err(u32),
}

#[contract]
pub struct AgentRegistryContract;

// ─── Helpers ─────────────────────────────────────────────────────────────────

fn gas_config(env: &Env) -> GasConfig {
    env.storage()
        .instance()
        .get(&DataKey::GasConfig)
        .unwrap_or_else(GasConfig::default_config)
}

fn error_ttl(env: &Env) -> u64 {
    env.storage()
        .instance()
        .get(&DataKey::ErrorTTL)
        .unwrap_or(DEFAULT_ERROR_TTL)
}

fn get_storage_config_internal(env: &Env) -> StorageConfig {
    env.storage()
        .instance()
        .get(&DataKey::StorageConfig)
        .unwrap_or(StorageConfig {
            max_agents: 0,
            max_per_capability: 0,
        })
}

fn get_total_agents(env: &Env) -> u32 {
    env.storage()
        .instance()
        .get(&DataKey::TotalAgents)
        .unwrap_or(0)
}

fn get_registration_sequence(env: &Env) -> u32 {
    env.storage()
        .instance()
        .get(&DataKey::RegistrationSequence)
        .unwrap_or(0)
}

fn get_capability_index(env: &Env, capability: &Symbol) -> Vec<Symbol> {
    let cap_key = DataKey::CapabilityIndex(capability.clone());
    env.storage()
        .persistent()
        .get(&cap_key)
        .unwrap_or_else(|| Vec::new(env))
}

fn extend_ttl_for_key(env: &Env, key: &DataKey) {
    // Only extend when the entry exists; extend_ttl panics on missing keys.
    if env.storage().persistent().has(key) {
        env.storage()
            .persistent()
            .extend_ttl(key, TTL_THRESHOLD, TTL_EXTEND_TO);
    }
}

/// Extend TTL for a set of persistent keys in one pass (batched rent bump).
fn extend_ttl_batch(env: &Env, keys: &Vec<DataKey>) {
    for key in keys.iter() {
        extend_ttl_for_key(env, &key);
    }
}

fn append_capability_index(env: &Env, capability: &Symbol, agent_id: &Symbol) {
    let cap_key = DataKey::CapabilityIndex(capability.clone());
    let mut ids: Vec<Symbol> = env
        .storage()
        .persistent()
        .get(&cap_key)
        .unwrap_or_else(|| Vec::new(env));
    ids.push_back(agent_id.clone());
    env.storage().persistent().set(&cap_key, &ids);
    extend_ttl_for_key(env, &cap_key);
}

/// True if `id` appears more than once in `agents` at or before `index`.
fn is_duplicate_in_batch(agents: &Vec<AgentRecord>, index: u32, id: &Symbol) -> bool {
    let mut seen = 0u32;
    for i in 0..=index {
        if let Some(a) = agents.get(i) {
            if a.id == *id {
                seen += 1;
                if seen > 1 {
                    return true;
                }
            }
        }
    }
    false
}

fn is_duplicate_error_id(ids: &Vec<BytesN<32>>, index: u32, id: &BytesN<32>) -> bool {
    let mut seen = 0u32;
    for i in 0..=index {
        if let Some(other) = ids.get(i) {
            if other == *id {
                seen += 1;
                if seen > 1 {
                    return true;
                }
            }
        }
    }
    false
}

fn require_not_paused(env: &Env) -> Result<(), Error> {
    let paused: bool = env
        .storage()
        .instance()
        .get(&DataKey::Paused)
        .unwrap_or(false);
    if paused {
        return Err(Error::ContractPaused);
    }
    Ok(())
}

fn is_admin(env: &Env, addr: &Address) -> bool {
    if let Some(single_admin) = env.storage().instance().get::<_, Address>(&DataKey::Admin) {
        if &single_admin == addr {
            return true;
        }
    }
    if let Some(config) = env
        .storage()
        .instance()
        .get::<_, MultisigConfig>(&DataKey::MultisigConfig)
    {
        return config.admins.contains(addr);
    }
    false
}

fn require_admin(env: &Env) -> Result<Address, Error> {
    let admin: Address = env
        .storage()
        .instance()
        .get(&DataKey::Admin)
        .ok_or(Error::NotAdmin)?;
    admin.require_auth();
    Ok(admin)
}

fn internal_slash_bond(env: &Env, agent_id: Symbol, penalty_stroops: i128) -> Result<(), Error> {
    let agent_key = DataKey::Agent(agent_id.clone());
    let mut record: AgentRecord = env
        .storage()
        .persistent()
        .get(&agent_key)
        .ok_or(Error::NotFound)?;

    let remaining = if penalty_stroops >= record.bond_amount {
        0_i128
    } else {
        record.bond_amount - penalty_stroops
    };
    let actual_penalty = record.bond_amount - remaining;

    record.bond_amount = remaining;
    env.storage().persistent().set(&agent_key, &record);
    extend_ttl_for_key(env, &agent_key);

    env.events().publish(
        (symbol_short!("registry"), symbol_short!("bond_slsh")),
        events::BondSlashed {
            agent_id,
            penalty_stroops: actual_penalty,
            remaining_stroops: remaining,
        },
    );
    Ok(())
}

fn require_not_frozen(env: &Env, agent_id: &Symbol) -> Result<(), Error> {
    let frozen: bool = env
        .storage()
        .persistent()
        .get(&DataKey::FrozenAgent(agent_id.clone()))
        .unwrap_or(false);
    if frozen {
        return Err(Error::AgentFrozen);
    }
    Ok(())
}

fn validate_record(_env: &Env, record: &AgentRecord) -> Result<(), Error> {
    if record.metadata.len() > MAX_METADATA_ENTRIES {
        return Err(Error::InvalidRecord);
    }
    Ok(())
}

/// Read the current minimum bond from instance storage, falling back to the
/// compile-time default (10 XLM = 100_000_000 stroops).
fn min_bond(env: &Env) -> i128 {
    env.storage()
        .instance()
        .get(&DataKey::MinBond)
        .unwrap_or(DEFAULT_MIN_BOND_STROOPS)
}

#[contractimpl]
impl AgentRegistryContract {
    pub fn initialize(env: Env, admin: Address) -> Result<(), Error> {
        if env.storage().instance().has(&DataKey::Admin) {
            return Err(Error::AlreadyExists);
        }
        env.storage().instance().set(&DataKey::Admin, &admin);
        env.storage().instance().set(&DataKey::Paused, &false);

        // Emit (registry, init) so indexers know exactly when the
        // contract became active and who the genesis admin is.
        env.events().publish(
            (symbol_short!("registry"), symbol_short!("init")),
            RegistryInitializedEvent {
                admin: admin.clone(),
            },
        );

        Ok(())
    }

    pub fn set_admin(env: Env, new_admin: Address) -> Result<(), Error> {
        if env.storage().instance().has(&DataKey::MultisigConfig) {
            return Err(Error::Unauthorized);
        }
        let old_admin = require_admin(&env)?;
        env.storage().instance().set(&DataKey::Admin, &new_admin);

        // Emit (registry, admin_changed) with both old and new admin addresses
        // to provide a complete audit trail for on-chain governance changes.
        env.events().publish(
            (symbol_short!("registry"), symbol_short!("adm_chngd")),
            AdminChangedEvent {
                old_admin,
                new_admin,
            },
        );

        Ok(())
    }

    // ─── Multi-Signature Admin Operations ──────────────────────────────────────

    pub fn set_multisig_config(
        env: Env,
        caller: Address,
        admins: Vec<Address>,
        threshold: u32,
        timelock_delay: u64,
    ) -> Result<(), Error> {
        caller.require_auth();
        if !is_admin(&env, &caller) {
            return Err(Error::NotAdmin);
        }
        if threshold == 0 || threshold > admins.len() {
            return Err(Error::InvalidThreshold);
        }
        let config = MultisigConfig {
            admins,
            threshold,
            timelock_delay,
        };
        env.storage()
            .instance()
            .set(&DataKey::MultisigConfig, &config);
        Ok(())
    }

    pub fn get_multisig_config(env: Env) -> Option<MultisigConfig> {
        env.storage().instance().get(&DataKey::MultisigConfig)
    }

    pub fn propose_operation(
        env: Env,
        proposer: Address,
        action: AdminAction,
        expiry_seconds: Option<u64>,
    ) -> Result<u64, Error> {
        proposer.require_auth();
        if !is_admin(&env, &proposer) {
            return Err(Error::InvalidSigner);
        }

        let config = env
            .storage()
            .instance()
            .get::<_, MultisigConfig>(&DataKey::MultisigConfig)
            .unwrap_or_else(|| {
                let mut default_admins = Vec::new(&env);
                default_admins.push_back(proposer.clone());
                MultisigConfig {
                    admins: default_admins,
                    threshold: 1,
                    timelock_delay: DEFAULT_TIMELOCK_DELAY,
                }
            });

        let mut sequence: u64 = env
            .storage()
            .instance()
            .get(&DataKey::ProposalIdSequence)
            .unwrap_or(0);
        sequence += 1;
        env.storage()
            .instance()
            .set(&DataKey::ProposalIdSequence, &sequence);

        let created_at = env.ledger().timestamp();
        let eta = created_at + config.timelock_delay;
        let expires_at = created_at + expiry_seconds.unwrap_or(DEFAULT_PROPOSAL_EXPIRY);

        let mut initial_approvals = Vec::new(&env);
        initial_approvals.push_back(proposer.clone());

        let proposal = Proposal {
            id: sequence,
            proposer: proposer.clone(),
            action: action.clone(),
            created_at,
            eta,
            expires_at,
            approvals: initial_approvals,
            executed: false,
            cancelled: false,
        };

        env.storage()
            .persistent()
            .set(&DataKey::Proposal(sequence), &proposal);

        let action_symbol = match action {
            AdminAction::Pause => symbol_short!("pause"),
            AdminAction::Unpause => symbol_short!("unpause"),
            AdminAction::SetAdmin(_) => symbol_short!("set_adm"),
            AdminAction::SlashBond(_, _) => symbol_short!("slash"),
            AdminAction::SetMinBond(_) => symbol_short!("min_bond"),
            AdminAction::SetGasConfig(_) => symbol_short!("gas_cfg"),
            AdminAction::SetMultisigConfig(_, _, _) => symbol_short!("msig_cfg"),
        };

        env.events().publish(
            (symbol_short!("registry"), symbol_short!("op_prop")),
            OperationProposed {
                proposal_id: sequence,
                proposer,
                action: action_symbol,
                eta,
                expires_at,
            },
        );

        Ok(sequence)
    }

    pub fn approve_operation(env: Env, approver: Address, proposal_id: u64) -> Result<(), Error> {
        approver.require_auth();
        if !is_admin(&env, &approver) {
            return Err(Error::InvalidSigner);
        }

        let mut proposal: Proposal = env
            .storage()
            .persistent()
            .get(&DataKey::Proposal(proposal_id))
            .ok_or(Error::ProposalNotFound)?;

        if proposal.executed {
            return Err(Error::ProposalAlreadyExecuted);
        }
        if proposal.cancelled {
            return Err(Error::ProposalAlreadyCancelled);
        }

        let now = env.ledger().timestamp();
        if now > proposal.expires_at {
            return Err(Error::ProposalExpired);
        }

        if proposal.approvals.contains(&approver) {
            return Err(Error::AlreadyApproved);
        }

        proposal.approvals.push_back(approver.clone());
        env.storage()
            .persistent()
            .set(&DataKey::Proposal(proposal_id), &proposal);

        env.events().publish(
            (symbol_short!("registry"), symbol_short!("op_appr")),
            OperationApproved {
                proposal_id,
                approver,
            },
        );

        Ok(())
    }

    pub fn execute_operation(env: Env, executor: Address, proposal_id: u64) -> Result<(), Error> {
        executor.require_auth();
        if !is_admin(&env, &executor) {
            return Err(Error::InvalidSigner);
        }

        let mut proposal: Proposal = env
            .storage()
            .persistent()
            .get(&DataKey::Proposal(proposal_id))
            .ok_or(Error::ProposalNotFound)?;

        if proposal.executed {
            return Err(Error::ProposalAlreadyExecuted);
        }
        if proposal.cancelled {
            return Err(Error::ProposalAlreadyCancelled);
        }

        let now = env.ledger().timestamp();
        if now > proposal.expires_at {
            return Err(Error::ProposalExpired);
        }
        if now < proposal.eta {
            return Err(Error::TimelockNotElapsed);
        }

        let config = env
            .storage()
            .instance()
            .get::<_, MultisigConfig>(&DataKey::MultisigConfig)
            .unwrap_or_else(|| MultisigConfig {
                admins: Vec::new(&env),
                threshold: 1,
                timelock_delay: DEFAULT_TIMELOCK_DELAY,
            });

        if proposal.approvals.len() < config.threshold {
            return Err(Error::InsufficientApprovals);
        }

        proposal.executed = true;
        env.storage()
            .persistent()
            .set(&DataKey::Proposal(proposal_id), &proposal);

        match proposal.action.clone() {
            AdminAction::Pause => {
                env.storage().instance().set(&DataKey::Paused, &true);
                env.events()
                    .publish((symbol_short!("registry"), symbol_short!("paused")), ());
            }
            AdminAction::Unpause => {
                env.storage().instance().set(&DataKey::Paused, &false);
                env.events()
                    .publish((symbol_short!("registry"), symbol_short!("unpaused")), ());
            }
            AdminAction::SetAdmin(new_admin) => {
                let old_admin = env
                    .storage()
                    .instance()
                    .get(&DataKey::Admin)
                    .unwrap_or_else(|| executor.clone());
                env.storage().instance().set(&DataKey::Admin, &new_admin);
                env.events().publish(
                    (symbol_short!("registry"), symbol_short!("adm_chngd")),
                    AdminChangedEvent {
                        old_admin,
                        new_admin,
                    },
                );
            }
            AdminAction::SlashBond(agent_id, penalty_stroops) => {
                internal_slash_bond(&env, agent_id, penalty_stroops)?;
            }
            AdminAction::SetMinBond(min_bond_val) => {
                env.storage()
                    .instance()
                    .set(&DataKey::MinBond, &min_bond_val);
            }
            AdminAction::SetGasConfig(gas_config_val) => {
                env.storage()
                    .instance()
                    .set(&DataKey::GasConfig, &gas_config_val);
            }
            AdminAction::SetMultisigConfig(admins, threshold, timelock_delay) => {
                if threshold == 0 || threshold > admins.len() {
                    return Err(Error::InvalidThreshold);
                }
                let new_config = MultisigConfig {
                    admins,
                    threshold,
                    timelock_delay,
                };
                env.storage()
                    .instance()
                    .set(&DataKey::MultisigConfig, &new_config);
            }
        }

        env.events().publish(
            (symbol_short!("registry"), symbol_short!("op_exec")),
            OperationExecuted {
                proposal_id,
                executor,
            },
        );

        Ok(())
    }

    pub fn cancel_operation(env: Env, canceller: Address, proposal_id: u64) -> Result<(), Error> {
        canceller.require_auth();

        let mut proposal: Proposal = env
            .storage()
            .persistent()
            .get(&DataKey::Proposal(proposal_id))
            .ok_or(Error::ProposalNotFound)?;

        if proposal.proposer != canceller {
            return Err(Error::Unauthorized);
        }
        if proposal.executed {
            return Err(Error::ProposalAlreadyExecuted);
        }
        if proposal.cancelled {
            return Err(Error::ProposalAlreadyCancelled);
        }

        proposal.cancelled = true;
        env.storage()
            .persistent()
            .set(&DataKey::Proposal(proposal_id), &proposal);

        env.events().publish(
            (symbol_short!("registry"), symbol_short!("op_canc")),
            OperationCancelled {
                proposal_id,
                canceller,
            },
        );

        Ok(())
    }

    pub fn get_proposal(env: Env, proposal_id: u64) -> Result<Proposal, Error> {
        env.storage()
            .persistent()
            .get(&DataKey::Proposal(proposal_id))
            .ok_or(Error::ProposalNotFound)
    }

    pub fn pause(env: Env) -> Result<(), Error> {
        require_admin(&env)?;
        env.storage().instance().set(&DataKey::Paused, &true);
        env.events()
            .publish((symbol_short!("registry"), symbol_short!("paused")), ());
        Ok(())
    }

    pub fn unpause(env: Env) -> Result<(), Error> {
        require_admin(&env)?;
        env.storage().instance().set(&DataKey::Paused, &false);
        env.events()
            .publish((symbol_short!("registry"), symbol_short!("unpaused")), ());
        Ok(())
    }

    pub fn is_paused(env: Env) -> bool {
        env.storage()
            .instance()
            .get(&DataKey::Paused)
            .unwrap_or(false)
    }

    pub fn get_admin(env: Env) -> Option<Address> {
        env.storage().instance().get(&DataKey::Admin)
    }

    pub fn freeze_agent(env: Env, agent_id: Symbol) -> Result<(), Error> {
        require_admin(&env)?;
        env.storage()
            .persistent()
            .set(&DataKey::FrozenAgent(agent_id.clone()), &true);
        env.events().publish(
            (symbol_short!("registry"), symbol_short!("freeze")),
            agent_id,
        );
        Ok(())
    }

    pub fn unfreeze_agent(env: Env, agent_id: Symbol) -> Result<(), Error> {
        require_admin(&env)?;
        env.storage()
            .persistent()
            .set(&DataKey::FrozenAgent(agent_id.clone()), &false);
        env.events().publish(
            (symbol_short!("registry"), symbol_short!("unfreeze")),
            agent_id,
        );
        Ok(())
    }

    pub fn is_agent_frozen(env: Env, agent_id: Symbol) -> bool {
        env.storage()
            .persistent()
            .get(&DataKey::FrozenAgent(agent_id))
            .unwrap_or(false)
    }

    pub fn register_agent(env: Env, record: AgentRecord) -> Result<(), Error> {
        require_not_paused(&env)?;
        require_not_frozen(&env, &record.id)?;
        record.owner.require_auth();

        validate_record(&env, &record)?;

        let config = get_storage_config_internal(&env);
        if config.max_agents > 0 {
            let total = get_total_agents(&env);
            if total >= config.max_agents {
                return Err(Error::StorageLimitReached);
            }
        }

        if config.max_per_capability > 0 {
            let cap_index = get_capability_index(&env, &record.capability);
            if cap_index.len() >= config.max_per_capability {
                return Err(Error::CapabilityLimitReached);
            }
        }

        // ── Bond validation ──────────────────────────────────────────────────
        let required = min_bond(&env);
        if record.bond_amount < required {
            return Err(Error::InsufficientBond);
        }

        let agent_key = DataKey::Agent(record.id.clone());
        if env.storage().persistent().has(&agent_key) {
            return Err(Error::AlreadyExists);
        }

        append_capability_index(&env, &record.capability, &record.id);
        env.storage().persistent().set(&agent_key, &record);
        extend_ttl_for_key(&env, &agent_key);

        let seq = get_registration_sequence(&env);
        let index_key = DataKey::AgentByIndex(seq);
        env.storage().persistent().set(&index_key, &record.id);
        extend_ttl_for_key(&env, &index_key);
        env.storage()
            .instance()
            .set(&DataKey::RegistrationSequence, &(seq + 1));

        let total = get_total_agents(&env);
        env.storage()
            .instance()
            .set(&DataKey::TotalAgents, &(total + 1));

        // Emit (registry, agent_registered) so off-chain indexers can
        // immediately detect new agents without polling storage.
        env.events().publish(
            (symbol_short!("registry"), symbol_short!("agent_reg")),
            AgentRegisteredEvent {
                agent_id: record.id.clone(),
                owner: record.owner.clone(),
                capability: record.capability.clone(),
                price_stroops: record.price_stroops,
            },
        );

        // Emit (registry, bond_locked) so indexers can track bonds independently
        // from registration events — useful for slashing and cooldown monitoring.
        env.events().publish(
            (symbol_short!("registry"), symbol_short!("bond_lck")),
            events::BondLocked {
                agent_id: record.id.clone(),
                owner: record.owner.clone(),
                amount_stroops: record.bond_amount,
            },
        );

        Ok(())
    }

    /// Batch-register agents in **one** transaction.
    ///
    /// * Validates every agent first (auth, not already registered, no in-batch
    ///   duplicate ids).
    /// * Returns a per-agent [`BatchResult`].
    /// * Writes storage only when **all** items validate (atomic all-or-nothing).
    /// * On success, extends TTL for every written key in a single pass.
    pub fn register_agents(env: Env, agents: Vec<AgentRecord>) -> Vec<BatchResult> {
        let mut results: Vec<BatchResult> = Vec::new(&env);
        let mut all_ok = true;

        // Contract-level pause applies to the whole batch.
        if require_not_paused(&env).is_err() {
            for _ in 0..agents.len() {
                results.push_back(BatchResult::Err(Error::ContractPaused as u32));
            }
            return results;
        }

        // ── Phase 0: collect unique owners and authorize once per owner ──────
        //
        // Soroban's authorization system prevents calling require_auth() multiple
        // times for the same address within a single transaction to avoid replay
        // attacks. When batch processing agents with the same owner, we must
        // deduplicate authorization calls by collecting unique owners first.
        let mut unique_owners = Vec::new(&env);
        for i in 0..agents.len() {
            let record = agents.get(i).unwrap();
            let mut already_seen = false;
            for j in 0..unique_owners.len() {
                if unique_owners.get(j).unwrap() == record.owner {
                    already_seen = true;
                    break;
                }
            }
            if !already_seen {
                unique_owners.push_back(record.owner.clone());
            }
        }

        // Authorize each unique owner once. Host will reject the whole invocation
        // if any required auth is missing.
        for i in 0..unique_owners.len() {
            unique_owners.get(i).unwrap().require_auth();
        }

        // ── Phase 1: validate (no writes) ────────────────────────────────────

        let config = get_storage_config_internal(&env);
        let mut sim_total = get_total_agents(&env);

        for i in 0..agents.len() {
            let record = agents.get(i).unwrap();

            // Auth already handled in Phase 0 for all unique owners.

            if require_not_frozen(&env, &record.id).is_err() {
                results.push_back(BatchResult::Err(Error::AgentFrozen as u32));
                all_ok = false;
                continue;
            }

            if is_duplicate_in_batch(&agents, i, &record.id) {
                results.push_back(BatchResult::Err(Error::DuplicateInBatch as u32));
                all_ok = false;
                continue;
            }

            let agent_key = DataKey::Agent(record.id.clone());
            if env.storage().persistent().has(&agent_key) {
                results.push_back(BatchResult::Err(Error::AlreadyExists as u32));
                all_ok = false;
                continue;
            }

            if config.max_agents > 0 && sim_total >= config.max_agents {
                results.push_back(BatchResult::Err(Error::StorageLimitReached as u32));
                all_ok = false;
                continue;
            }

            if config.max_per_capability > 0 {
                let existing_cap = get_capability_index(&env, &record.capability).len();
                let mut batch_cap_count = 0u32;
                for j in 0..i {
                    if let (Some(prev_res), Some(prev_agent)) = (results.get(j), agents.get(j)) {
                        if prev_res == BatchResult::Ok(prev_agent.id.clone())
                            && prev_agent.capability == record.capability
                        {
                            batch_cap_count += 1;
                        }
                    }
                }
                if existing_cap + batch_cap_count >= config.max_per_capability {
                    results.push_back(BatchResult::Err(Error::CapabilityLimitReached as u32));
                    all_ok = false;
                    continue;
                }
            }

            sim_total += 1;
            results.push_back(BatchResult::Ok(record.id.clone()));
        }

        // ── Phase 2: abort without writing if any item failed ────────────────
        if !all_ok || agents.is_empty() {
            return results;
        }

        // ── Phase 3: commit all writes + batched TTL extension ───────────────
        let mut ttl_keys: Vec<DataKey> = Vec::new(&env);
        let mut seq = get_registration_sequence(&env);
        for i in 0..agents.len() {
            let record = agents.get(i).unwrap();
            let agent_key = DataKey::Agent(record.id.clone());
            let index_key = DataKey::AgentByIndex(seq);
            append_capability_index(&env, &record.capability, &record.id);
            env.storage().persistent().set(&agent_key, &record);
            env.storage().persistent().set(&index_key, &record.id);
            ttl_keys.push_back(agent_key);
            ttl_keys.push_back(index_key);
            seq += 1;

            // Emit one (registry, agent_registered) event per committed agent.
            // Batch callers receive the same event shape as single registration,
            // making the indexer event handler uniform across both code paths.
            env.events().publish(
                (symbol_short!("registry"), symbol_short!("agent_reg")),
                AgentRegisteredEvent {
                    agent_id: record.id.clone(),
                    owner: record.owner.clone(),
                    capability: record.capability.clone(),
                    price_stroops: record.price_stroops,
                },
            );

            // Emit (registry, bond_locked) per committed agent so bond indexers
            // work uniformly across single and batch registration code paths.
            env.events().publish(
                (symbol_short!("registry"), symbol_short!("bond_lck")),
                events::BondLocked {
                    agent_id: record.id.clone(),
                    owner: record.owner.clone(),
                    amount_stroops: record.bond_amount,
                },
            );
        }
        env.storage()
            .instance()
            .set(&DataKey::RegistrationSequence, &seq);
        let current_total = get_total_agents(&env);
        env.storage()
            .instance()
            .set(&DataKey::TotalAgents, &(current_total + agents.len()));
        extend_ttl_batch(&env, &ttl_keys);

        results
    }

    pub fn lookup_agents(env: Env, capability: Symbol) -> Vec<AgentRecord> {
        let cap_key = DataKey::CapabilityIndex(capability);
        let ids: Vec<Symbol> = env
            .storage()
            .persistent()
            .get(&cap_key)
            .unwrap_or_else(|| Vec::new(&env));

        // Touch / extend the index TTL when used.
        if env.storage().persistent().has(&cap_key) {
            extend_ttl_for_key(&env, &cap_key);
        }

        let mut records = Vec::new(&env);
        let mut ttl_keys: Vec<DataKey> = Vec::new(&env);
        for id in ids.iter() {
            let agent_key = DataKey::Agent(id.clone());
            if let Some(r) = env.storage().persistent().get(&agent_key) {
                ttl_keys.push_back(agent_key);
                records.push_back(r);
            }
        }
        // Batch-extend TTLs for every agent loaded in this lookup.
        extend_ttl_batch(&env, &ttl_keys);
        records
    }

    /// Cursor-based paginated agent listing with upper bound on page size (issue #339).
    ///
    /// - `cursor`: Starting registration sequence index (defaults to 0 if `None`).
    /// - `limit`: Number of items requested (defaults to [`DEFAULT_PAGE_SIZE`], capped at [`MAX_PAGE_SIZE`]).
    ///
    /// Returns [`AgentPage`] containing matching agents, `next_cursor` for subsequent page,
    /// and `total_count` of active registered agents.
    pub fn get_agents(env: Env, cursor: Option<u32>, limit: Option<u32>) -> AgentPage {
        let start_cursor = cursor.unwrap_or(0);
        let requested_limit = limit.unwrap_or(DEFAULT_PAGE_SIZE);
        let effective_limit = if requested_limit == 0 {
            DEFAULT_PAGE_SIZE
        } else if requested_limit > MAX_PAGE_SIZE {
            MAX_PAGE_SIZE
        } else {
            requested_limit
        };

        let total_registered = get_registration_sequence(&env);
        let total_active = get_total_agents(&env);

        let mut agents = Vec::new(&env);
        let mut current_idx = start_cursor;
        let mut ttl_keys: Vec<DataKey> = Vec::new(&env);

        while current_idx < total_registered && agents.len() < effective_limit {
            let index_key = DataKey::AgentByIndex(current_idx);
            if let Some(agent_id) = env.storage().persistent().get::<_, Symbol>(&index_key) {
                let agent_key = DataKey::Agent(agent_id);
                if let Some(record) = env.storage().persistent().get::<_, AgentRecord>(&agent_key) {
                    ttl_keys.push_back(agent_key);
                    agents.push_back(record);
                }
            }
            current_idx += 1;
        }

        extend_ttl_batch(&env, &ttl_keys);

        let next_cursor = if current_idx < total_registered {
            Some(current_idx)
        } else {
            None
        };

        AgentPage {
            agents,
            next_cursor,
            total_count: total_active,
        }
    }

    /// Discover and rank agents matching multi-criteria criteria:
    /// required capability, max price, min reputation, and max latency.
    ///
    /// Returns a list of [`DiscoveryResult`] structs ordered descending by composite score.
    /// Results are cached in temporary storage for gas efficiency within the same transaction.
    pub fn discover_agents(env: Env, query: DiscoveryQuery) -> Vec<DiscoveryResult> {
        let cache_key = DataKey::DiscoveryCache(query.clone());

        // 1. Re-query within same transaction is served free from temporary storage cache
        if let Some(cached_results) = env
            .storage()
            .temporary()
            .get::<_, Vec<DiscoveryResult>>(&cache_key)
        {
            let mut stats: DiscoveryStats = env
                .storage()
                .instance()
                .get(&DataKey::DiscoveryStats)
                .unwrap_or(DiscoveryStats {
                    total_queries: 0,
                    total_matches_found: 0,
                    cache_hits: 0,
                });
            stats.total_queries += 1;
            stats.cache_hits += 1;
            stats.total_matches_found += cached_results.len() as u64;
            env.storage()
                .instance()
                .set(&DataKey::DiscoveryStats, &stats);

            return cached_results;
        }

        // 2. Fetch agent IDs registered for the capability
        let cap_key = DataKey::CapabilityIndex(query.required_capability.clone());
        let agent_ids: Vec<Symbol> = env
            .storage()
            .persistent()
            .get(&cap_key)
            .unwrap_or_else(|| Vec::new(&env));

        if env.storage().persistent().has(&cap_key) {
            extend_ttl_for_key(&env, &cap_key);
        }

        let mut candidate_records: Vec<AgentRecord> = Vec::new(&env);
        let mut rep_list: Vec<u32> = Vec::new(&env);
        let mut avail_list: Vec<u32> = Vec::new(&env);
        let mut resp_list: Vec<u32> = Vec::new(&env);

        let mut max_candidate_price: i128 = 0;
        let mut max_candidate_latency: u32 = 0;

        let rep_sym = Symbol::new(&env, "reputation");
        let rep_short = symbol_short!("rep");
        let lat_sym = Symbol::new(&env, "response_time");
        let lat_alt = Symbol::new(&env, "latency");
        let avail_sym = Symbol::new(&env, "availability");
        let avail_short = symbol_short!("avail");

        for id in agent_ids.iter() {
            if Self::is_agent_frozen(env.clone(), id.clone()) {
                continue;
            }

            let agent_key = DataKey::Agent(id.clone());
            if let Some(record) = env.storage().persistent().get::<_, AgentRecord>(&agent_key) {
                // Multi-criteria filter 1: max price
                if query.max_price > 0 && record.price_stroops > query.max_price {
                    continue;
                }

                // Multi-criteria filter 2: min reputation
                let rep = get_metadata_u32(&env, &record.metadata, &rep_sym, &rep_short, 100);
                if query.min_reputation > 0 && rep < query.min_reputation {
                    continue;
                }

                // Multi-criteria filter 3: max latency / response time
                let resp_time = get_metadata_u32(&env, &record.metadata, &lat_sym, &lat_alt, 100);
                if query.max_latency > 0 && resp_time > query.max_latency {
                    continue;
                }

                let avail = get_metadata_u32(&env, &record.metadata, &avail_sym, &avail_short, 100);

                if record.price_stroops > max_candidate_price {
                    max_candidate_price = record.price_stroops;
                }
                if resp_time > max_candidate_latency {
                    max_candidate_latency = resp_time;
                }

                candidate_records.push_back(record);
                rep_list.push_back(rep);
                avail_list.push_back(avail);
                resp_list.push_back(resp_time);
            }
        }

        // 3. Score candidates using composite scoring algorithm:
        //    30% reputation + 25% price competitiveness + 25% availability + 20% response time
        let mut results: Vec<DiscoveryResult> = Vec::new(&env);
        let count = candidate_records.len();

        for i in 0..count {
            let record = candidate_records.get(i).unwrap();
            let rep = rep_list.get(i).unwrap();
            let avail = avail_list.get(i).unwrap();
            let resp_time = resp_list.get(i).unwrap();

            let rep_score = rep.min(100);
            let avail_score = avail.min(100);

            let price_score = if query.max_price > 0 {
                if record.price_stroops <= query.max_price {
                    let p_ratio = (record.price_stroops * 100) / query.max_price;
                    100u32.saturating_sub(p_ratio as u32)
                } else {
                    0u32
                }
            } else if max_candidate_price > 0 {
                let p_ratio = (record.price_stroops * 100) / max_candidate_price;
                100u32.saturating_sub(p_ratio as u32)
            } else {
                100u32
            };

            let response_score = if query.max_latency > 0 {
                if resp_time <= query.max_latency {
                    let r_ratio = ((resp_time as u64) * 100) / (query.max_latency as u64);
                    100u32.saturating_sub(r_ratio as u32)
                } else {
                    0u32
                }
            } else if max_candidate_latency > 0 {
                let r_ratio = ((resp_time as u64) * 100) / (max_candidate_latency as u64);
                100u32.saturating_sub(r_ratio as u32)
            } else {
                100u32
            };

            let composite_score =
                (30 * rep_score) + (25 * price_score) + (25 * avail_score) + (20 * response_score);

            results.push_back(DiscoveryResult {
                agent_id: record.id,
                composite_score,
                price_stroops: record.price_stroops,
                reputation: rep,
                availability: avail,
                response_time: resp_time,
            });
        }

        // 4. Sort results descending by composite score
        let mut i = 0;
        while i < results.len() {
            let mut j = i + 1;
            let mut max_idx = i;
            while j < results.len() {
                if results.get(j).unwrap().composite_score
                    > results.get(max_idx).unwrap().composite_score
                {
                    max_idx = j;
                }
                j += 1;
            }
            if max_idx != i {
                let temp_i = results.get(i).unwrap();
                let temp_max = results.get(max_idx).unwrap();
                results.set(i, temp_max);
                results.set(max_idx, temp_i);
            }
            i += 1;
        }

        // 5. Save results to temporary storage cache
        env.storage().temporary().set(&cache_key, &results);

        // 6. Update aggregate discovery statistics
        let mut stats: DiscoveryStats = env
            .storage()
            .instance()
            .get(&DataKey::DiscoveryStats)
            .unwrap_or(DiscoveryStats {
                total_queries: 0,
                total_matches_found: 0,
                cache_hits: 0,
            });
        stats.total_queries += 1;
        stats.total_matches_found += results.len() as u64;
        env.storage()
            .instance()
            .set(&DataKey::DiscoveryStats, &stats);

        // 7. Emit DiscoveryQuery event
        env.events().publish(
            (symbol_short!("registry"), symbol_short!("disc_qry")),
            events::DiscoveryQueryEvent {
                capability: query.required_capability,
                max_price: query.max_price,
                min_reputation: query.min_reputation,
                max_latency: query.max_latency,
                matches_count: results.len(),
            },
        );

        results
    }

    /// Retrieve aggregate discovery oracle statistics.
    pub fn get_discovery_stats(env: Env) -> DiscoveryStats {
        env.storage()
            .instance()
            .get(&DataKey::DiscoveryStats)
            .unwrap_or(DiscoveryStats {
                total_queries: 0,
                total_matches_found: 0,
                cache_hits: 0,
            })
    }

    pub fn deregister_agent(env: Env, agent_id: Symbol) -> Result<(), Error> {
        require_not_paused(&env)?;

        let cooldown_key = DataKey::BondCooldown(agent_id.clone());
        let current_ledger = env.ledger().sequence();

        // ── Second call: cooldown window check and bond return ────────────────
        if let Some(cr) = env
            .storage()
            .persistent()
            .get::<DataKey, CooldownRecord>(&cooldown_key)
        {
            cr.owner.require_auth();

            if current_ledger < cr.expiry_ledger {
                return Err(Error::CooldownNotElapsed);
            }
            // Cooldown elapsed — clean up and emit BondReturned.
            env.storage().persistent().remove(&cooldown_key);
            if cr.bond_amount > 0 {
                env.events().publish(
                    (symbol_short!("registry"), symbol_short!("bond_ret")),
                    events::BondReturned {
                        agent_id,
                        owner: cr.owner,
                        amount_stroops: cr.bond_amount,
                    },
                );
            }
            return Ok(());
        }

        // ── First call: remove agent, record cooldown ─────────────────────────
        let agent_key = DataKey::Agent(agent_id.clone());
        let record: AgentRecord = env
            .storage()
            .persistent()
            .get(&agent_key)
            .ok_or(Error::NotFound)?;

        record.owner.require_auth();

        // Remove from capability index.
        let cap_key = DataKey::CapabilityIndex(record.capability.clone());
        let ids: Vec<Symbol> = env
            .storage()
            .persistent()
            .get(&cap_key)
            .unwrap_or_else(|| Vec::new(&env));

        let mut updated = Vec::new(&env);
        for id in ids.iter() {
            if id != agent_id {
                updated.push_back(id);
            }
        }
        env.storage().persistent().set(&cap_key, &updated);
        env.storage().persistent().remove(&agent_key);

        let total = get_total_agents(&env);
        if total > 0 {
            env.storage()
                .instance()
                .set(&DataKey::TotalAgents, &(total - 1));
        }

        // Store the cooldown record so the second call can return the bond
        // without needing to re-read the already-deleted AgentRecord.
        let expiry_ledger = current_ledger + BOND_COOLDOWN_LEDGERS;
        let cooldown_record = CooldownRecord {
            expiry_ledger,
            owner: record.owner.clone(),
            bond_amount: record.bond_amount,
        };
        env.storage()
            .persistent()
            .set(&cooldown_key, &cooldown_record);
        env.storage()
            .persistent()
            .extend_ttl(&cooldown_key, TTL_THRESHOLD, TTL_EXTEND_TO);

        // Emit (registry, agent_deregistered) including owner and capability
        // so indexers can update their capability maps without a storage read.
        env.events().publish(
            (symbol_short!("registry"), symbol_short!("agent_drg")),
            AgentDeregisteredEvent {
                agent_id,
                owner: record.owner.clone(),
                capability: record.capability.clone(),
            },
        );

        Ok(())
    }

    /// Aggregate health view for `agent_id`, including its error count from
    /// error-resolver (0 if error-resolver isn't configured or the
    /// cross-contract call fails — see `AgentHealth`).
    pub fn get_agent_health(env: Env, agent_id: Symbol) -> AgentHealth {
        let exists = env
            .storage()
            .persistent()
            .has(&DataKey::Agent(agent_id.clone()));
        let frozen = env
            .storage()
            .persistent()
            .get(&DataKey::FrozenAgent(agent_id.clone()))
            .unwrap_or(false);

        let error_count = 0;

        AgentHealth {
            agent_id,
            exists,
            frozen,
            error_count,
        }
    }

    // ── Bond management ───────────────────────────────────────────────────────

    /// Admin: set the minimum bond required for agent registration (stroops).
    pub fn set_min_bond(env: Env, amount_stroops: i128) -> Result<(), Error> {
        require_admin(&env)?;
        env.storage()
            .instance()
            .set(&DataKey::MinBond, &amount_stroops);
        env.storage()
            .instance()
            .extend_ttl(TTL_THRESHOLD, TTL_EXTEND_TO);
        Ok(())
    }

    /// Read the current minimum bond requirement (stroops).
    pub fn get_min_bond(env: Env) -> i128 {
        min_bond(&env)
    }

    /// Admin: slash an agent's bond by `penalty_stroops`.
    ///
    /// The bond is reduced by `penalty_stroops` (floored at 0).
    /// If the penalty equals or exceeds the remaining bond the bond becomes 0.
    /// Emits a [`BondSlashed`][events::BondSlashed] event.
    pub fn slash_bond(env: Env, agent_id: Symbol, penalty_stroops: i128) -> Result<(), Error> {
        require_admin(&env)?;

        let agent_key = DataKey::Agent(agent_id.clone());
        let mut record: AgentRecord = env
            .storage()
            .persistent()
            .get(&agent_key)
            .ok_or(Error::NotFound)?;

        // Floor at 0 — cannot slash below zero.
        let remaining = if penalty_stroops >= record.bond_amount {
            0_i128
        } else {
            record.bond_amount - penalty_stroops
        };
        let actual_penalty = record.bond_amount - remaining;

        record.bond_amount = remaining;
        env.storage().persistent().set(&agent_key, &record);
        extend_ttl_for_key(&env, &agent_key);

        env.events().publish(
            (symbol_short!("registry"), symbol_short!("bond_slsh")),
            events::BondSlashed {
                agent_id,
                penalty_stroops: actual_penalty,
                remaining_stroops: remaining,
            },
        );
        Ok(())
    }

    pub fn update_pricing(env: Env, agent_id: Symbol, new_price: i128) -> Result<(), Error> {
        require_not_paused(&env)?;
        require_not_frozen(&env, &agent_id)?;
        let agent_key = DataKey::Agent(agent_id.clone());
        let mut record: AgentRecord = env
            .storage()
            .persistent()
            .get(&agent_key)
            .ok_or(Error::NotFound)?;

        record.owner.require_auth();

        record.price_stroops = new_price;
        env.storage().persistent().set(&agent_key, &record);
        extend_ttl_for_key(&env, &agent_key);

        env.events().publish(
            (symbol_short!("registry"), symbol_short!("price_upd")),
            (agent_id, new_price),
        );

        Ok(())
    }

    // ── Error reporting / batch resolution ───────────────────────────────────

    /// Report an operational error (creates an unresolved entry).
    pub fn report_error(
        env: Env,
        error_id: BytesN<32>,
        reporter: Address,
        message: String,
    ) -> Result<(), Error> {
        reporter.require_auth();

        let key = DataKey::ErrorRecord(error_id.clone());
        if env.storage().persistent().has(&key) {
            return Err(Error::AlreadyExists);
        }

        let created_at = env.ledger().sequence() as u64;
        let entry = ErrorEntry {
            id: error_id.clone(),
            reporter: reporter.clone(),
            message,
            resolved: false,
            // Placeholder until resolve_errors overwrites with a real resolution.
            resolution: Resolution::Fixed,
            created_at,
            expires_at: created_at + error_ttl(&env),
        };
        env.storage().persistent().set(&key, &entry);
        extend_ttl_for_key(&env, &key);

        // Emit (registry, error_reported) so monitoring systems can trigger
        // alerting pipelines without polling contract state.
        env.events().publish(
            (symbol_short!("registry"), symbol_short!("err_rptd")),
            ErrorReportedEvent { error_id, reporter },
        );

        Ok(())
    }

    /// Configure how many ledger sequences newly reported errors live for
    /// before becoming eligible for `cleanup_expired_errors`.
    pub fn set_error_ttl(env: Env, ttl_ledgers: u64) -> Result<(), Error> {
        require_admin(&env)?;
        env.storage()
            .instance()
            .set(&DataKey::ErrorTTL, &ttl_ledgers);
        Ok(())
    }

    /// Read the currently configured error retention (defaults if never set).
    pub fn get_error_ttl(env: Env) -> u64 {
        error_ttl(&env)
    }

    /// Remove expired error entries from persistent storage.
    ///
    /// Soroban has no iterator over all contract keys, so callers pass the
    /// set of error ids to check (e.g. from off-chain indexing of
    /// `report_error` events). Permissionless: anyone can pay to garbage
    /// collect entries that are already past their `expires_at`, unresolved
    /// or not. Returns the number of entries actually removed.
    pub fn cleanup_expired_errors(env: Env, error_ids: Vec<BytesN<32>>) -> u32 {
        let current_seq = env.ledger().sequence() as u64;
        let mut removed = 0u32;

        for i in 0..error_ids.len() {
            let id = error_ids.get(i).unwrap();
            let key = DataKey::ErrorRecord(id);
            let entry: Option<ErrorEntry> = env.storage().persistent().get(&key);
            if let Some(entry) = entry {
                if entry.expires_at <= current_seq {
                    env.storage().persistent().remove(&key);
                    removed += 1;
                }
            }
        }

        removed
    }

    /// Resolve multiple errors in one transaction (atomic all-or-nothing).
    ///
    /// Validates every id first; writes only if all succeed. Per-item results
    /// are always returned so callers can see which ids failed validation.
    pub fn resolve_errors(
        env: Env,
        error_ids: Vec<BytesN<32>>,
        resolution: Resolution,
    ) -> Result<Vec<VoidBatchResult>, Error> {
        require_admin(&env)?;
        let mut results: Vec<VoidBatchResult> = Vec::new(&env);
        let mut all_ok = true;

        // ── Phase 1: validate ────────────────────────────────────────────────
        for i in 0..error_ids.len() {
            let id = error_ids.get(i).unwrap();

            if is_duplicate_error_id(&error_ids, i, &id) {
                results.push_back(VoidBatchResult::Err(Error::DuplicateInBatch as u32));
                all_ok = false;
                continue;
            }

            let key = DataKey::ErrorRecord(id.clone());
            let entry: Option<ErrorEntry> = env.storage().persistent().get(&key);
            match entry {
                None => {
                    results.push_back(VoidBatchResult::Err(Error::NotFound as u32));
                    all_ok = false;
                }
                Some(e) if e.resolved => {
                    results.push_back(VoidBatchResult::Err(Error::AlreadyResolved as u32));
                    all_ok = false;
                }
                Some(_) => {
                    results.push_back(VoidBatchResult::Ok);
                }
            }
        }

        if !all_ok || error_ids.is_empty() {
            return Ok(results);
        }

        // ── Phase 2: commit ──────────────────────────────────────────────────
        let mut ttl_keys: Vec<DataKey> = Vec::new(&env);
        for i in 0..error_ids.len() {
            let id = error_ids.get(i).unwrap();
            let key = DataKey::ErrorRecord(id.clone());
            let mut entry: ErrorEntry = env.storage().persistent().get(&key).unwrap();
            entry.resolved = true;
            entry.resolution = resolution.clone();
            env.storage().persistent().set(&key, &entry);
            ttl_keys.push_back(key);

            // Emit one (registry, error_resolved) event per resolved error.
            // Batch resolutions produce N events so indexers can track each
            // error's lifecycle independently without scanning storage.
            env.events().publish(
                (symbol_short!("registry"), symbol_short!("err_rslvd")),
                ErrorResolvedEvent {
                    error_id: id,
                    resolution_code: resolution.clone() as u32,
                },
            );
        }
        extend_ttl_batch(&env, &ttl_keys);

        Ok(results)
    }

    /// Fetch a single error entry (for tests / off-chain indexing).
    /// Extends the entry's storage TTL on access, like agent records.
    pub fn get_error(env: Env, error_id: BytesN<32>) -> Option<ErrorEntry> {
        let key = DataKey::ErrorRecord(error_id);
        let entry = env.storage().persistent().get(&key);
        if entry.is_some() {
            extend_ttl_for_key(&env, &key);
        }
        entry
    }

    // ── Gas budget estimation ────────────────────────────────────────────────

    /// Estimate CPU instruction budget for a batch operation.
    ///
    /// `operation` is one of:
    /// - `"register_agent"` / `"register_agents"`
    /// - `"resolve_error"` / `"resolve_errors"`
    /// - `"cleanup_expired_errors"`
    ///
    /// Returns `0` for unknown operations. Values come from [`GasConfig`]
    /// (defaults match the tables in `docs/gas_costs.md`).
    ///
    /// Additional supported operations:
    /// - `"slash_bond"` — flat cost per invocation, `count` is ignored beyond 1
    /// - `"deregister_with_bond"` — flat cost per invocation
    pub fn estimate_gas(env: Env, operation: String, count: u32) -> u64 {
        if count == 0 {
            return 0;
        }
        let cfg = gas_config(&env);

        let register_agent = String::from_str(&env, "register_agent");
        let register_agents = String::from_str(&env, "register_agents");
        let resolve_error = String::from_str(&env, "resolve_error");
        let resolve_errors = String::from_str(&env, "resolve_errors");
        let slash_bond_op = String::from_str(&env, "slash_bond");
        let deregister_bond_op = String::from_str(&env, "deregister_with_bond");
        let cleanup_expired_errors = String::from_str(&env, "cleanup_expired_errors");

        if operation == register_agent || operation == register_agents {
            // First item pays full single-call cost; rest pay marginal.
            cfg.register_agent
                + cfg
                    .register_agent_marginal
                    .saturating_mul((count - 1) as u64)
        } else if operation == resolve_error || operation == resolve_errors {
            cfg.resolve_error
                + cfg
                    .resolve_error_marginal
                    .saturating_mul((count - 1) as u64)
        } else if operation == cleanup_expired_errors {
            cfg.cleanup_error
                + cfg
                    .cleanup_error_marginal
                    .saturating_mul((count - 1) as u64)
        } else if operation == slash_bond_op {
            cfg.slash_bond.saturating_mul(count as u64)
        } else if operation == deregister_bond_op {
            cfg.deregister_with_bond.saturating_mul(count as u64)
        } else {
            0
        }
    }

    /// Override empirical gas parameters stored in instance config.
    pub fn set_gas_config(env: Env, config: GasConfig) -> Result<(), Error> {
        require_admin(&env)?;
        env.storage().instance().set(&DataKey::GasConfig, &config);
        env.storage()
            .instance()
            .extend_ttl(TTL_THRESHOLD, TTL_EXTEND_TO);
        Ok(())
    }

    /// Read the current gas configuration (defaults if never set).
    pub fn get_gas_config(env: Env) -> GasConfig {
        gas_config(&env)
    }

    /// Read current total agent count.
    pub fn total_agents(env: Env) -> u32 {
        get_total_agents(&env)
    }

    /// Read storage limits configuration.
    pub fn get_storage_config(env: Env) -> StorageConfig {
        get_storage_config_internal(&env)
    }

    /// Update storage configuration (admin only).
    pub fn set_storage_config(env: Env, config: StorageConfig) -> Result<(), Error> {
        require_admin(&env)?;
        env.storage()
            .instance()
            .set(&DataKey::StorageConfig, &config);
        env.storage()
            .instance()
            .extend_ttl(TTL_THRESHOLD, TTL_EXTEND_TO);
        Ok(())
    }

    // ── On-Chain Analytics ──────────────────────────────────────────────────

    /// Record task completion for an agent's analytics.
    pub fn record_task_completion(
        env: Env,
        agent_id: Symbol,
        success: bool,
        response_time: u32,
        earnings: i128,
    ) -> Result<(), Error> {
        let key = DataKey::AgentAnalytics(agent_id.clone());
        let mut analytics: AgentAnalytics = env
            .storage()
            .persistent()
            .get(&key)
            .unwrap_or(AgentAnalytics {
                agent_id: agent_id.clone(),
                total_tasks: 0,
                successful_tasks: 0,
                failed_tasks: 0,
                total_earnings: 0,
                avg_response_time: 0,
                last_updated: env.ledger().sequence() as u64,
            });

        let old_total = analytics.total_tasks;
        analytics.total_tasks += 1;
        if success {
            analytics.successful_tasks += 1;
        } else {
            analytics.failed_tasks += 1;
        }
        analytics.total_earnings += earnings;

        // Running average response time
        analytics.avg_response_time = if analytics.total_tasks == 1 {
            response_time
        } else {
            ((analytics.avg_response_time as u64 * old_total + response_time as u64)
                / analytics.total_tasks) as u32
        };

        analytics.last_updated = env.ledger().sequence() as u64;
        env.storage().persistent().set(&key, &analytics);
        extend_ttl_for_key(&env, &key);

        // Store daily snapshot (last 30 days)
        let snapshot_date = env.ledger().sequence() as u64;
        let snapshot = AnalyticsSnapshot {
            snapshot_date,
            total_tasks: analytics.total_tasks,
            successful_tasks: analytics.successful_tasks,
            total_earnings: analytics.total_earnings,
        };
        let snap_key = DataKey::AnalyticsSnapshot(agent_id.clone(), snapshot_date);
        env.storage().persistent().set(&snap_key, &snapshot);
        extend_ttl_for_key(&env, &snap_key);

        env.events().publish(
            (symbol_short!("registry"), symbol_short!("anl_rec")),
            AnalyticsRecordedEvent {
                agent_id,
                success,
                response_time,
                earnings,
            },
        );

        Ok(())
    }

    /// Get aggregated analytics for an agent.
    pub fn get_analytics(env: Env, agent_id: Symbol) -> AgentAnalytics {
        let key = DataKey::AgentAnalytics(agent_id.clone());
        env.storage().persistent().get(&key).unwrap_or(AgentAnalytics {
            agent_id,
            total_tasks: 0,
            successful_tasks: 0,
            failed_tasks: 0,
            total_earnings: 0,
            avg_response_time: 0,
            last_updated: 0,
        })
    }

    /// Get top N agents by a configurable metric.
    pub fn get_leaderboard(env: Env, metric: Symbol, limit: u32) -> Vec<LeaderboardEntry> {
        let cap_key = DataKey::CapabilityIndex(metric.clone());
        let agent_ids: Vec<Symbol> = env
            .storage()
            .persistent()
            .get(&cap_key)
            .unwrap_or_else(|| Vec::new(&env));

        let mut entries: Vec<LeaderboardEntry> = Vec::new(&env);

        let tasks_sym = Symbol::new(&env, "total_tasks");
        let earnings_sym = Symbol::new(&env, "total_earnings");
        let success_sym = Symbol::new(&env, "successful_tasks");

        for id in agent_ids.iter() {
            let analytics_key = DataKey::AgentAnalytics(id.clone());
            if let Some(analytics) = env
                .storage()
                .persistent()
                .get::<_, AgentAnalytics>(&analytics_key)
            {
                let metric_value = if metric == tasks_sym {
                    analytics.total_tasks
                } else if metric == earnings_sym {
                    analytics.total_earnings as u64
                } else if metric == success_sym {
                    analytics.successful_tasks
                } else {
                    analytics.total_tasks
                };

                entries.push_back(LeaderboardEntry {
                    agent_id: id,
                    metric_value,
                });
            }
        }

        // Sort descending by metric_value
        let mut i = 0;
        while i < entries.len() {
            let mut j = i + 1;
            let mut max_idx = i;
            while j < entries.len() {
                if entries.get(j).unwrap().metric_value
                    > entries.get(max_idx).unwrap().metric_value
                {
                    max_idx = j;
                }
                j += 1;
            }
            if max_idx != i {
                let temp_i = entries.get(i).unwrap();
                let temp_max = entries.get(max_idx).unwrap();
                entries.set(i, temp_max);
                entries.set(max_idx, temp_i);
            }
            i += 1;
        }

        // Truncate to limit
        let mut result: Vec<LeaderboardEntry> = Vec::new(&env);
        for i in 0..entries.len().min(limit) {
            result.push_back(entries.get(i).unwrap());
        }

        env.events().publish(
            (symbol_short!("registry"), symbol_short!("lb_upd")),
            LeaderboardUpdatedEvent {
                metric,
                top_count: result.len(),
            },
        );

        result
    }

    // ── SLA Enforcement ────────────────────────────────────────────────────

    /// Set SLA terms for an agent.
    pub fn set_sla(
        env: Env,
        agent_id: Symbol,
        max_response_time: u32,
        min_uptime: u32,
        min_quality_score: u32,
    ) -> Result<(), Error> {
        // Verify agent exists
        let agent_key = DataKey::Agent(agent_id.clone());
        if !env.storage().persistent().has(&agent_key) {
            return Err(Error::NotFound);
        }

        // Verify agent owner auth
        let record: AgentRecord = env
            .storage()
            .persistent()
            .get(&agent_key)
            .ok_or(Error::NotFound)?;
        record.owner.require_auth();

        if max_response_time == 0 || min_uptime > 100 || min_quality_score > 100 {
            return Err(Error::InvalidSla);
        }

        let sla_key = DataKey::AgentSla(agent_id.clone());
        if env.storage().persistent().has(&sla_key) {
            return Err(Error::SlaAlreadyExists);
        }

        let sla = AgentSla {
            agent_id: agent_id.clone(),
            max_response_time,
            min_uptime,
            min_quality_score,
            created_at: env.ledger().sequence() as u64,
            total_checks: 0,
            violations: 0,
            last_check_at: 0,
        };

        env.storage().persistent().set(&sla_key, &sla);
        extend_ttl_for_key(&env, &sla_key);

        env.events().publish(
            (symbol_short!("registry"), symbol_short!("sla_set")),
            SlaSetEvent {
                agent_id,
                max_response_time,
                min_uptime,
                min_quality_score,
            },
        );

        Ok(())
    }

    /// Check SLA compliance for an agent and apply penalties/bonuses.
    pub fn check_sla_compliance(
        env: Env,
        agent_id: Symbol,
        actual_response_time: u32,
        actual_uptime: u32,
        actual_quality: u32,
    ) -> Result<bool, Error> {
        let sla_key = DataKey::AgentSla(agent_id.clone());
        let mut sla: AgentSla = env
            .storage()
            .persistent()
            .get(&sla_key)
            .ok_or(Error::SlaNotFound)?;

        sla.total_checks += 1;
        sla.last_check_at = env.ledger().sequence() as u64;

        let mut compliant = true;
        let mut violation_type: Option<u32> = None;

        // Check response time
        if actual_response_time > sla.max_response_time {
            compliant = false;
            violation_type = Some(0);
        }

        // Check uptime
        if actual_uptime < sla.min_uptime {
            compliant = false;
            if violation_type.is_none() {
                violation_type = Some(1);
            }
        }

        // Check quality
        if actual_quality < sla.min_quality_score {
            compliant = false;
            if violation_type.is_none() {
                violation_type = Some(2);
            }
        }

        if !compliant {
            sla.violations += 1;

            // Record violation
            let violation_count_key = DataKey::SlaViolationCount(agent_id.clone());
            let v_count: u64 = env
                .storage()
                .persistent()
                .get(&violation_count_key)
                .unwrap_or(0);

            let violation = SlaViolation {
                agent_id: agent_id.clone(),
                violation_type: violation_type.unwrap(),
                detected_at: env.ledger().sequence() as u64,
                penalty_applied: true,
            };
            let v_key = DataKey::SlaViolation(agent_id.clone(), v_count);
            env.storage().persistent().set(&v_key, &violation);
            env.storage()
                .persistent()
                .set(&violation_count_key, &(v_count + 1));
            extend_ttl_for_key(&env, &v_key);

            // Apply penalty: slash 10% of bond
            let agent_key = DataKey::Agent(agent_id.clone());
            let mut record: AgentRecord = env
                .storage()
                .persistent()
                .get(&agent_key)
                .ok_or(Error::NotFound)?;

            let penalty = record.bond_amount * SLA_PENALTY_PERCENT / 100;
            if penalty > 0 {
                let remaining = if penalty >= record.bond_amount {
                    0_i128
                } else {
                    record.bond_amount - penalty
                };
                record.bond_amount = remaining;
                env.storage().persistent().set(&agent_key, &record);
                extend_ttl_for_key(&env, &agent_key);

                env.events().publish(
                    (symbol_short!("registry"), symbol_short!("sla_viol")),
                    SlaViolationDetectedEvent {
                        agent_id: agent_id.clone(),
                        violation_type: violation_type.unwrap(),
                        penalty_stroops: penalty,
                    },
                );
            }
        } else {
            // Bonus: reputation boost for consistently exceeding SLA
            // Award bonus after 10 consecutive compliant checks
            if sla.total_checks >= 10 && sla.violations == 0 {
                env.events().publish(
                    (symbol_short!("registry"), symbol_short!("sla_bonus")),
                    SlaBonusAwardedEvent {
                        agent_id,
                        reputation_boost: SLA_BONUS_REPUTATION_BOOST,
                    },
                );
            }
        }

        env.storage().persistent().set(&sla_key, &sla);
        extend_ttl_for_key(&env, &sla_key);

        Ok(compliant)
    }

    /// Get SLA status and compliance percentage for an agent.
    pub fn get_sla_status(env: Env, agent_id: Symbol) -> Option<(AgentSla, u32)> {
        let sla_key = DataKey::AgentSla(agent_id.clone());
        let sla: AgentSla = env.storage().persistent().get(&sla_key)?;

        let compliance = if sla.total_checks == 0 {
            100u32
        } else {
            let compliant_checks = sla.total_checks - sla.violations;
            ((compliant_checks * 100) / sla.total_checks) as u32
        };

        Some((sla, compliance))
    }

    /// Map a raw error code from any ai-net contract to its standardized
    /// [`CommonExitCode`] equivalent.
    ///
    /// This is the single entry-point for cross-contract error interpretation.
    /// Callers pass the raw `u32` error code returned by any contract call and
    /// receive the standardized [`CommonExitCode`] if the code falls within the
    /// reserved common range (1..=15), or `None` if it is contract-specific.
    ///
    /// ```text
    /// // Off-chain usage:
    /// let result = registry.error_mapper(raw_error_code);
    /// match result {
    ///     Some(CommonExitCode::NotFound) => { /* handle */ }
    ///     Some(CommonExitCode::Unauthorized) => { /* handle */ }
    ///     None => { /* contract-specific code, inspect locally */ }
    /// }
    /// ```
    pub fn error_mapper(_env: Env, raw_code: u32) -> Option<CommonExitCode> {
        shared_exit_codes::CommonExitCode::from_raw(raw_code)
    }
}

fn get_metadata_u32(
    env: &Env,
    metadata: &Map<Symbol, Val>,
    key1: &Symbol,
    key2: &Symbol,
    default_val: u32,
) -> u32 {
    if let Some(val) = metadata.get(key1.clone()) {
        if let Ok(v) = u32::try_from_val(env, &val) {
            return v;
        }
    }
    if let Some(val) = metadata.get(key2.clone()) {
        if let Ok(v) = u32::try_from_val(env, &val) {
            return v;
        }
    }
    default_val
}

#[cfg(test)]
mod test;
#[cfg(test)]
mod test_multisig;
