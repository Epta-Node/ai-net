//! # Data Types for Dispute Resolution

use soroban_sdk::{contracttype, Address, BytesN, Symbol, Vec};

/// Dispute status lifecycle.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
#[repr(u32)]
pub enum DisputeStatus {
    Filed = 0,
    EvidenceSubmission = 1,
    Voting = 2,
    Resolved = 3,
    Appealed = 4,
}

/// Side a juror can vote for.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
#[repr(u32)]
pub enum VoteSide {
    Client = 0,
    Agent = 1,
}

/// On-chain representation of a dispute.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Dispute {
    /// Unique dispute identifier.
    pub dispute_id: Symbol,
    /// Client who filed the dispute.
    pub filer: Address,
    /// Agent being disputed against.
    pub agent_id: Symbol,
    /// Current dispute status.
    pub status: DisputeStatus,
    /// Timestamp when dispute was filed.
    pub filed_at: u64,
    /// Deadline for evidence submission (filed_at + 3 days).
    pub evidence_deadline: u64,
    /// Deadline for voting (evidence_deadline + 2 days).
    pub voting_deadline: u64,
    /// Deadline for appeals (voting_deadline + 2 days).
    pub appeal_deadline: u64,
    /// Selected juror addresses.
    pub jurors: Vec<Address>,
    /// Whether dispute has been appealed.
    pub appealed: bool,
    /// Resolution outcome: 0 = client wins, 1 = agent wins.
    pub resolution: Option<u32>,
    /// Bond amount slashed or awarded.
    pub bond_amount: i128,
}

/// Evidence submitted to a dispute.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Evidence {
    /// Dispute this evidence belongs to.
    pub dispute_id: Symbol,
    /// Submitter address.
    pub submitter: Address,
    /// IPFS hash of evidence document.
    pub evidence_hash: BytesN<32>,
    /// Timestamp of submission.
    pub submitted_at: u64,
}

/// Juror vote record.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct JurorVote {
    /// Dispute being voted on.
    pub dispute_id: Symbol,
    /// Juror who cast the vote.
    pub juror: Address,
    /// Side voted for.
    pub side: VoteSide,
    /// Timestamp of vote.
    pub voted_at: u64,
}

/// Event: DisputeFiled
#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct DisputeFiledEvent {
    pub dispute_id: Symbol,
    pub filer: Address,
    pub agent_id: Symbol,
}

/// Event: EvidenceSubmitted
#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct EvidenceSubmittedEvent {
    pub dispute_id: Symbol,
    pub submitter: Address,
}

/// Event: DisputeResolved
#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct DisputeResolvedEvent {
    pub dispute_id: Symbol,
    pub resolution: u32,
    pub bond_amount: i128,
}

/// Event: DisputeAppealed
#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct DisputeAppealedEvent {
    pub dispute_id: Symbol,
    pub appellant: Address,
}
