//! # Error Types for Dispute Resolution

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
    JurorAlreadyVoted = 7,
    NotJuror = 8,
    InvalidVote = 9,
    AppealWindowClosed = 10,
    NoJurorsAvailable = 11,
    InvalidEvidence = 12,
}

impl Error {
    pub fn from_code(code: u32) -> Option<Self> {
        match code {
            1 => Some(Error::NotFound),
            2 => Some(Error::Unauthorized),
            3 => Some(Error::AlreadyExists),
            4 => Some(Error::ContractPaused),
            5 => Some(Error::DisputeAlreadyResolved),
            6 => Some(Error::DisputeExpired),
            7 => Some(Error::JurorAlreadyVoted),
            8 => Some(Error::NotJuror),
            9 => Some(Error::InvalidVote),
            10 => Some(Error::AppealWindowClosed),
            11 => Some(Error::NoJurorsAvailable),
            12 => Some(Error::InvalidEvidence),
            _ => None,
        }
    }
}
