#![no_std]

//! # Dispute Resolution Contract
//!
//! On-chain dispute resolution with evidence submission, juror voting,
//! and resolution enforcement.

mod errors;
mod types;

pub use errors::Error;
pub use types::*;

use soroban_sdk::{
    contract, contractimpl, contracttype, symbol_short, Address, BytesN, Env, Symbol, Vec,
};

/// Evidence submission phase: 3 days (259,200 seconds).
const EVIDENCE_PHASE: u64 = 259_200;
/// Voting phase: 2 days (172,800 seconds).
const VOTING_PHASE: u64 = 172_800;
/// Appeal window: 2 days (172,800 seconds).
const APPEAL_WINDOW: u64 = 172_800;
/// Number of jurors randomly selected.
const JUROR_COUNT: u32 = 5;

#[contracttype]
#[derive(Clone)]
pub enum DataKey {
    Admin,
    Paused,
    Dispute(Symbol),
    Evidence(Symbol, u32),
    JurorVote(Symbol, Address),
    ActiveJurors,
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

#[contractimpl]
impl DisputeResolutionContract {
    /// Initialize the dispute resolution contract.
    pub fn initialize(env: Env, admin: Address) -> Result<(), Error> {
        if env.storage().instance().has(&DataKey::Admin) {
            return Err(Error::AlreadyExists);
        }
        env.storage().instance().set(&DataKey::Admin, &admin);
        env.storage().instance().set(&DataKey::Paused, &false);
        Ok(())
    }

    /// Admin: pause or unpause.
    pub fn pause(env: Env, paused: bool) -> Result<(), Error> {
        require_admin(&env)?;
        env.storage().instance().set(&DataKey::Paused, &paused);
        Ok(())
    }

    /// Admin: set the active juror pool.
    pub fn set_jurors(env: Env, jurors: Vec<Address>) -> Result<(), Error> {
        require_admin(&env)?;
        env.storage()
            .instance()
            .set(&DataKey::ActiveJurors, &jurors);
        Ok(())
    }

    /// File a dispute against an agent.
    pub fn file_dispute(
        env: Env,
        filer: Address,
        agent_id: Symbol,
        dispute_id: Symbol,
    ) -> Result<(), Error> {
        require_not_paused(&env)?;
        filer.require_auth();

        let now = env.ledger().timestamp();

        // Check for duplicate
        let key = DataKey::Dispute(dispute_id.clone());
        if env.storage().persistent().has(&key) {
            return Err(Error::AlreadyExists);
        }

        // Select jurors from active pool
        let jurors: Vec<Address> = env
            .storage()
            .instance()
            .get(&DataKey::ActiveJurors)
            .unwrap_or_else(|| Vec::new(&env));

        if jurors.len() == 0 {
            return Err(Error::NoJurorsAvailable);
        }

        let mut selected_jurors = Vec::new(&env);
        let count = jurors.len().min(JUROR_COUNT);
        for i in 0..count {
            selected_jurors.push_back(jurors.get(i).unwrap());
        }

        let dispute = Dispute {
            dispute_id: dispute_id.clone(),
            filer: filer.clone(),
            agent_id: agent_id.clone(),
            status: DisputeStatus::Filed,
            filed_at: now,
            evidence_deadline: now + EVIDENCE_PHASE,
            voting_deadline: now + EVIDENCE_PHASE + VOTING_PHASE,
            appeal_deadline: now + EVIDENCE_PHASE + VOTING_PHASE + APPEAL_WINDOW,
            jurors: selected_jurors,
            appealed: false,
            resolution: None,
            bond_amount: 0,
        };

        let key = DataKey::Dispute(dispute_id.clone());
        env.storage().persistent().set(&key, &dispute);

        env.events().publish(
            (symbol_short!("dispute"), symbol_short!("filed")),
            DisputeFiledEvent {
                dispute_id: dispute_id.clone(),
                filer,
                agent_id,
            },
        );

        Ok(())
    }

    /// Submit evidence to a dispute.
    pub fn submit_evidence(
        env: Env,
        dispute_id: Symbol,
        submitter: Address,
        evidence_hash: BytesN<32>,
    ) -> Result<(), Error> {
        require_not_paused(&env)?;
        submitter.require_auth();

        let key = DataKey::Dispute(dispute_id.clone());
        let mut dispute: Dispute = env
            .storage()
            .persistent()
            .get(&key)
            .ok_or(Error::NotFound)?;

        let now = env.ledger().timestamp();
        if now > dispute.evidence_deadline {
            return Err(Error::DisputeExpired);
        }

        let evidence_count_key = DataKey::Evidence(dispute_id.clone(), 0);
        let evidence_count: u32 = env
            .storage()
            .persistent()
            .get(&evidence_count_key)
            .unwrap_or(0);

        let evidence = Evidence {
            dispute_id: dispute_id.clone(),
            submitter: submitter.clone(),
            evidence_hash,
            submitted_at: now,
        };

        let ev_key = DataKey::Evidence(dispute_id.clone(), evidence_count);
        env.storage().persistent().set(&ev_key, &evidence);
        env.storage()
            .persistent()
            .set(&evidence_count_key, &(evidence_count + 1));

        // Move to evidence submission phase if still in filed status
        if dispute.status == DisputeStatus::Filed {
            dispute.status = DisputeStatus::EvidenceSubmission;
            env.storage().persistent().set(&key, &dispute);
        }

        env.events().publish(
            (symbol_short!("dispute"), symbol_short!("evidence")),
            EvidenceSubmittedEvent {
                dispute_id,
                submitter,
            },
        );

        Ok(())
    }

    /// Juror casts a vote on a dispute.
    pub fn cast_vote(
        env: Env,
        dispute_id: Symbol,
        juror: Address,
        side: VoteSide,
    ) -> Result<(), Error> {
        juror.require_auth();

        let key = DataKey::Dispute(dispute_id.clone());
        let mut dispute: Dispute = env
            .storage()
            .persistent()
            .get(&key)
            .ok_or(Error::NotFound)?;

        let now = env.ledger().timestamp();
        if now > dispute.voting_deadline {
            return Err(Error::DisputeExpired);
        }

        if dispute.status == DisputeStatus::Resolved {
            return Err(Error::DisputeAlreadyResolved);
        }

        // Verify juror is assigned
        if !dispute.jurors.contains(&juror) {
            return Err(Error::NotJuror);
        }

        // Check if already voted
        let vote_key = DataKey::JurorVote(dispute_id.clone(), juror.clone());
        if env.storage().persistent().has(&vote_key) {
            return Err(Error::JurorAlreadyVoted);
        }

        let vote = JurorVote {
            dispute_id: dispute_id.clone(),
            juror: juror.clone(),
            side: side.clone(),
            voted_at: now,
        };
        env.storage().persistent().set(&vote_key, &vote);

        // Move to voting phase if in evidence submission
        if dispute.status == DisputeStatus::EvidenceSubmission
            || dispute.status == DisputeStatus::Filed
        {
            dispute.status = DisputeStatus::Voting;
            env.storage().persistent().set(&key, &dispute);
        }

        Ok(())
    }

    /// Resolve a dispute after voting period ends (admin or automated).
    pub fn resolve_dispute(
        env: Env,
        dispute_id: Symbol,
    ) -> Result<(), Error> {
        let key = DataKey::Dispute(dispute_id.clone());
        let mut dispute: Dispute = env
            .storage()
            .persistent()
            .get(&key)
            .ok_or(Error::NotFound)?;

        if dispute.status == DisputeStatus::Resolved {
            return Err(Error::DisputeAlreadyResolved);
        }

        let now = env.ledger().timestamp();
        if now <= dispute.voting_deadline {
            return Err(Error::DisputeExpired);
        }

        // Count votes
        let mut client_votes = 0u32;
        let mut agent_votes = 0u32;

        for juror in dispute.jurors.iter() {
            let vote_key = DataKey::JurorVote(dispute_id.clone(), juror);
            if let Some(vote) = env
                .storage()
                .persistent()
                .get::<_, JurorVote>(&vote_key)
            {
                match vote.side {
                    VoteSide::Client => client_votes += 1,
                    VoteSide::Agent => agent_votes += 1,
                }
            }
        }

        let resolution = if client_votes > agent_votes { 0 } else { 1 };

        dispute.status = DisputeStatus::Resolved;
        dispute.resolution = Some(resolution);
        env.storage().persistent().set(&key, &dispute);

        env.events().publish(
            (symbol_short!("dispute"), symbol_short!("resolved")),
            DisputeResolvedEvent {
                dispute_id,
                resolution,
                bond_amount: dispute.bond_amount,
            },
        );

        Ok(())
    }

    /// Appeal a resolved dispute (must be within appeal window).
    pub fn appeal_dispute(
        env: Env,
        dispute_id: Symbol,
        appellant: Address,
    ) -> Result<(), Error> {
        appellant.require_auth();

        let key = DataKey::Dispute(dispute_id.clone());
        let mut dispute: Dispute = env
            .storage()
            .persistent()
            .get(&key)
            .ok_or(Error::NotFound)?;

        if dispute.status != DisputeStatus::Resolved {
            return Err(Error::DisputeAlreadyResolved);
        }

        let now = env.ledger().timestamp();
        if now > dispute.appeal_deadline {
            return Err(Error::AppealWindowClosed);
        }

        if dispute.appealed {
            return Err(Error::AlreadyExists);
        }

        dispute.appealed = true;
        dispute.status = DisputeStatus::Appealed;
        env.storage().persistent().set(&key, &dispute);

        env.events().publish(
            (symbol_short!("dispute"), symbol_short!("appealed")),
            DisputeAppealedEvent {
                dispute_id,
                appellant,
            },
        );

        Ok(())
    }

    /// Get a dispute by ID.
    pub fn get_dispute(env: Env, dispute_id: Symbol) -> Option<Dispute> {
        env.storage()
            .persistent()
            .get(&DataKey::Dispute(dispute_id))
    }

    /// Get evidence count for a dispute.
    pub fn get_evidence_count(env: Env, dispute_id: Symbol) -> u32 {
        let count_key = DataKey::Evidence(dispute_id, 0);
        env.storage()
            .persistent()
            .get(&count_key)
            .unwrap_or(0)
    }
}

#[cfg(test)]
mod test;
