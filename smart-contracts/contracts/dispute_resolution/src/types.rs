//! Contract data types for the multi-phase dispute process.

use soroban_sdk::{contracttype, Address, BytesN, String, Symbol, Vec};

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
#[repr(u32)]
pub enum DisputeStatus {
    Filed = 0,
    EvidencePhase = 1,
    Voting = 2,
    Resolved = 3,
    AppealPending = 4,
}

/// The two non-neutral voting rulings.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
#[repr(u32)]
pub enum VoteSide {
    SupportFiler = 0,
    SupportAgent = 1,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
#[repr(u32)]
pub enum DisputeOutcome {
    SupportFiler = 0,
    SupportAgent = 1,
    Tie = 2,
}

impl DisputeOutcome {
    pub fn code(&self) -> u32 {
        match self {
            Self::SupportFiler => 0,
            Self::SupportAgent => 1,
            Self::Tie => 2,
        }
    }
}

/// Persistent record keyed by `task_id`, which is also the dispute ID.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Dispute {
    pub task_id: Symbol,
    pub filer: Address,
    pub agent_id: Address,
    pub registry_address: Address,
    pub registry_agent_id: Symbol,
    pub reason: String,
    pub status: DisputeStatus,
    pub filed_at: u64,
    pub evidence_deadline: u64,
    pub voting_deadline: u64,
    /// Bounded snapshot of the registered voter pool at filing time.
    pub voters: Vec<Address>,
    /// 0 = support filer, 1 = support agent, 2 = tie / insufficient votes.
    pub resolution: Option<u32>,
    pub appeal_deadline: Option<u64>,
    pub appealed: bool,
    pub filer_votes: u32,
    pub agent_votes: u32,
    pub bond_slashed: i128,
    pub filer_refund: i128,
    pub agent_payment: i128,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Evidence {
    pub dispute_id: Symbol,
    pub evidence_id: u32,
    pub submitter: Address,
    pub evidence_hash: BytesN<32>,
    pub submitted_at: u64,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Vote {
    pub dispute_id: Symbol,
    pub voter: Address,
    pub ruling: VoteSide,
    pub voted_at: u64,
}

#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct DisputeFiledEvent {
    pub dispute_id: Symbol,
    pub filer: Address,
    pub agent_id: Address,
}

#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct EvidenceSubmittedEvent {
    pub dispute_id: Symbol,
    pub evidence_id: u32,
    pub submitter: Address,
    /// IPFS hash of the submitted evidence document.
    pub evidence_hash: BytesN<32>,
    /// Ledger timestamp of the submission.
    pub submitted_at: u64,
    /// 0-based index of this evidence item within the dispute.
    pub evidence_index: u32,
}

/// Event: JurorsSet (issue #486)
///
/// Emitted after the admin replaces the active juror pool.
#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct JurorsSetEvent {
    /// The new active juror pool.
    pub jurors: Vec<Address>,
    /// Ledger timestamp at which the pool was written.
    pub set_at: u64,
}

/// Event: VoteCast (issue #486)
///
/// Emitted after a juror's vote is persisted, so indexers can reconstruct
/// per-dispute tallies without reading every `JurorVote` record.
#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct VoteCastEvent {
    pub dispute_id: Symbol,
    pub voter: Address,
    pub ruling: VoteSide,
}

#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct DisputeResolvedEvent {
    pub dispute_id: Symbol,
    pub outcome: DisputeOutcome,
    pub filer_votes: u32,
    pub agent_votes: u32,
    pub filer_refund: i128,
    pub agent_payment: i128,
    pub bond_slashed: i128,
}

/// Event: AdminChanged
#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct AdminChangedEvent {
    pub old_admin: Address,
    pub new_admin: Address,
}
