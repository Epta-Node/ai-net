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
//!    weighted by their current voting power.
//! 5. **`execute_proposal`** — after the deadline, quorum and majority are
//!    evaluated and the proposal is finalised.
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
    voting_power, AgentInfo, DataKey, Proposal, ProposalCreatedEvent, ProposalExecutedEvent,
    ProposalFailedEvent, ProposalStatus, ProposalType, VoteCastEvent, VoteChoice, VoteRecord,
    BPS_DENOMINATOR, DEFAULT_VOTING_PERIOD_SECS, MAJORITY_BPS, MAX_REPUTATION,
    MAX_VOTING_PERIOD_SECS, MIN_VOTING_PERIOD_SECS, QUORUM_BPS, REPUTATION_POWER_UNIT,
};

use soroban_sdk::{contract, contractimpl, symbol_short, Address, Env, String};

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

    // ── Proposals ────────────────────────────────────────────────────────

    /// Create a governance proposal. The `proposer` must be a registered
    /// agent and must authorise the call.
    ///
    /// * `voting_period_secs` — `0` uses [`DEFAULT_VOTING_PERIOD_SECS`]
    ///   (7 days); otherwise must be within
    ///   `[MIN_VOTING_PERIOD_SECS, MAX_VOTING_PERIOD_SECS]`.
    ///
    /// Returns the new proposal id. Emits `(gov, created)`.
    pub fn create_proposal(
        env: Env,
        proposer: Address,
        proposal_type: ProposalType,
        title: String,
        description: String,
        voting_period_secs: u64,
    ) -> Result<u64, Error> {
        require_initialized(&env)?;
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
    /// The vote weight is the agent's current voting power. Emits
    /// `(gov, vote_cast)`.
    pub fn vote_on_proposal(
        env: Env,
        proposal_id: u64,
        voter: Address,
        choice: VoteChoice,
    ) -> Result<(), Error> {
        require_initialized(&env)?;
        voter.require_auth();

        let agent = load_agent(&env, &voter)?;

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

        let weight = agent.power;
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

    /// Finalise a proposal after its voting period has ended. Callable by
    /// anyone.
    ///
    /// Evaluates quorum (>= 30 % of snapshotted total power cast) and majority
    /// (> 50 % of decisive `for + against` power). On success the status
    /// becomes `Executed` and `(gov, executed)` is emitted; otherwise the
    /// status becomes `Failed` and `(gov, failed)` is emitted.
    pub fn execute_proposal(env: Env, proposal_id: u64) -> Result<ProposalStatus, Error> {
        require_initialized(&env)?;

        let prop_key = DataKey::Proposal(proposal_id);
        let mut proposal: Proposal = env
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

        // Quorum: cast_power / snapshot >= QUORUM_BPS / BPS_DENOMINATOR.
        let quorum_met = proposal.total_power_snapshot > 0
            && cast_power.saturating_mul(BPS_DENOMINATOR)
                >= proposal.total_power_snapshot.saturating_mul(QUORUM_BPS);

        // Majority: for_power / decisive_power > MAJORITY_BPS / BPS_DENOMINATOR.
        let majority_met = decisive_power > 0
            && proposal.for_power.saturating_mul(BPS_DENOMINATOR)
                > decisive_power.saturating_mul(MAJORITY_BPS);

        let passed = quorum_met && majority_met;
        proposal.status = if passed {
            ProposalStatus::Executed
        } else {
            ProposalStatus::Failed
        };
        env.storage().persistent().set(&prop_key, &proposal);
        extend_ttl_for_key(&env, &prop_key);

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
                    quorum_met,
                    majority_met,
                    for_power: proposal.for_power,
                    against_power: proposal.against_power,
                    abstain_power: proposal.abstain_power,
                },
            );
        }

        Ok(proposal.status)
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
