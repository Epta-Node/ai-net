//! # Error Types for Agent Marketplace

use soroban_sdk::contracterror;

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum Error {
    NotFound = 1,
    Unauthorized = 2,
    AlreadyExists = 3,
    ContractPaused = 4,
    InvalidPrice = 5,
    InsufficientPayment = 6,
    BookingNotFound = 7,
    BookingAlreadyCompleted = 8,
    BookingAlreadyCancelled = 9,
    SlaViolation = 10,
    NotOwner = 11,
    ServiceNotAvailable = 12,
}

impl Error {
    pub fn from_code(code: u32) -> Option<Self> {
        match code {
            1 => Some(Error::NotFound),
            2 => Some(Error::Unauthorized),
            3 => Some(Error::AlreadyExists),
            4 => Some(Error::ContractPaused),
            5 => Some(Error::InvalidPrice),
            6 => Some(Error::InsufficientPayment),
            7 => Some(Error::BookingNotFound),
            8 => Some(Error::BookingAlreadyCompleted),
            9 => Some(Error::BookingAlreadyCancelled),
            10 => Some(Error::SlaViolation),
            11 => Some(Error::NotOwner),
            12 => Some(Error::ServiceNotAvailable),
            _ => None,
        }
    }
}
