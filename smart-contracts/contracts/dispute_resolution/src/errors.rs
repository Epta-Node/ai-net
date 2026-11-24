//! Errors returned by the dispute-resolution contract.

use soroban_sdk::contracterror;

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum Error {
    NotFound = 1,
    Unauthorized = 2,
    AlreadyExists = 3,
    ContractPaused = 4,
    DisputeAlreadyResolved = 5,
    DisputeExpired = 6,
    AlreadyVoted = 7,
    NotEligibleVoter = 8,
    InvalidPhase = 9,
    NoVotersAvailable = 10,
    InvalidReason = 11,
    InvalidReputation = 12,
    InvalidAmount = 13,
    InvalidVoterPool = 14,
    EvidenceLimitReached = 15,
    AppealExpired = 16,
    AppealAlreadyFiled = 17,
    /// `resolve` was called while the voting window is still open.
    VotingStillOpen = 18,
    /// `appeal_dispute` was called on a dispute that has no ruling to appeal.
    NotResolved = 19,
}

impl Error {
    pub fn from_code(code: u32) -> Option<Self> {
        match code {
            1 => Some(Self::NotFound),
            2 => Some(Self::Unauthorized),
            3 => Some(Self::AlreadyExists),
            4 => Some(Self::ContractPaused),
            5 => Some(Self::DisputeAlreadyResolved),
            6 => Some(Self::DisputeExpired),
            7 => Some(Self::AlreadyVoted),
            8 => Some(Self::NotEligibleVoter),
            9 => Some(Self::InvalidPhase),
            10 => Some(Self::NoVotersAvailable),
            11 => Some(Self::InvalidReason),
            12 => Some(Self::InvalidReputation),
            13 => Some(Self::InvalidAmount),
            14 => Some(Self::InvalidVoterPool),
            15 => Some(Self::EvidenceLimitReached),
            16 => Some(Self::AppealExpired),
            17 => Some(Self::AppealAlreadyFiled),
            18 => Some(Self::VotingStillOpen),
            19 => Some(Self::NotResolved),
            _ => None,
        }
    }
}
