#![no_std]

//! # Dispute Resolution Contract
//!
//! A bounded, multi-phase dispute workflow. A task ID is also the dispute ID,
//! so filing is idempotent and the settlement event can be correlated with the
//! task's escrow by off-chain payment coordinators.

mod errors;
pub mod gas;
mod types;

pub use errors::Error;
pub use types::*;

use soroban_sdk::{
    contract, contractclient, contractimpl, contracttype, symbol_short, Address, BytesN, Env, Map,
    String, Symbol, Val, Vec,
};

/// Evidence phase duration: 48 hours.
pub const EVIDENCE_PHASE: u64 = 48 * 60 * 60;
/// Voting phase duration: 72 hours.
pub const VOTING_PHASE: u64 = 72 * 60 * 60;
/// Maximum configured voter pool, keeping per-dispute tally work bounded.
pub const MAX_VOTERS: u32 = 50;
/// Maximum evidence records per dispute, keeping persistent storage bounded.
pub const MAX_EVIDENCE_PER_DISPUTE: u32 = 20;
/// Minimum votes required for a non-neutral ruling.
pub const MINIMUM_VOTES: u32 = 3;
/// Maximum length of a dispute reason, in bytes.
pub const MAX_REASON_BYTES: u32 = 512;
/// Window after the first ruling in which the losing party may appeal.
pub const APPEAL_PHASE: u64 = 24 * 60 * 60;
const TTL_THRESHOLD: u32 = 50_000;
const TTL_EXTEND_TO: u32 = 241_920;

#[contractclient(name = "AgentRegistryClient")]
pub trait AgentRegistryInterface {
    fn lock_bond_for_dispute(env: Env, caller: Address, agent_id: Symbol);
    fn release_bond_after_dispute(env: Env, caller: Address, agent_id: Symbol);
    fn slash_bond_from_dispute(
        env: Env,
        caller: Address,
        agent_id: Symbol,
        percentage: u32,
        reason: String,
    ) -> i128;
}

#[contracttype]
#[derive(Clone)]
pub enum DataKey {
    Admin,
    Paused,
    Dispute(Symbol),
    Evidence(Symbol, u32),
    EvidenceCount(Symbol),
    Vote(Symbol, Address),
    VoterReputation(Address),
    AgentBond(Address),
    AgentRegistryId(Address),
    AgentReputation(Address),
    FilerReputation(Address),
    TaskEscrow(Symbol),
    ActiveVoters,
    AgentRegistry,
    AppealVote(Symbol, Address),
    VoteRound(Symbol),
}

#[contract]
pub struct DisputeResolutionContract;

fn require_admin(env: &Env) -> Result<Address, Error> {
    let admin: Address = env
        .storage()
        .instance()
        .get(&DataKey::Admin)
        .ok_or(Error::Unauthorized)?;
    admin.require_auth();
    Ok(admin)
}

fn require_not_paused(env: &Env) -> Result<(), Error> {
    if env
        .storage()
        .instance()
        .get::<_, bool>(&DataKey::Paused)
        .unwrap_or(false)
    {
        return Err(Error::ContractPaused);
    }
    Ok(())
}

fn load_dispute(env: &Env, dispute_id: &Symbol) -> Result<Dispute, Error> {
    env.storage()
        .persistent()
        .get(&DataKey::Dispute(dispute_id.clone()))
        .ok_or(Error::NotFound)
}

fn save_dispute(env: &Env, dispute: &Dispute) {
    let key = DataKey::Dispute(dispute.task_id.clone());
    env.storage().persistent().set(&key, dispute);
    env.storage()
        .persistent()
        .extend_ttl(&key, TTL_THRESHOLD, TTL_EXTEND_TO);
}

fn extend_ttl(env: &Env, key: &DataKey) {
    env.storage()
        .persistent()
        .extend_ttl(key, TTL_THRESHOLD, TTL_EXTEND_TO);
}

fn start_voting(env: &Env, dispute: &mut Dispute) {
    if dispute.status != DisputeStatus::Voting {
        dispute.status = DisputeStatus::Voting;
        save_dispute(env, dispute);
        env.events().publish(
            (symbol_short!("dispute"), symbol_short!("voting")),
            dispute.task_id.clone(),
        );
    }
}

fn current_vote_key(env: &Env, dispute_id: &Symbol, voter: &Address) -> DataKey {
    if env
        .storage()
        .persistent()
        .get::<_, u32>(&DataKey::VoteRound(dispute_id.clone()))
        .unwrap_or(0)
        == 0
    {
        DataKey::Vote(dispute_id.clone(), voter.clone())
    } else {
        DataKey::AppealVote(dispute_id.clone(), voter.clone())
    }
}

fn apply_final_ruling(
    env: &Env,
    dispute: &mut Dispute,
    outcome: &DisputeOutcome,
) -> Result<(), Error> {
    let registry = AgentRegistryClient::new(env, &dispute.registry_address);
    if *outcome == DisputeOutcome::SupportFiler {
        let bond_key = DataKey::AgentBond(dispute.agent_id.clone());
        let cached_bond: i128 = env.storage().persistent().get(&bond_key).unwrap_or(0);
        let reason = String::from_str(env, "verified dispute upheld");
        dispute.bond_slashed = registry.slash_bond_from_dispute(
            &env.current_contract_address(),
            &dispute.registry_agent_id,
            &50,
            &reason,
        );
        env.storage()
            .persistent()
            .set(&bond_key, &cached_bond.saturating_sub(dispute.bond_slashed));
        let reputation_key = DataKey::AgentReputation(dispute.agent_id.clone());
        let reputation: u32 = env.storage().persistent().get(&reputation_key).unwrap_or(0);
        env.storage()
            .persistent()
            .set(&reputation_key, &reputation.saturating_sub(1));
        env.storage().persistent().set(
            &DataKey::VoterReputation(dispute.agent_id.clone()),
            &reputation.saturating_sub(1),
        );
    } else {
        registry.release_bond_after_dispute(
            &env.current_contract_address(),
            &dispute.registry_agent_id,
        );
    }

    if *outcome == DisputeOutcome::SupportAgent {
        let reputation_key = DataKey::FilerReputation(dispute.filer.clone());
        let reputation: u32 = env.storage().persistent().get(&reputation_key).unwrap_or(0);
        env.storage()
            .persistent()
            .set(&reputation_key, &reputation.saturating_sub(1));
        env.storage().persistent().set(
            &DataKey::VoterReputation(dispute.filer.clone()),
            &reputation.saturating_sub(1),
        );
    }

    dispute.status = DisputeStatus::Resolved;
    save_dispute(env, dispute);
    env.events().publish(
        (symbol_short!("dispute"), symbol_short!("resolved")),
        DisputeResolvedEvent {
            dispute_id: dispute.task_id.clone(),
            outcome: outcome.clone(),
            filer_votes: dispute.filer_votes,
            agent_votes: dispute.agent_votes,
            filer_refund: dispute.filer_refund,
            agent_payment: dispute.agent_payment,
            bond_slashed: dispute.bond_slashed,
        },
    );
    Ok(())
}

#[contractimpl]
impl DisputeResolutionContract {
    /// Initialize the contract once.
    pub fn initialize(env: Env, admin: Address) -> Result<(), Error> {
        admin.require_auth();
        if env.storage().instance().has(&DataKey::Admin) {
            return Err(Error::AlreadyExists);
        }
        env.storage().instance().set(&DataKey::Admin, &admin);
        env.storage().instance().set(&DataKey::Paused, &false);
        env.events().publish(
            (symbol_short!("dispute"), symbol_short!("init")),
            (admin, env.ledger().sequence()),
        );
        Ok(())
    }

    /// Admin: transfer admin rights. Requires authorization from both current and new admin.
    pub fn set_admin(env: Env, new_admin: Address) -> Result<(), Error> {
        require_not_paused(&env)?;
        let old_admin = require_admin(&env)?;
        new_admin.require_auth();
        env.storage().instance().set(&DataKey::Admin, &new_admin);

        env.events().publish(
            (symbol_short!("dispute"), symbol_short!("adm_chng")),
            AdminChangedEvent {
                old_admin,
                new_admin,
            },
        );
        Ok(())
    }

    /// Returns the current admin address.
    pub fn get_admin(env: Env) -> Option<Address> {
        env.storage().instance().get(&DataKey::Admin)
    }

    /// Admin: pause.
    pub fn pause(env: Env) -> Result<(), Error> {
        require_admin(&env)?;
        env.storage().instance().set(&DataKey::Paused, &true);
        env.events()
            .publish((symbol_short!("dispute"), symbol_short!("paused")), ());
        Ok(())
    }

    pub fn unpause(env: Env) -> Result<(), Error> {
        require_admin(&env)?;
        env.storage().instance().set(&DataKey::Paused, &false);
        env.events()
            .publish((symbol_short!("dispute"), symbol_short!("unpaused")), ());
        Ok(())
    }

    pub fn is_paused(env: Env) -> bool {
        env.storage()
            .instance()
            .get(&DataKey::Paused)
            .unwrap_or(false)
    }

    /// Configure the bounded pool of registered voters. Their reputation must
    /// be set to at least 3 with `set_reputation` before they can vote.
    pub fn set_voters(env: Env, voters: Vec<Address>) -> Result<(), Error> {
        require_not_paused(&env)?;
        require_admin(&env)?;
        if voters.is_empty() || voters.len() > MAX_VOTERS {
            return Err(Error::InvalidVoterPool);
        }
        for (index, voter) in voters.iter().enumerate() {
            if voters.iter().skip(index + 1).any(|other| other == voter) {
                return Err(Error::InvalidVoterPool);
            }
        }
        env.storage()
            .instance()
            .set(&DataKey::ActiveVoters, &voters);
        env.events().publish(
            (symbol_short!("dispute"), symbol_short!("voters")),
            voters.len(),
        );
        Ok(())
    }

    /// Set the registry-sourced reputation used for voter eligibility and
    /// ruling consequences. Reputation is bounded to 0..=100.
    pub fn set_reputation(env: Env, account: Address, reputation: u32) -> Result<(), Error> {
        require_not_paused(&env)?;
        require_admin(&env)?;
        if reputation > 100 {
            return Err(Error::InvalidReputation);
        }
        env.storage()
            .persistent()
            .set(&DataKey::VoterReputation(account.clone()), &reputation);
        env.storage()
            .persistent()
            .set(&DataKey::AgentReputation(account.clone()), &reputation);
        env.storage()
            .persistent()
            .set(&DataKey::FilerReputation(account), &reputation);
        Ok(())
    }

    /// Record a bond snapshot for provisional ruling details. Final slashes
    /// are computed from the registry's live bond balance.
    pub fn set_agent_bond(env: Env, agent_id: Address, bond_amount: i128) -> Result<(), Error> {
        require_not_paused(&env)?;
        require_admin(&env)?;
        if bond_amount < 0 {
            return Err(Error::InvalidAmount);
        }
        env.storage()
            .persistent()
            .set(&DataKey::AgentBond(agent_id.clone()), &bond_amount);
        extend_ttl(&env, &DataKey::AgentBond(agent_id));
        Ok(())
    }

    /// Admin: configure the registry contract that owns agent bond records.
    pub fn set_agent_registry(env: Env, registry: Address) -> Result<(), Error> {
        require_not_paused(&env)?;
        require_admin(&env)?;
        env.storage()
            .instance()
            .set(&DataKey::AgentRegistry, &registry);
        Ok(())
    }

    /// Admin: map the dispute-party address to its registry agent identifier.
    pub fn set_agent_registry_id(
        env: Env,
        agent: Address,
        registry_agent_id: Symbol,
    ) -> Result<(), Error> {
        require_not_paused(&env)?;
        require_admin(&env)?;
        env.storage()
            .persistent()
            .set(&DataKey::AgentRegistryId(agent.clone()), &registry_agent_id);
        extend_ttl(&env, &DataKey::AgentRegistryId(agent));
        Ok(())
    }

    /// Record escrow associated with a task. The final `resolved` event supplies
    /// destination amounts to the configured payment coordinator.
    pub fn set_task_escrow(env: Env, task_id: Symbol, amount: i128) -> Result<(), Error> {
        require_not_paused(&env)?;
        require_admin(&env)?;
        if amount < 0 {
            return Err(Error::InvalidAmount);
        }
        if env
            .storage()
            .persistent()
            .has(&DataKey::Dispute(task_id.clone()))
        {
            return Err(Error::AlreadyExists);
        }
        env.storage()
            .persistent()
            .set(&DataKey::TaskEscrow(task_id.clone()), &amount);
        extend_ttl(&env, &DataKey::TaskEscrow(task_id));
        Ok(())
    }

    /// File a dispute. The task ID is the unique dispute ID and the agent ID is
    /// the agent's Stellar address, allowing evidence authorization on-chain.
    pub fn file_dispute(
        env: Env,
        task_id: Symbol,
        filer: Address,
        agent_id: Address,
        reason: String,
    ) -> Result<Symbol, Error> {
        require_not_paused(&env)?;
        filer.require_auth();
        if reason.is_empty() || reason.len() > MAX_REASON_BYTES {
            return Err(Error::InvalidReason);
        }
        let key = DataKey::Dispute(task_id.clone());
        if env.storage().persistent().has(&key) {
            return Err(Error::AlreadyExists);
        }
        let voters: Vec<Address> = env
            .storage()
            .instance()
            .get(&DataKey::ActiveVoters)
            .unwrap_or_else(|| Vec::new(&env));
        if voters.len() < MINIMUM_VOTES {
            return Err(Error::NoVotersAvailable);
        }
        let registry_address: Address = env
            .storage()
            .instance()
            .get(&DataKey::AgentRegistry)
            .ok_or(Error::Unauthorized)?;
        let registry_agent_id: Symbol = env
            .storage()
            .persistent()
            .get(&DataKey::AgentRegistryId(agent_id.clone()))
            .ok_or(Error::Unauthorized)?;
        extend_ttl(&env, &DataKey::AgentRegistryId(agent_id.clone()));
        let escrow_key = DataKey::TaskEscrow(task_id.clone());
        if env.storage().persistent().has(&escrow_key) {
            extend_ttl(&env, &escrow_key);
        }
        let bond_key = DataKey::AgentBond(agent_id.clone());
        if env.storage().persistent().has(&bond_key) {
            extend_ttl(&env, &bond_key);
        }
        AgentRegistryClient::new(&env, &registry_address)
            .lock_bond_for_dispute(&env.current_contract_address(), &registry_agent_id);
        let now = env.ledger().timestamp();
        let evidence_deadline = now.saturating_add(EVIDENCE_PHASE);
        let dispute = Dispute {
            task_id: task_id.clone(),
            filer: filer.clone(),
            agent_id: agent_id.clone(),
            registry_address: registry_address.clone(),
            registry_agent_id: registry_agent_id.clone(),
            reason,
            status: DisputeStatus::EvidencePhase,
            filed_at: now,
            evidence_deadline,
            voting_deadline: evidence_deadline.saturating_add(VOTING_PHASE),
            voters,
            resolution: None,
            appeal_deadline: None,
            appealed: false,
            filer_votes: 0,
            agent_votes: 0,
            bond_slashed: 0,
            filer_refund: 0,
            agent_payment: 0,
        };
        save_dispute(&env, &dispute);
        env.storage()
            .persistent()
            .set(&DataKey::EvidenceCount(task_id.clone()), &0u32);
        extend_ttl(&env, &DataKey::EvidenceCount(task_id.clone()));
        env.events().publish(
            (symbol_short!("dispute"), symbol_short!("filed")),
            DisputeFiledEvent {
                dispute_id: task_id.clone(),
                filer,
                agent_id,
            },
        );
        env.events().publish(
            (symbol_short!("dispute"), symbol_short!("evidence")),
            task_id.clone(),
        );
        Ok(task_id)
    }

    /// Submit evidence during the 48-hour evidence phase. Only either dispute
    /// party may submit evidence, and each submission is recorded persistently.
    pub fn submit_evidence(
        env: Env,
        dispute_id: Symbol,
        submitter: Address,
        evidence_hash: BytesN<32>,
    ) -> Result<u32, Error> {
        require_not_paused(&env)?;
        submitter.require_auth();
        let mut dispute = load_dispute(&env, &dispute_id)?;
        let now = env.ledger().timestamp();
        if now >= dispute.evidence_deadline || dispute.status == DisputeStatus::Resolved {
            return Err(Error::DisputeExpired);
        }
        if submitter != dispute.filer && submitter != dispute.agent_id {
            return Err(Error::Unauthorized);
        }
        let count_key = DataKey::EvidenceCount(dispute_id.clone());
        let evidence_id: u32 = env.storage().persistent().get(&count_key).unwrap_or(0);
        if evidence_id >= MAX_EVIDENCE_PER_DISPUTE {
            return Err(Error::EvidenceLimitReached);
        }
        let evidence = Evidence {
            dispute_id: dispute_id.clone(),
            evidence_id,
            submitter: submitter.clone(),
            evidence_hash: evidence_hash.clone(),
            submitted_at: now,
        };
        env.storage().persistent().set(
            &DataKey::Evidence(dispute_id.clone(), evidence_id),
            &evidence,
        );
        env.storage()
            .persistent()
            .set(&count_key, &evidence_id.saturating_add(1));
        extend_ttl(&env, &DataKey::Evidence(dispute_id.clone(), evidence_id));
        extend_ttl(&env, &count_key);
        if dispute.status == DisputeStatus::Filed {
            dispute.status = DisputeStatus::EvidencePhase;
            save_dispute(&env, &dispute);
        }
        env.events().publish(
            (symbol_short!("dispute"), symbol_short!("evidence")),
            EvidenceSubmittedEvent {
                dispute_id,
                evidence_id,
                submitter,
                evidence_hash,
                submitted_at: now,
                evidence_index: evidence_id,
            },
        );
        Ok(evidence_id)
    }

    /// Cast one vote during the 72-hour voting phase. A voter must be in the
    /// registered voter pool and have reputation of at least 3.
    pub fn vote(
        env: Env,
        dispute_id: Symbol,
        voter: Address,
        ruling: VoteSide,
    ) -> Result<(), Error> {
        require_not_paused(&env)?;
        voter.require_auth();
        let mut dispute = load_dispute(&env, &dispute_id)?;
        let now = env.ledger().timestamp();
        if dispute.status == DisputeStatus::Resolved {
            return Err(Error::DisputeAlreadyResolved);
        }
        if now < dispute.evidence_deadline {
            return Err(Error::InvalidPhase);
        }
        if now >= dispute.voting_deadline {
            return Err(Error::DisputeExpired);
        }
        if !dispute.voters.contains(&voter)
            || env
                .storage()
                .persistent()
                .get::<_, u32>(&DataKey::VoterReputation(voter.clone()))
                .unwrap_or(0)
                < 3
        {
            return Err(Error::NotEligibleVoter);
        }
        let vote_key = current_vote_key(&env, &dispute_id, &voter);
        if env.storage().persistent().has(&vote_key) {
            return Err(Error::AlreadyVoted);
        }
        if dispute.status != DisputeStatus::Voting {
            start_voting(&env, &mut dispute);
        }
        let vote = Vote {
            dispute_id: dispute_id.clone(),
            voter: voter.clone(),
            ruling: ruling.clone(),
            voted_at: now,
        };
        env.storage().persistent().set(&vote_key, &vote);
        extend_ttl(&env, &vote_key);
        env.events().publish(
            (symbol_short!("dispute"), symbol_short!("vote")),
            VoteCastEvent {
                dispute_id,
                voter,
                ruling,
            },
        );
        Ok(())
    }

    /// Record the outcome after a voting round. The first outcome is provisional;
    /// an unappealed ruling must be finalized after its appeal window.
    ///
    /// Resolution is only permitted once the voting window has closed, i.e.
    /// `now >= voting_deadline`. Calling earlier returns
    /// [`Error::VotingStillOpen`]; calling on a finalized dispute returns
    /// [`Error::DisputeAlreadyResolved`].
    pub fn resolve(env: Env, dispute_id: Symbol) -> Result<DisputeOutcome, Error> {
        let mut dispute = load_dispute(&env, &dispute_id)?;
        if dispute.status == DisputeStatus::Resolved {
            return Err(Error::DisputeAlreadyResolved);
        }
        if dispute.status == DisputeStatus::AppealPending {
            return Err(Error::InvalidPhase);
        }
        let now = env.ledger().timestamp();
        if now < dispute.voting_deadline {
            return Err(Error::VotingStillOpen);
        }
        if dispute.status != DisputeStatus::Voting {
            start_voting(&env, &mut dispute);
        }

        let mut filer_votes = 0u32;
        let mut agent_votes = 0u32;
        for voter in dispute.voters.iter() {
            if let Some(vote) = env.storage().persistent().get::<_, Vote>(&current_vote_key(
                &env,
                &dispute_id,
                &voter,
            )) {
                match vote.ruling {
                    VoteSide::SupportFiler => filer_votes += 1,
                    VoteSide::SupportAgent => agent_votes += 1,
                }
            }
        }

        let escrow = env
            .storage()
            .persistent()
            .get::<_, i128>(&DataKey::TaskEscrow(dispute.task_id.clone()))
            .unwrap_or(0);
        let outcome = if filer_votes + agent_votes < MINIMUM_VOTES || filer_votes == agent_votes {
            dispute.filer_refund = escrow / 2;
            dispute.agent_payment = escrow - dispute.filer_refund;
            DisputeOutcome::Tie
        } else if filer_votes > agent_votes {
            dispute.filer_refund = escrow;
            let bond_key = DataKey::AgentBond(dispute.agent_id.clone());
            let bond: i128 = env.storage().persistent().get(&bond_key).unwrap_or(0);
            dispute.bond_slashed = bond / 2;
            DisputeOutcome::SupportFiler
        } else {
            dispute.agent_payment = escrow;
            DisputeOutcome::SupportAgent
        };

        let round = env
            .storage()
            .persistent()
            .get::<_, u32>(&DataKey::VoteRound(dispute_id.clone()))
            .unwrap_or(0);
        if round == 0 {
            let deadline = now.saturating_add(APPEAL_PHASE);
            dispute.status = DisputeStatus::AppealPending;
            dispute.appeal_deadline = Some(deadline);
            save_dispute(&env, &dispute);
            env.events().publish(
                (symbol_short!("dispute"), symbol_short!("proposed")),
                DisputeResolvedEvent {
                    dispute_id: dispute_id.clone(),
                    outcome: outcome.clone(),
                    filer_votes,
                    agent_votes,
                    filer_refund: dispute.filer_refund,
                    agent_payment: dispute.agent_payment,
                    bond_slashed: dispute.bond_slashed,
                },
            );
        } else {
            apply_final_ruling(&env, &mut dispute, &outcome)?;
        }
        Ok(outcome)
    }

    /// The losing party may request one appeal during the first ruling's
    /// appeal window. The appeal receives a fresh bounded voting round.
    ///
    /// Only a dispute carrying a provisional ruling (`AppealPending`) can be
    /// appealed. A dispute with no ruling yet (`Filed`, `EvidencePhase`,
    /// `Voting`) returns [`Error::NotResolved`]; a finalized dispute
    /// (`Resolved`) returns [`Error::DisputeAlreadyResolved`].
    pub fn appeal_dispute(
        env: Env,
        dispute_id: Symbol,
        appellant: Address,
    ) -> Result<(), Error> {
        require_not_paused(&env)?;
        appellant.require_auth();
        let mut dispute = load_dispute(&env, &dispute_id)?;
        match dispute.status {
            DisputeStatus::AppealPending => {}
            DisputeStatus::Resolved => return Err(Error::DisputeAlreadyResolved),
            DisputeStatus::Filed | DisputeStatus::EvidencePhase | DisputeStatus::Voting => {
                return Err(Error::NotResolved)
            }
        }
        if dispute.appealed {
            return Err(Error::AppealAlreadyFiled);
        }
        let deadline = dispute.appeal_deadline.ok_or(Error::AppealExpired)?;
        let now = env.ledger().timestamp();
        if now >= deadline {
            return Err(Error::AppealExpired);
        }
        let losing_party = match dispute.resolution {
            Some(0) => dispute.agent_id.clone(),
            Some(1) => dispute.filer.clone(),
            _ => return Err(Error::Unauthorized),
        };
        if appellant != losing_party {
            return Err(Error::Unauthorized);
        }

        env.storage()
            .persistent()
            .set(&DataKey::VoteRound(dispute_id.clone()), &1u32);
        extend_ttl(&env, &DataKey::VoteRound(dispute_id.clone()));
        dispute.status = DisputeStatus::Voting;
        dispute.appealed = true;
        dispute.evidence_deadline = now;
        dispute.voting_deadline = now.saturating_add(VOTING_PHASE);
        dispute.resolution = None;
        dispute.filer_votes = 0;
        dispute.agent_votes = 0;
        dispute.bond_slashed = 0;
        dispute.filer_refund = 0;
        dispute.agent_payment = 0;
        save_dispute(&env, &dispute);
        env.events().publish(
            (symbol_short!("dispute"), symbol_short!("appealed")),
            (dispute_id, appellant),
        );
        Ok(())
    }

    /// Finalize an unappealed ruling after its appeal window expires. This is
    /// the only path that emits settlement amounts for the escrow coordinator.
    pub fn finalize_dispute(env: Env, dispute_id: Symbol) -> Result<(), Error> {
        let mut dispute = load_dispute(&env, &dispute_id)?;
        if dispute.status != DisputeStatus::AppealPending {
            return Err(Error::InvalidPhase);
        }
        if dispute.appealed {
            return Err(Error::InvalidPhase);
        }
        let deadline = dispute.appeal_deadline.ok_or(Error::AppealExpired)?;
        if env.ledger().timestamp() < deadline {
            return Err(Error::InvalidPhase);
        }
        let outcome = match dispute.resolution {
            Some(0) => DisputeOutcome::SupportFiler,
            Some(1) => DisputeOutcome::SupportAgent,
            Some(2) => DisputeOutcome::Tie,
            _ => return Err(Error::InvalidPhase),
        };
        apply_final_ruling(&env, &mut dispute, &outcome)
    }

    pub fn get_dispute(env: Env, dispute_id: Symbol) -> Option<Dispute> {
        env.storage()
            .persistent()
            .get(&DataKey::Dispute(dispute_id))
    }

    pub fn get_evidence_count(env: Env, dispute_id: Symbol) -> u32 {
        env.storage()
            .persistent()
            .get(&DataKey::EvidenceCount(dispute_id))
            .unwrap_or(0)
    }

    /// Estimate the CPU-instruction cost of `operation` for a dispute with
    /// `juror_count` jurors. Backed by the calibrated model in [`gas`].
    pub fn estimate_gas(_env: Env, operation: Symbol, juror_count: u32) -> u64 {
        gas::estimate(operation, juror_count)
    }

    pub fn get_evidence(env: Env, dispute_id: Symbol, evidence_id: u32) -> Option<Evidence> {
        env.storage()
            .persistent()
            .get(&DataKey::Evidence(dispute_id, evidence_id))
    }

    pub fn get_vote(env: Env, dispute_id: Symbol, voter: Address) -> Option<Vote> {
        env.storage()
            .persistent()
            .get(&current_vote_key(&env, &dispute_id, &voter))
    }

    pub fn get_reputation(env: Env, account: Address) -> u32 {
        env.storage()
            .persistent()
            .get(&DataKey::VoterReputation(account))
            .unwrap_or(0)
    }

    pub fn get_agent_bond(env: Env, agent_id: Address) -> i128 {
        env.storage()
            .persistent()
            .get(&DataKey::AgentBond(agent_id))
            .unwrap_or(0)
    }
}

impl gas_interface::GasEstimator for DisputeResolutionContract {
    fn estimate(operation: Symbol, params: Map<Symbol, Val>) -> u64 {
        gas::estimate(operation, params.len())
    }
}

#[cfg(test)]
mod test;
