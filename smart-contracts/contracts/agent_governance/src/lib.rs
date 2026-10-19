#![no_std]

//! # Agent Governance Contract
//!
//! On-chain governance for the agent network. Registered agents are
//! stakeholders: they stake value and carry a reputation score, and together
//! those determine their **voting power**. Agents create governance proposals
//! and vote `For`, `Against`, or `Abstain`. After a time-limited voting period
//! anyone can call [`execute_proposal`](AgentGovernanceContract::execute_proposal),
//! which checks quorum and majority and marks the proposal `Executed` or
//! `Failed`.
//!
//! ## Flow
//!
//! 1. **`initialize`** — set the governance admin (one-time).
//! 2. **`register_agent`** — an agent registers with a reputation score and a
//!    stake amount. Voting power = `stake + reputation * REPUTATION_POWER_UNIT`.
//!    The electorate's total voting power is tracked in aggregate.
//! 3. **`create_proposal`** — a registered agent opens a proposal
//!    (`ParameterChange`, `AgentDispute`, or `ProtocolUpgrade`) with a
//!    configurable voting period (default 7 days). The current total voting
//!    power is snapshotted into the proposal.
//! 4. **`vote_on_proposal`** — registered agents cast exactly one vote each,
//!    weighted by their voting power **at the proposal's creation timestamp**
//!    (the same snapshot point used for the quorum denominator).
//! 5. **`execute_proposal`** — after the deadline, quorum and majority are
//!    evaluated. A passing proposal's payload is invoked on its target; the
//!    proposal is `Executed` only if the invocation succeeds, otherwise it is
//!    `Failed`.
//! 6. **`remove_agent`** — an agent unlocks its stake and leaves the
//!    electorate, reducing the aggregate voting power.
//!
//! ## Admin model
//!
//! The admin set in `initialize` is enforced by `require_admin`. It gates
//! `set_admin` (which also needs the incoming admin's auth), `pause`,
//! `unpause`, and `set_param_registry`. While paused, proposal creation and
//! voting are rejected with `ContractPaused`; execution of already-closed
//! proposals is still allowed.
//!
//! ## Passing Rules
//!
//! * **Quorum** — `(for + against + abstain) power >= 30%` of the snapshotted
//!   total voting power.
//! * **Majority** — `for power > 50%` of decisive power (`for + against`;
//!   abstentions excluded). A proposal with zero decisive votes fails.

mod errors;
mod types;

pub use errors::Error;
pub use types::{
    voting_power, AgentInfo, DataKey, ExecutionPayload, PowerCheckpoint, Proposal, QueuedProposal,
    ProposalCreatedEvent, ProposalExecutedEvent, ProposalFailedEvent, ProposalStatus, ProposalType,
    VoteCastEvent, VoteChoice, VoteRecord, BPS_DENOMINATOR, DEFAULT_VOTING_PERIOD_SECS,
    MAJORITY_BPS, MAX_CALLDATA_LEN, MAX_CHECKPOINTS, MAX_REPUTATION, MAX_VOTING_PERIOD_SECS,
    MIN_VOTING_PERIOD_SECS, QUORUM_BPS, REPUTATION_POWER_UNIT, PROPOSAL_TIMELOCK_SECS,
};

use soroban_sdk::{
    contract, contractimpl, symbol_short, vec, Address, Bytes, BytesN, Env, IntoVal, String, Val,
    Vec,
};

// ─── TTL constants (mirrored from agent_registry) ────────────────────────────

/// Threshold (ledgers remaining) below which we extend.
const TTL_THRESHOLD: u32 = 100_000;
/// Target TTL after extension (~31 days at 5s ledgers).
const TTL_EXTEND_TO: u32 = 535_680;

// ─── Helpers ─────────────────────────────────────────────────────────────────

fn extend_ttl_for_key(env: &Env, key: &DataKey) {
    if env.storage().persistent().has(key) {
        env.storage()
            .persistent()
            .extend_ttl(key, TTL_THRESHOLD, TTL_EXTEND_TO);
    }
}

fn require_initialized(env: &Env) -> Result<(), Error> {
    if env.storage().instance().has(&DataKey::Admin) {
        Ok(())
    } else {
        Err(Error::NotInitialized)
    }
}

/// Load the admin and require its authorisation.
fn require_admin(env: &Env) -> Result<Address, Error> {
    let admin: Address = env
        .storage()
        .instance()
        .get(&DataKey::Admin)
        .ok_or(Error::NotInitialized)?;
    admin.require_auth();
    Ok(admin)
}

fn require_not_paused(env: &Env) -> Result<(), Error> {
    let paused: bool = env
        .storage()
        .instance()
        .get(&DataKey::Paused)
        .unwrap_or(false);
    if paused {
        Err(Error::ContractPaused)
    } else {
        Ok(())
    }
}

/// Append a power checkpoint for `agent` at the current ledger timestamp.
/// A checkpoint at the same timestamp is overwritten; history is bounded to
/// [`MAX_CHECKPOINTS`] entries (oldest pruned first).
fn write_checkpoint(env: &Env, agent: &Address, power: i128) {
    let key = DataKey::Checkpoints(agent.clone());
    let mut cps: Vec<PowerCheckpoint> = env
        .storage()
        .persistent()
        .get(&key)
        .unwrap_or_else(|| Vec::new(env));
    let now = env.ledger().timestamp();
    let cp = PowerCheckpoint {
        timestamp: now,
        power,
    };
    match cps.last() {
        Some(last) if last.timestamp == now => cps.set(cps.len() - 1, cp),
        _ => cps.push_back(cp),
    }
    while cps.len() > MAX_CHECKPOINTS {
        cps.pop_front();
    }
    env.storage().persistent().set(&key, &cps);
    extend_ttl_for_key(env, &key);
}

/// Voting power of `agent` as of ledger timestamp `at` (0 if none recorded).
fn power_at(env: &Env, agent: &Address, at: u64) -> i128 {
    let cps: Vec<PowerCheckpoint> = env
        .storage()
        .persistent()
        .get(&DataKey::Checkpoints(agent.clone()))
        .unwrap_or_else(|| Vec::new(env));
    let mut i = cps.len();
    while i > 0 {
        i -= 1;
        let cp = cps.get_unchecked(i);
        if cp.timestamp <= at {
            return cp.power;
        }
    }
    0
}

/// A target must be a contract address other than this governance contract.
fn validate_target(env: &Env, target: &Address) -> Result<(), Error> {
    if *target == env.current_contract_address() {
        return Err(Error::InvalidTarget);
    }
    let strkey = target.to_string();
    if strkey.len() != 56 {
        return Err(Error::InvalidTarget);
    }
    let mut buf = [0u8; 56];
    strkey.copy_into_slice(&mut buf);
    if buf[0] != b'C' {
        return Err(Error::InvalidTarget);
    }
    Ok(())
}

fn calldata_hash(env: &Env, calldata: &Bytes) -> BytesN<32> {
    env.crypto().sha256(calldata).into()
}

fn load_agent(env: &Env, agent: &Address) -> Result<AgentInfo, Error> {
    env.storage()
        .persistent()
        .get(&DataKey::Agent(agent.clone()))
        .ok_or(Error::AgentNotRegistered)
}

fn total_power(env: &Env) -> i128 {
    env.storage()
        .instance()
        .get(&DataKey::TotalPower)
        .unwrap_or(0)
}

fn verify_agent_eligibility(env: &Env, agent_id: &soroban_sdk::Symbol) -> Result<(), Error> {
    let registry: Option<Address> = env.storage().instance().get(&DataKey::AgentRegistry);
    let registry_addr = match registry {
        Some(addr) => addr,
        None => return Ok(()),
    };

    use soroban_sdk::{vec, IntoVal, InvokeError, Symbol, Val};
    let fn_name = Symbol::new(env, "verify_agent_eligible");
    let args = vec![env, agent_id.into_val(env)];

    let res: Result<Result<Val, _>, Result<InvokeError, InvokeError>> =
        env.try_invoke_contract(&registry_addr, &fn_name, args);

    match res {
        Ok(Ok(_)) => Ok(()),
        Err(Ok(InvokeError::Contract(code))) | Err(Err(InvokeError::Contract(code))) => {
            match code {
                1 => Err(Error::AgentNotFound),
                5 => Err(Error::AgentFrozen),
                10 => Err(Error::InsufficientBond),
                36 => Err(Error::AgentDeregistered),
                _ => Err(Error::AgentNotEligible),
            }
        }
        _ => Err(Error::AgentNotEligible),
    }
}

// ─── Contract ────────────────────────────────────────────────────────────────

#[contract]
pub struct AgentGovernanceContract;

#[contractimpl]
impl AgentGovernanceContract {
    // ── Initialisation ───────────────────────────────────────────────────

    /// Set the governance admin. Callable exactly once.
    pub fn initialize(env: Env, admin: Address) -> Result<(), Error> {
        if env.storage().instance().has(&DataKey::Admin) {
            return Err(Error::AlreadyInitialized);
        }
        admin.require_auth();
        env.storage().instance().set(&DataKey::Admin, &admin);
        env.storage().instance().set(&DataKey::TotalPower, &0i128);
        env.storage().instance().set(&DataKey::ProposalCount, &0u64);
        env.storage().instance().set(&DataKey::Paused, &false);
        Ok(())
    }

    // ── Admin ────────────────────────────────────────────────────────────

    /// Return the current governance admin.
    pub fn get_admin(env: Env) -> Result<Address, Error> {
        env.storage()
            .instance()
            .get(&DataKey::Admin)
            .ok_or(Error::NotInitialized)
    }

    /// Transfer the admin role. Requires auth from **both** the current admin
    /// and `new_admin`, so the role can never be handed to an address that
    /// cannot sign.
    pub fn set_admin(env: Env, new_admin: Address) -> Result<(), Error> {
        let old = require_admin(&env)?;
        new_admin.require_auth();
        env.storage().instance().set(&DataKey::Admin, &new_admin);
        env.events().publish(
            (symbol_short!("gov"), symbol_short!("admin_set")),
            (old, new_admin),
        );
        Ok(())
    }

    /// Pause proposal creation and voting. Admin only.
    pub fn pause(env: Env) -> Result<(), Error> {
        let admin = require_admin(&env)?;
        env.storage().instance().set(&DataKey::Paused, &true);
        env.events()
            .publish((symbol_short!("gov"), symbol_short!("paused")), admin);
        Ok(())
    }

    /// Resume proposal creation and voting. Admin only.
    pub fn unpause(env: Env) -> Result<(), Error> {
        let admin = require_admin(&env)?;
        env.storage().instance().set(&DataKey::Paused, &false);
        env.events()
            .publish((symbol_short!("gov"), symbol_short!("unpaused")), admin);
        Ok(())
    }

    /// Whether proposal creation and voting are currently paused.
    pub fn is_paused(env: Env) -> bool {
        env.storage()
            .instance()
            .get(&DataKey::Paused)
            .unwrap_or(false)
    }

    /// Set the parameter registry that `ParameterChange` proposals target.
    /// Admin only; the registry must be a contract address.
    pub fn set_param_registry(env: Env, registry: Address) -> Result<(), Error> {
        require_admin(&env)?;
        validate_target(&env, &registry)?;
        env.storage()
            .instance()
            .set(&DataKey::ParamRegistry, &registry);
        Ok(())
    }

    /// Return the configured parameter registry, if any.
    pub fn get_param_registry(env: Env) -> Option<Address> {
        env.storage().instance().get(&DataKey::ParamRegistry)
    }

    /// Set the agent registry contract address.
    pub fn set_agent_registry(env: Env, registry: Address) -> Result<(), Error> {
        let admin: Address = env
            .storage()
            .instance()
            .get(&DataKey::Admin)
            .ok_or(Error::NotInitialized)?;
        admin.require_auth();
        env.storage()
            .instance()
            .set(&DataKey::AgentRegistry, &registry);
        Ok(())
    }

    // ── Agent registration ───────────────────────────────────────────────

    /// Register `agent` as a stakeholder with a reputation score and stake.
    ///
    /// * `reputation` — must be in `[0, 100]`.
    /// * `stake` — must be `>= 0`.
    ///
    /// Voting power is `stake + reputation * REPUTATION_POWER_UNIT` and is
    /// added to the electorate's aggregate total. The agent must authorise.
    pub fn register_agent(
        env: Env,
        agent: Address,
        reputation: u32,
        stake: i128,
    ) -> Result<(), Error> {
        require_initialized(&env)?;
        agent.require_auth();
        verify_agent_eligibility(&env, &soroban_sdk::Symbol::new(&env, "agent"))?;

        if reputation > MAX_REPUTATION {
            return Err(Error::InvalidReputation);
        }
        if stake < 0 {
            return Err(Error::InvalidStake);
        }

        let key = DataKey::Agent(agent.clone());
        if env.storage().persistent().has(&key) {
            return Err(Error::AgentAlreadyRegistered);
        }

        let power = voting_power(stake, reputation);
        if power <= 0 {
            return Err(Error::ZeroVotingPower);
        }

        let info = AgentInfo {
            agent: agent.clone(),
            reputation,
            stake,
            power,
        };
        env.storage().persistent().set(&key, &info);
        extend_ttl_for_key(&env, &key);

        write_checkpoint(&env, &agent, power);

        let new_total = total_power(&env).saturating_add(power);
        env.storage()
            .instance()
            .set(&DataKey::TotalPower, &new_total);

        env.events().publish(
            (symbol_short!("gov"), symbol_short!("agent_reg")),
            (agent, power),
        );

        Ok(())
    }

    /// Update an already-registered agent's reputation and/or stake.
    ///
    /// The aggregate total voting power is adjusted by the delta. The agent
    /// must authorise the call.
    pub fn update_agent(
        env: Env,
        agent: Address,
        reputation: u32,
        stake: i128,
    ) -> Result<(), Error> {
        require_initialized(&env)?;
        agent.require_auth();

        if reputation > MAX_REPUTATION {
            return Err(Error::InvalidReputation);
        }
        if stake < 0 {
            return Err(Error::InvalidStake);
        }

        let key = DataKey::Agent(agent.clone());
        let mut info = load_agent(&env, &agent)?;

        let new_power = voting_power(stake, reputation);
        if new_power <= 0 {
            return Err(Error::ZeroVotingPower);
        }

        let delta = new_power - info.power;
        info.reputation = reputation;
        info.stake = stake;
        info.power = new_power;
        env.storage().persistent().set(&key, &info);
        extend_ttl_for_key(&env, &key);

        write_checkpoint(&env, &agent, new_power);

        let new_total = total_power(&env).saturating_add(delta).max(0);
        env.storage()
            .instance()
            .set(&DataKey::TotalPower, &new_total);

        env.events().publish(
            (symbol_short!("gov"), symbol_short!("agent_upd")),
            (agent, new_power),
        );

        Ok(())
    }

    /// Remove `agent` from the electorate, unlocking its declared stake.
    ///
    /// The agent's power is subtracted from the aggregate total and a zero
    /// power checkpoint is recorded, so `TotalPower` shrinks as agents leave.
    /// Proposals created before removal keep their snapshots, but a removed
    /// agent can no longer vote. The agent must authorise.
    pub fn remove_agent(env: Env, agent: Address) -> Result<(), Error> {
        require_initialized(&env)?;
        agent.require_auth();

        let info = load_agent(&env, &agent)?;
        env.storage()
            .persistent()
            .remove(&DataKey::Agent(agent.clone()));
        write_checkpoint(&env, &agent, 0);

        let new_total = total_power(&env).saturating_sub(info.power).max(0);
        env.storage()
            .instance()
            .set(&DataKey::TotalPower, &new_total);

        env.events().publish(
            (symbol_short!("gov"), symbol_short!("agent_rm")),
            (agent, info.power),
        );

        Ok(())
    }

    // ── Proposals ────────────────────────────────────────────────────────

    /// Create a governance proposal. The `proposer` must be a registered
    /// agent and must authorise the call.
    ///
    /// * `voting_period_secs` — `0` uses [`DEFAULT_VOTING_PERIOD_SECS`]
    ///   (7 days); otherwise must be within
    ///   `[MIN_VOTING_PERIOD_SECS, MAX_VOTING_PERIOD_SECS]`.
    ///
    /// * `payload` — execution payload. `ProtocolUpgrade` requires a target;
    ///   `ParameterChange` always targets the configured parameter registry;
    ///   `AgentDispute` may be signal-only (`target: None`). `calldata` is
    ///   bounded by [`MAX_CALLDATA_LEN`] and, if `expected_hash` is given, must
    ///   hash to it.
    ///
    /// Returns the new proposal id. Emits `(gov, created)`.
    pub fn create_proposal(
        env: Env,
        proposer: Address,
        proposal_type: ProposalType,
        title: String,
        description: String,
        voting_period_secs: u64,
        payload: ExecutionPayload,
    ) -> Result<u64, Error> {
        require_initialized(&env)?;
        require_not_paused(&env)?;
        proposer.require_auth();

        // Proposer must be a stakeholder.
        load_agent(&env, &proposer)?;

        if title.is_empty() || description.is_empty() {
            return Err(Error::EmptyMetadata);
        }

        let period = if voting_period_secs == 0 {
            DEFAULT_VOTING_PERIOD_SECS
        } else {
            voting_period_secs
        };
        if !(MIN_VOTING_PERIOD_SECS..=MAX_VOTING_PERIOD_SECS).contains(&period) {
            return Err(Error::InvalidVotingPeriod);
        }

        if payload.calldata.len() > MAX_CALLDATA_LEN {
            return Err(Error::CalldataTooLarge);
        }
        let hash = calldata_hash(&env, &payload.calldata);
        if let Some(expected) = &payload.expected_hash {
            if *expected != hash {
                return Err(Error::PayloadHashMismatch);
            }
        }

        let target = match proposal_type {
            ProposalType::ParameterChange => {
                let registry: Address = env
                    .storage()
                    .instance()
                    .get(&DataKey::ParamRegistry)
                    .ok_or(Error::RegistryNotSet)?;
                if let Some(t) = &payload.target {
                    if *t != registry {
                        return Err(Error::InvalidTarget);
                    }
                }
                Some(registry)
            }
            ProposalType::ProtocolUpgrade => {
                let t = payload.target.clone().ok_or(Error::InvalidTarget)?;
                validate_target(&env, &t)?;
                Some(t)
            }
            ProposalType::AgentDispute => {
                if let Some(t) = &payload.target {
                    validate_target(&env, t)?;
                }
                payload.target.clone()
            }
        };

        let snapshot = total_power(&env);
        if snapshot <= 0 {
            return Err(Error::ZeroVotingPower);
        }

        let id: u64 = env
            .storage()
            .instance()
            .get(&DataKey::ProposalCount)
            .unwrap_or(0)
            + 1;

        let now = env.ledger().timestamp();
        let proposal = Proposal {
            id,
            proposer: proposer.clone(),
            proposal_type: proposal_type.clone(),
            title,
            description,
            created_at: now,
            voting_ends_at: now.saturating_add(period),
            status: ProposalStatus::Active,
            for_power: 0,
            against_power: 0,
            abstain_power: 0,
            total_power_snapshot: snapshot,
            target,
            function: payload.function,
            calldata: payload.calldata,
            expected_hash: Some(hash),
        };

        let key = DataKey::Proposal(id);
        env.storage().persistent().set(&key, &proposal);
        extend_ttl_for_key(&env, &key);
        env.storage().instance().set(&DataKey::ProposalCount, &id);

        env.events().publish(
            (symbol_short!("gov"), symbol_short!("created")),
            ProposalCreatedEvent {
                id,
                proposer,
                proposal_type,
                voting_ends_at: proposal.voting_ends_at,
                total_power_snapshot: snapshot,
            },
        );

        Ok(id)
    }

    /// Cast a vote on an active proposal. The `voter` must be a registered
    /// agent, must authorise the call, and must not have voted already.
    ///
    /// The vote weight is the agent's voting power at the proposal's
    /// creation timestamp (the same snapshot used for quorum), so power
    /// changes after creation do not affect this proposal. Emits
    /// `(gov, vote_cast)`.
    pub fn vote_on_proposal(
        env: Env,
        proposal_id: u64,
        voter: Address,
        choice: VoteChoice,
    ) -> Result<(), Error> {
        require_initialized(&env)?;
        require_not_paused(&env)?;
        voter.require_auth();

        load_agent(&env, &voter)?;

        let prop_key = DataKey::Proposal(proposal_id);
        let mut proposal: Proposal = env
            .storage()
            .persistent()
            .get(&prop_key)
            .ok_or(Error::NotFound)?;

        if proposal.status != ProposalStatus::Active {
            return Err(Error::ProposalNotActive);
        }
        if env.ledger().timestamp() >= proposal.voting_ends_at {
            return Err(Error::VotingPeriodEnded);
        }

        let vote_key = DataKey::Vote(proposal_id, voter.clone());
        if env.storage().persistent().has(&vote_key) {
            return Err(Error::AlreadyVoted);
        }

        let weight = power_at(&env, &voter, proposal.created_at);
        if weight <= 0 {
            return Err(Error::NoSnapshotPower);
        }
        match choice {
            VoteChoice::For => proposal.for_power = proposal.for_power.saturating_add(weight),
            VoteChoice::Against => {
                proposal.against_power = proposal.against_power.saturating_add(weight)
            }
            VoteChoice::Abstain => {
                proposal.abstain_power = proposal.abstain_power.saturating_add(weight)
            }
        }

        let record = VoteRecord {
            proposal_id,
            voter: voter.clone(),
            choice,
            weight,
        };
        env.storage().persistent().set(&vote_key, &record);
        extend_ttl_for_key(&env, &vote_key);
        env.storage().persistent().set(&prop_key, &proposal);
        extend_ttl_for_key(&env, &prop_key);

        env.events().publish(
            (symbol_short!("gov"), symbol_short!("vote_cast")),
            VoteCastEvent {
                proposal_id,
                voter,
                choice,
                weight,
            },
        );

        Ok(())
    }

    /// Evaluate proposal vote after voting period ends. If it passes,
    /// queue it for execution after the 48-hour timelock. Callable by anyone.
    ///
    /// Evaluates quorum (>= 30 % of snapshotted total power cast) and majority
    /// (> 50 % of decisive `for + against` power). If the vote passes, the
    /// proposal is placed in the timelock queue and can be executed only after
    /// PROPOSAL_TIMELOCK_SECS (48 hours) have elapsed.
    pub fn queue_proposal(env: Env, proposal_id: u64) -> Result<(), Error> {
        require_initialized(&env)?;

        let prop_key = DataKey::Proposal(proposal_id);
        let proposal: Proposal = env
            .storage()
            .persistent()
            .get(&prop_key)
            .ok_or(Error::NotFound)?;

        if proposal.status != ProposalStatus::Active {
            return Err(Error::ProposalFinalized);
        }
        if env.ledger().timestamp() < proposal.voting_ends_at {
            return Err(Error::VotingPeriodActive);
        }

        let cast_power = proposal
            .for_power
            .saturating_add(proposal.against_power)
            .saturating_add(proposal.abstain_power);
        let decisive_power = proposal.for_power.saturating_add(proposal.against_power);

        let quorum_met = proposal.total_power_snapshot > 0
            && cast_power.saturating_mul(BPS_DENOMINATOR)
                >= proposal.total_power_snapshot.saturating_mul(QUORUM_BPS);

        let majority_met = decisive_power > 0
            && proposal.for_power.saturating_mul(BPS_DENOMINATOR)
                > decisive_power.saturating_mul(MAJORITY_BPS);

        let vote_passed = quorum_met && majority_met;

        if !vote_passed {
            let mut proposal_mut = proposal.clone();
            proposal_mut.status = ProposalStatus::Failed;
            env.storage().persistent().set(&prop_key, &proposal_mut);
            extend_ttl_for_key(&env, &prop_key);
            env.events().publish(
                (symbol_short!("gov"), symbol_short!("failed")),
                ProposalFailedEvent {
                    id: proposal_id,
                    quorum_met,
                    majority_met,
                    execution_failed: false,
                    for_power: proposal.for_power,
                    against_power: proposal.against_power,
                    abstain_power: proposal.abstain_power,
                },
            );
            return Ok(());
        }

        let now = env.ledger().timestamp();
        let can_execute_at = now.saturating_add(PROPOSAL_TIMELOCK_SECS);

        let queued = QueuedProposal {
            proposal_id,
            passed_at: now,
            can_execute_at,
        };

        let queue_key = DataKey::QueuedProposal(proposal_id);
        env.storage().persistent().set(&queue_key, &queued);
        extend_ttl_for_key(&env, &queue_key);

        let mut proposal_mut = proposal.clone();
        proposal_mut.status = ProposalStatus::Queued;
        env.storage().persistent().set(&prop_key, &proposal_mut);
        extend_ttl_for_key(&env, &prop_key);

        env.events().publish(
            (symbol_short!("gov"), symbol_short!("queued")),
            (proposal_id, can_execute_at),
        );

        Ok(())
    }

    /// Execute a queued proposal after its timelock has elapsed. Callable by anyone.
    ///
    /// The proposal must be in the Queued state and at least PROPOSAL_TIMELOCK_SECS
    /// (48 hours) must have passed since it was queued. The payload is invoked from
    /// this contract. The status becomes `Executed` only if the vote passed and the
    /// invocation succeeded; otherwise it becomes `Failed`.
    pub fn execute_proposal(env: Env, proposal_id: u64) -> Result<ProposalStatus, Error> {
        require_initialized(&env)?;

        let queue_key = DataKey::QueuedProposal(proposal_id);
        let queued: QueuedProposal = env
            .storage()
            .persistent()
            .get(&queue_key)
            .ok_or(Error::NotFound)?;

        let now = env.ledger().timestamp();
        if now < queued.can_execute_at {
            return Err(Error::VotingPeriodActive);
        }

        let prop_key = DataKey::Proposal(proposal_id);
        let mut proposal: Proposal = env
            .storage()
            .persistent()
            .get(&prop_key)
            .ok_or(Error::NotFound)?;

        if proposal.status != ProposalStatus::Queued {
            return Err(Error::ProposalFinalized);
        }

        let mut execution_failed = false;
        if let Some(target) = proposal.target.clone() {
            let hash = calldata_hash(&env, &proposal.calldata);
            if proposal.expected_hash.as_ref() != Some(&hash) {
                return Err(Error::PayloadHashMismatch);
            }
            let args: Vec<Val> = vec![&env, proposal.calldata.clone().into_val(&env)];
            let res = env.try_invoke_contract::<Val, soroban_sdk::Error>(
                &target,
                &proposal.function,
                args,
            );
            execution_failed = !matches!(res, Ok(Ok(_)));
        }

        let passed = !execution_failed;
        proposal.status = if passed {
            ProposalStatus::Executed
        } else {
            ProposalStatus::Failed
        };
        env.storage().persistent().set(&prop_key, &proposal);
        extend_ttl_for_key(&env, &prop_key);

        env.storage().persistent().remove(&queue_key);

        if passed {
            env.events().publish(
                (symbol_short!("gov"), symbol_short!("executed")),
                ProposalExecutedEvent {
                    id: proposal_id,
                    for_power: proposal.for_power,
                    against_power: proposal.against_power,
                    abstain_power: proposal.abstain_power,
                },
            );
        } else {
            env.events().publish(
                (symbol_short!("gov"), symbol_short!("failed")),
                ProposalFailedEvent {
                    id: proposal_id,
                    quorum_met: true,
                    majority_met: true,
                    execution_failed,
                    for_power: proposal.for_power,
                    against_power: proposal.against_power,
                    abstain_power: proposal.abstain_power,
                },
            );
        }

        Ok(proposal.status)
    }

    /// Cancel a queued proposal before its timelock elapses. Admin only.
    pub fn cancel_proposal(env: Env, proposal_id: u64) -> Result<(), Error> {
        require_admin(&env)?;

        let queue_key = DataKey::QueuedProposal(proposal_id);
        if !env.storage().persistent().has(&queue_key) {
            return Err(Error::NotFound);
        }

        env.storage().persistent().remove(&queue_key);

        let prop_key = DataKey::Proposal(proposal_id);
        if let Some(mut proposal) = env
            .storage()
            .persistent()
            .get::<_, Proposal>(&prop_key)
        {
            proposal.status = ProposalStatus::Failed;
            env.storage().persistent().set(&prop_key, &proposal);
            extend_ttl_for_key(&env, &prop_key);
        }

        env.events().publish(
            (symbol_short!("gov"), symbol_short!("cancelled")),
            proposal_id,
        );

        Ok(())
    }

    // ── View functions ──────────────────────────────────────────────────

    /// Return the proposal record for `id`, if it exists.
    pub fn get_proposal(env: Env, id: u64) -> Option<Proposal> {
        env.storage().persistent().get(&DataKey::Proposal(id))
    }

    /// Return a specific agent's vote on a proposal, if cast.
    pub fn get_vote(env: Env, proposal_id: u64, voter: Address) -> Option<VoteRecord> {
        env.storage()
            .persistent()
            .get(&DataKey::Vote(proposal_id, voter))
    }

    /// Return the registration record for an agent, if registered.
    pub fn get_agent(env: Env, agent: Address) -> Option<AgentInfo> {
        env.storage().persistent().get(&DataKey::Agent(agent))
    }

    /// Return the electorate's aggregate voting power.
    pub fn get_total_voting_power(env: Env) -> i128 {
        total_power(&env)
    }

    /// Return the number of proposals created so far.
    pub fn get_proposal_count(env: Env) -> u64 {
        env.storage()
            .instance()
            .get(&DataKey::ProposalCount)
            .unwrap_or(0)
    }
}

#[cfg(test)]
mod test;
